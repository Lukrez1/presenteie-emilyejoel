// POST /api/payments/webhook  (chamado pelo Mercado Pago)
// Nunca confiamos no conteúdo da notificação: reconsultamos o pagamento na API do Mercado Pago.
import { db, mp, sendError, syncPaymentStatus, validWebhookSignature } from '../_lib/payments.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método não permitido');

  const type = req.query?.type || req.query?.topic || req.body?.type;
  const dataId = req.query?.['data.id'] || req.body?.data?.id || req.query?.id;
  if (type !== 'payment' || !dataId) return res.status(200).json({ ignored: true });

  if (!validWebhookSignature(req, dataId)) return sendError(res, 401, 'Assinatura inválida');

  try {
    const mpPayment = await mp(`/v1/payments/${dataId}`);
    const paymentId = mpPayment.external_reference;
    if (!paymentId) return res.status(200).json({ ignored: true });

    const supabase = db();
    const { data: payment } = await supabase.from('payments').select('*').eq('id', paymentId).single();
    if (!payment) return res.status(200).json({ ignored: true });

    if (!payment.mp_payment_id) {
      await supabase.from('payments').update({ mp_payment_id: String(mpPayment.id) }).eq('id', payment.id);
      payment.mp_payment_id = String(mpPayment.id);
    }
    const status = await syncPaymentStatus(supabase, payment);
    return res.status(200).json({ ok: true, status });
  } catch (err) {
    console.error('Erro no webhook', dataId, err.message);
    // 500 faz o Mercado Pago tentar de novo mais tarde
    return sendError(res, 500, 'Erro ao processar');
  }
}
