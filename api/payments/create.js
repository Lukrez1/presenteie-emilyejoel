// POST /api/payments/create
// body: { giftId: number|null, amount?: number, method: 'pix'|'card', name, email, message? }
import {
  QUOTA_THRESHOLD, db, feeConfig, grossUp, holdUntil, isTestToken, mp, mpDate, sendError, siteUrl,
} from '../_lib/payments.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido');

  const fees = feeConfig();
  if (!fees.enabled) return sendError(res, 503, 'Pagamentos online ainda não estão ativos.');

  const { giftId = null, amount, method, name, email, message } = req.body || {};
  const payerName = String(name || '').trim().slice(0, 80);
  const payerEmail = String(email || '').trim().toLowerCase().slice(0, 120);
  if (!['pix', 'card'].includes(method)) return sendError(res, 400, 'Forma de pagamento inválida.');
  if (payerName.length < 2) return sendError(res, 400, 'Informe seu nome.');
  if (!EMAIL_RE.test(payerEmail)) return sendError(res, 400, 'Informe um e-mail válido.');

  const supabase = db();
  let gift = null;
  let kind = 'free';
  let net;

  if (giftId != null) {
    const { data, error } = await supabase.from('gifts').select('*').eq('id', giftId).single();
    if (error || !data) return sendError(res, 404, 'Presente não encontrado.');
    gift = data;

    if (gift.price > QUOTA_THRESHOLD) {
      kind = 'quota';
      const remaining = Number(gift.price) - Number(gift.contributed_amount || 0);
      net = Number(amount);
      if (!(net >= 10)) return sendError(res, 400, 'O valor mínimo é R$ 10,00.');
      if (net > remaining + 0.001) return sendError(res, 400, `Esse presente só precisa de mais R$ ${remaining.toFixed(2).replace('.', ',')}.`);
    } else {
      kind = 'gift';
      if (gift.status !== 'available' || gift.received) return sendError(res, 409, 'Esse presente já foi reservado por outra pessoa.');
      // Outra pessoa está pagando este presente agora?
      const { data: holds } = await supabase.from('payments').select('id')
        .eq('gift_id', gift.id).eq('status', 'pending').gt('hold_until', new Date().toISOString()).limit(1);
      if (holds?.length) return sendError(res, 409, 'Alguém está finalizando esse presente agora. Tente outro ou volte em alguns minutos.');
      net = Number(gift.price); // valor do presente vem do banco, nunca do navegador
    }
  } else {
    net = Number(amount);
    if (!(net >= 10)) return sendError(res, 400, 'O valor mínimo é R$ 10,00.');
    if (net > 20000) return sendError(res, 400, 'Para valores acima de R$ 20.000, fale com a gente.');
  }

  const { fee, charged } = grossUp(net, method === 'pix' ? fees.pixFeePercent : fees.cardFeePercent);
  const hold = holdUntil();
  const description = gift ? (kind === 'quota' ? `Parte do presente: ${gift.name}` : `Presente: ${gift.name}`) : 'Contribuição para a casa nova';

  const { data: payment, error: insertError } = await supabase.from('payments').insert({
    gift_id: gift?.id ?? null, kind, method,
    amount_net: net, fee_amount: fee, amount_charged: charged,
    payer_name: payerName, payer_email: payerEmail,
    message: message ? String(message).slice(0, 500) : null,
    hold_until: hold.toISOString(),
  }).select('*').single();
  if (insertError) return sendError(res, 500, 'Não foi possível iniciar o pagamento.');

  const base = siteUrl(req);
  const isPublicUrl = base.startsWith('https://');
  const notificationUrl = isPublicUrl ? `${base}/api/payments/webhook` : undefined;
  const [firstName, ...rest] = payerName.split(' ');

  try {
    if (method === 'pix') {
      const p = await mp('/v1/payments', {
        method: 'POST',
        idempotencyKey: payment.id,
        body: {
          transaction_amount: charged,
          description: description.slice(0, 250),
          payment_method_id: 'pix',
          external_reference: payment.id,
          date_of_expiration: mpDate(hold),
          notification_url: notificationUrl,
          payer: { email: payerEmail, first_name: firstName, last_name: rest.join(' ') || undefined },
        },
      });
      const tx = p.point_of_interaction?.transaction_data || {};
      await supabase.from('payments').update({
        mp_payment_id: String(p.id), pix_qr_code: tx.qr_code, pix_qr_base64: tx.qr_code_base64,
      }).eq('id', payment.id);

      return res.status(200).json({
        id: payment.id, method, net, fee, charged,
        pix: { qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64, expiresAt: hold.toISOString() },
      });
    }

    const pref = await mp('/checkout/preferences', {
      method: 'POST',
      idempotencyKey: payment.id,
      body: {
        items: [{ id: String(gift?.id ?? 'livre'), title: description.slice(0, 250), quantity: 1, unit_price: charged, currency_id: 'BRL' }],
        payer: { name: firstName, surname: rest.join(' ') || undefined, email: payerEmail },
        external_reference: payment.id,
        notification_url: notificationUrl,
        back_urls: {
          success: `${base}/?pagamento=${payment.id}`,
          pending: `${base}/?pagamento=${payment.id}`,
          failure: `${base}/?pagamento=${payment.id}`,
        },
        auto_return: isPublicUrl ? 'approved' : undefined,
        payment_methods: {
          // Só cartão: Pix é gerado direto no site; boleto demora dias para compensar
          excluded_payment_types: [{ id: 'ticket' }, { id: 'bank_transfer' }, { id: 'atm' }],
          installments: fees.maxInstallments,
        },
        statement_descriptor: 'EMILYEJOEL',
        expires: true,
        expiration_date_to: mpDate(hold),
      },
    });
    const checkoutUrl = isTestToken() ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
    await supabase.from('payments').update({ mp_preference_id: pref.id, checkout_url: checkoutUrl }).eq('id', payment.id);

    return res.status(200).json({ id: payment.id, method, net, fee, charged, checkoutUrl });
  } catch (err) {
    console.error('Erro Mercado Pago', err.message, JSON.stringify(err.details || {}));
    await supabase.from('payments').update({ status: 'cancelled' }).eq('id', payment.id);
    return sendError(res, 502, 'O Mercado Pago não respondeu como esperado. Tente novamente em instantes.');
  }
}
