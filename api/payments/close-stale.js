// GET /api/payments/close-stale  (cron diário do Vercel, ver vercel.json)
// Encerra pagamentos parados há mais de 24h. Antes de encerrar, sempre reconsulta o Mercado Pago.
//   expired  = abriu o checkout e não tentou pagar (aparece como "Encerrado" no admin)
//   rejected = tentou pagar e todas as tentativas foram recusadas
import { db, env, mp, sendError, syncPaymentStatus } from '../_lib/payments.js';

const MAX_AGE_HOURS = 24;
const STILL_OPEN_STATUSES = ['approved', 'authorized', 'pending', 'in_process', 'in_mediation'];
// Panelas Turim (31/10): não encerrar, o convidado ainda vai ser contatado
const KEEP_OPEN = ['d2978f27-6910-41a5-9d67-82fc16d04501'];

export default async function handler(req, res) {
  const secret = env('CRON_SECRET');
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return sendError(res, 401, 'Não autorizado');

  const supabase = db();
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600_000).toISOString();
  const { data: stale, error } = await supabase.from('payments').select('*').eq('status', 'pending').lt('created_at', cutoff);
  if (error) return sendError(res, 500, 'Erro ao buscar pagamentos pendentes');

  const result = { confirmed: 0, closed: 0, rejected: 0, skipped: 0, failed: 0 };
  for (const payment of stale) {
    if (KEEP_OPEN.includes(payment.id)) { result.skipped++; continue; }
    try {
      const status = await syncPaymentStatus(supabase, payment);
      if (status === 'approved') { result.confirmed++; continue; }
      if (status !== 'pending') { result.closed++; continue; }

      const search = await mp(`/v1/payments/search?external_reference=${payment.id}`);
      const attempts = search.results || [];
      if (attempts.some(p => STILL_OPEN_STATUSES.includes(p.status))) { result.skipped++; continue; }

      const finalStatus = attempts.length ? 'rejected' : 'expired';
      const { error: updateError } = await supabase.from('payments').update({ status: finalStatus }).eq('id', payment.id).eq('status', 'pending');
      if (updateError) throw updateError;
      result[finalStatus === 'rejected' ? 'rejected' : 'closed']++;
    } catch (err) {
      console.error('Erro ao encerrar pagamento', payment.id, err.message);
      result.failed++;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(result.failed ? 500 : 200).json(result);
}
