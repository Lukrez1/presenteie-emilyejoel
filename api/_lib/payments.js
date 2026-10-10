// Lógica compartilhada das funções de pagamento (roda só no servidor: Vercel ou middleware do Vite em dev).
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const QUOTA_THRESHOLD = 300;
const HOLD_MINUTES = 30;
const MP_API = 'https://api.mercadopago.com';

export function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function feeConfig() {
  return {
    pixFeePercent: Number(env('PIX_FEE_PERCENT', '0.99')),
    cardFeePercent: Number(env('CARD_FEE_PERCENT', '4.98')),
    maxInstallments: Number(env('CARD_MAX_INSTALLMENTS', '12')),
    enabled: Boolean(env('MP_ACCESS_TOKEN')),
  };
}

// O convidado paga a taxa: cobramos um valor que, descontada a taxa, deixa exatamente `net` para o casal.
export function grossUp(net, feePercent) {
  const charged = Math.ceil((net / (1 - feePercent / 100)) * 100) / 100;
  return { net: round2(net), fee: round2(charged - net), charged };
}

export const round2 = n => Math.round(n * 100) / 100;

export function db() {
  const url = env('SUPABASE_URL', env('VITE_SUPABASE_URL'));
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function mp(path, { method = 'GET', body, idempotencyKey } = {}) {
  const token = env('MP_ACCESS_TOKEN');
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  const res = await fetch(`${MP_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `Mercado Pago respondeu ${res.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

export function isTestToken() {
  return String(env('MP_ACCESS_TOKEN', '')).startsWith('TEST-');
}

export function siteUrl(req) {
  const configured = env('PUBLIC_SITE_URL');
  if (configured) return configured.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

// Data no formato que o Mercado Pago aceita, no fuso de Brasília
export function mpDate(date) {
  return new Date(date.getTime() - 3 * 3600_000).toISOString().replace('Z', '-03:00');
}

export function holdUntil() {
  return new Date(Date.now() + HOLD_MINUTES * 60_000);
}

// Busca o pagamento no Mercado Pago e, se aprovado, confirma no banco. Retorna o status atualizado.
export async function syncPaymentStatus(supabase, payment) {
  if (payment.status !== 'pending') return payment.status;

  let mpPayment = null;
  if (payment.mp_payment_id) {
    mpPayment = await mp(`/v1/payments/${payment.mp_payment_id}`);
  } else {
    // Cartão (Checkout Pro): o id do pagamento só existe depois que o convidado paga
    const search = await mp(`/v1/payments/search?external_reference=${payment.id}&sort=date_created&criteria=desc`);
    mpPayment = search.results?.find(p => p.status === 'approved') || search.results?.[0] || null;
  }

  if (mpPayment?.status === 'approved') {
    if (Math.abs(Number(mpPayment.transaction_amount) - Number(payment.amount_charged)) > 0.01) {
      console.error('Valor pago diferente do esperado', payment.id, mpPayment.transaction_amount, payment.amount_charged);
      return 'pending';
    }
    const { error } = await supabase.rpc('confirm_payment', { p_payment_id: payment.id, p_mp_payment_id: String(mpPayment.id) });
    if (error) throw error;
    return 'approved';
  }

  // Pix recusado/cancelado/expirado é definitivo. No cartão o convidado pode tentar de novo no checkout.
  if (payment.method === 'pix' && mpPayment && ['rejected', 'cancelled'].includes(mpPayment.status)) {
    await supabase.from('payments').update({ status: mpPayment.status }).eq('id', payment.id).eq('status', 'pending');
    return mpPayment.status;
  }
  if (payment.hold_until && new Date(payment.hold_until) < new Date() && payment.method === 'pix') {
    await supabase.from('payments').update({ status: 'expired' }).eq('id', payment.id).eq('status', 'pending');
    return 'expired';
  }
  return 'pending';
}

// Validação da assinatura do webhook (https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks)
export function validWebhookSignature(req, dataId) {
  const secret = env('MP_WEBHOOK_SECRET');
  if (!secret) return true; // sem segredo configurado: ainda é seguro, porque sempre reconsultamos o pagamento na API
  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const parts = Object.fromEntries(signature.split(',').map(p => p.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sendError(res, status, message) {
  res.status(status).json({ error: message });
}
