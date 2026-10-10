// GET /api/payments/status?id=<uuid>  -> { status, kind, method, giftName, payerName, ... }
// Além de ler o banco, consulta o Mercado Pago se ainda estiver pendente
// (assim funciona mesmo se o webhook atrasar ou em localhost, onde o webhook não chega).
import { db, sendError, syncPaymentStatus } from '../_lib/payments.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function handler(req, res) {
  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return sendError(res, 400, 'Pagamento inválido.');

  const supabase = db();
  const { data: payment } = await supabase.from('payments').select('*, gift:gifts(name)').eq('id', id).single();
  if (!payment) return sendError(res, 404, 'Pagamento não encontrado.');

  let status = payment.status;
  try {
    status = await syncPaymentStatus(supabase, payment);
  } catch (err) {
    console.error('Erro ao consultar status', id, err.message);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    id, status,
    kind: payment.kind,
    method: payment.method,
    giftName: payment.gift?.name ?? null,
    payerName: payment.payer_name,
    charged: Number(payment.amount_charged),
    net: Number(payment.amount_net),
    pix: payment.method === 'pix' && status === 'pending'
      ? { qrCode: payment.pix_qr_code, qrCodeBase64: payment.pix_qr_base64, expiresAt: payment.hold_until }
      : null,
    checkoutUrl: payment.method === 'card' && status === 'pending' ? payment.checkout_url : null,
  });
}
