import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X, Copy, Check, CreditCard, QrCode, Loader2, ShieldCheck } from 'lucide-react';
import type { Gift } from './types';

export interface PaymentConfig {
  enabled: boolean;
  pixFeePercent: number;
  cardFeePercent: number;
  maxInstallments: number;
}

type Method = 'pix' | 'card';
type Step = 'form' | 'pix' | 'redirecting' | 'checking' | 'success' | 'failed';

interface PixData { qrCode: string; qrCodeBase64: string; expiresAt: string }

const QUOTA_THRESHOLD = 300;
const AMOUNT_OPTIONS = [50, 100, 200, 300];

function formatBRL(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

// Mesmo cálculo do servidor (api/_lib/payments.js): o convidado paga a taxa
function grossUp(net: number, feePercent: number) {
  const charged = Math.ceil((net / (1 - feePercent / 100)) * 100) / 100;
  return { fee: Math.round((charged - net) * 100) / 100, charged };
}

function useCountdown(expiresAt?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return { left, label: `${m}:${String(s).padStart(2, '0')}` };
}

export function PaymentModal({
  target, config, resumePaymentId, onClose, onPaid, onWhatsapp,
}: {
  target: Gift | 'free' | null;           // null quando estamos retomando um pagamento (volta do cartão)
  config: PaymentConfig;
  resumePaymentId?: string | null;
  onClose: () => void;
  onPaid: () => void;
  onWhatsapp?: (gift: Gift) => void;      // alternativa: comprar e entregar pessoalmente
}) {
  const gift = target && target !== 'free' ? target : null;
  const isQuota = Boolean(gift && gift.price > QUOTA_THRESHOLD);
  const needsAmount = target === 'free' || isQuota;
  const remaining = gift ? gift.price - (gift.contributed_amount || 0) : Infinity;

  const [step, setStep] = useState<Step>(resumePaymentId ? 'checking' : 'form');
  const [amount, setAmount] = useState<number | null>(needsAmount ? null : gift?.price ?? null);
  const [customAmount, setCustomAmount] = useState('');
  const [method, setMethod] = useState<Method>('pix');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(resumePaymentId ?? null);
  const [pix, setPix] = useState<PixData | null>(null);
  const [charged, setCharged] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [giftName, setGiftName] = useState<string | null>(gift?.name ?? null);
  const [retryUrl, setRetryUrl] = useState<string | null>(null);
  const countdown = useCountdown(step === 'pix' ? pix?.expiresAt : undefined);
  const paidRef = useRef(false);

  // Fechar com Esc e travar o scroll da página
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  // Acompanha o status enquanto o convidado paga (Pix) ou quando volta do checkout do cartão
  useEffect(() => {
    if (!paymentId || !['pix', 'checking'].includes(step)) return;
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/payments/status?id=${paymentId}`);
        const data = await res.json();
        if (stop || !res.ok) return;
        if (data.giftName) setGiftName(data.giftName);
        if (data.charged) setCharged(data.charged);
        if (!name && data.payerName) setName(data.payerName);
        if (data.status === 'approved') {
          setStep('success');
          if (!paidRef.current) { paidRef.current = true; onPaid(); }
        } else if (data.status === 'pending' && step === 'checking') {
          if (data.pix) { setPix(data.pix); setStep('pix'); }
          else { setRetryUrl(data.checkoutUrl); }
        } else if (['rejected', 'cancelled', 'expired'].includes(data.status)) {
          setStep('failed');
        }
      } catch { /* tenta de novo no próximo ciclo */ }
    }
    poll();
    const t = window.setInterval(poll, 4000);
    return () => { stop = true; window.clearInterval(t); };
  }, [paymentId, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const net = amount ?? 0;
  const pixQuote = grossUp(net, config.pixFeePercent);
  const cardQuote = grossUp(net, config.cardFeePercent);
  const quote = method === 'pix' ? pixQuote : cardQuote;

  function pickAmount(v: number) {
    setAmount(v);
    setCustomAmount('');
    setError(null);
  }

  function onCustomAmount(v: string) {
    setCustomAmount(v);
    const n = Number(v.replace(',', '.'));
    setAmount(n > 0 ? n : null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount || amount < 10) return setError('O valor mínimo é R$ 10,00.');
    if (amount > remaining + 0.001) return setError(`Esse presente só precisa de mais ${formatBRL(remaining)}.`);
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ giftId: gift?.id ?? null, amount, method, name, email, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Não foi possível iniciar o pagamento.');
      setPaymentId(data.id);
      setCharged(data.charged);
      if (data.method === 'pix') {
        setPix(data.pix);
        setStep('pix');
      } else {
        setStep('redirecting');
        window.location.assign(data.checkoutUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado.');
    } finally {
      setSending(false);
    }
  }

  async function copyPixCode() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.qrCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Não foi possível copiar. Selecione o código abaixo e copie manualmente.');
    }
  }

  const title = step === 'success' ? 'Muito obrigado! 🤍'
    : target === 'free' ? 'Contribuir com um valor'
    : isQuota ? 'Faça parte deste presente'
    : resumePaymentId && !gift ? 'Seu pagamento'
    : 'Presentear';

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && step !== 'redirecting') onClose(); }}>
      <div className="modal-content pay-modal" role="dialog" aria-modal="true" aria-labelledby="pay-title">
        <button className="modal-close" onClick={onClose} aria-label="Fechar"><X /></button>
        <h2 id="pay-title">{title}</h2>

        {step !== 'success' && (gift || giftName) && (
          <div className="pay-gift">
            {gift?.image_url && <img src={gift.image_url} alt="" />}
            <div>
              <strong>{gift?.name ?? giftName}</strong>
              {gift && !isQuota && <span>{formatBRL(gift.price)}</span>}
              {gift && isQuota && <span>Faltam {formatBRL(remaining)}</span>}
            </div>
          </div>
        )}

        {step === 'form' && (
          <form className="pay-form" onSubmit={submit}>
            {needsAmount && (
              <fieldset className="pay-fieldset">
                <legend>Quanto você quer dar?</legend>
                <div className="modal-options">
                  {AMOUNT_OPTIONS.filter(v => v <= remaining).map(v => (
                    <button type="button" key={v} className={`modal-opt-btn ${amount === v && !customAmount ? 'active' : ''}`} onClick={() => pickAmount(v)}>{formatBRL(v)}</button>
                  ))}
                  {isQuota && remaining <= 1000 && !AMOUNT_OPTIONS.includes(remaining) && (
                    <button type="button" className={`modal-opt-btn ${amount === remaining && !customAmount ? 'active' : ''}`} onClick={() => pickAmount(Math.round(remaining * 100) / 100)}>Completar ({formatBRL(remaining)})</button>
                  )}
                </div>
                <div className="custom-input-wrap">
                  <span>R$</span>
                  <input aria-label="Outro valor" inputMode="decimal" placeholder="Outro valor" value={customAmount} onChange={e => onCustomAmount(e.target.value)} />
                </div>
              </fieldset>
            )}

            <div className="pay-fields">
              <label>Seu nome<input required minLength={2} autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Como os noivos te conhecem" /></label>
              <label>E-mail<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Para receber o comprovante" /></label>
              <label>Mensagem para os noivos <small>(opcional)</small><textarea rows={2} maxLength={500} value={message} onChange={e => setMessage(e.target.value)} placeholder="Deixe um recado carinhoso 🤍" /></label>
            </div>

            <fieldset className="pay-fieldset">
              <legend>Forma de pagamento</legend>
              <div className="pay-methods">
                <label className={`pay-method ${method === 'pix' ? 'active' : ''}`}>
                  <input type="radio" name="method" checked={method === 'pix'} onChange={() => setMethod('pix')} />
                  <QrCode aria-hidden="true" />
                  <span><strong>Pix</strong><small>Aprovação na hora</small></span>
                  {amount ? <em>{formatBRL(pixQuote.charged)}</em> : null}
                </label>
                <label className={`pay-method ${method === 'card' ? 'active' : ''}`}>
                  <input type="radio" name="method" checked={method === 'card'} onChange={() => setMethod('card')} />
                  <CreditCard aria-hidden="true" />
                  <span><strong>Cartão de crédito</strong><small>Em até {config.maxInstallments}x</small></span>
                  {amount ? <em>{formatBRL(cardQuote.charged)}</em> : null}
                </label>
              </div>
            </fieldset>

            {amount ? (
              <dl className="pay-summary">
                <div><dt>{target === 'free' ? 'Contribuição' : isQuota ? 'Sua parte' : 'Presente'}</dt><dd>{formatBRL(net)}</dd></div>
                <div><dt>Taxa do {method === 'pix' ? 'Pix' : 'cartão'} ({String(method === 'pix' ? config.pixFeePercent : config.cardFeePercent).replace('.', ',')}%)</dt><dd>{formatBRL(quote.fee)}</dd></div>
                <div className="total"><dt>Total</dt><dd>{formatBRL(quote.charged)}</dd></div>
                {method === 'card' && <p>Parcelamento sujeito a juros da operadora.</p>}
              </dl>
            ) : null}

            {error && <p className="modal-error" role="alert">{error}</p>}

            <button type="submit" className="modal-primary-btn" disabled={sending || !amount}>
              {sending ? <><Loader2 className="spin" size={18} aria-hidden="true" /> Gerando…</> : method === 'pix' ? 'Gerar Pix' : 'Pagar com cartão'}
            </button>
            <p className="pay-secure"><ShieldCheck size={14} aria-hidden="true" /> Pagamento processado com segurança pelo Mercado Pago</p>

            {gift && !isQuota && onWhatsapp && (
              <button type="button" className="link-btn pay-alt" onClick={() => onWhatsapp(gift)}>Prefiro comprar e entregar pessoalmente</button>
            )}
          </form>
        )}

        {step === 'pix' && pix && (
          <div className="pay-pix">
            <p className="modal-desc">Abra o app do seu banco, escolha <strong>Pix &gt; Ler QR code</strong> ou use o <strong>Pix Copia e Cola</strong>.</p>
            {pix.qrCodeBase64 && <img className="pix-qr" src={`data:image/png;base64,${pix.qrCodeBase64}`} alt="QR code do Pix" />}
            {charged && <p className="pix-amount">{formatBRL(charged)}</p>}
            <button className={`modal-primary-btn ${copied ? 'copied' : ''}`} onClick={copyPixCode}>
              {copied ? <><Check size={18} aria-hidden="true" /> Código copiado!</> : <><Copy size={18} aria-hidden="true" /> Copiar código Pix</>}
            </button>
            <textarea className="pix-code" readOnly value={pix.qrCode} aria-label="Código Pix copia e cola" onFocus={e => e.currentTarget.select()} />
            <p className="pix-waiting" aria-live="polite">
              <Loader2 className="spin" size={16} aria-hidden="true" /> Aguardando pagamento{countdown ? ` · expira em ${countdown.label}` : ''}
            </p>
            {error && <p className="modal-error" role="alert">{error}</p>}
          </div>
        )}

        {(step === 'redirecting' || step === 'checking') && (
          <div className="pay-center">
            <Loader2 className="spin" size={32} aria-hidden="true" />
            <p>{step === 'redirecting' ? 'Levando você para o pagamento seguro…' : 'Confirmando seu pagamento…'}</p>
            {step === 'checking' && retryUrl && (
              <>
                <p className="modal-desc">Ainda não recebemos a confirmação. Se o pagamento não foi concluído, você pode tentar de novo.</p>
                <a className="modal-primary-btn" href={retryUrl}>Tentar pagar novamente</a>
              </>
            )}
          </div>
        )}

        {step === 'success' && (
          <div className="pay-center pay-success">
            <div className="pay-check"><Check size={32} aria-hidden="true" /></div>
            <p><strong>{name ? `${name.split(' ')[0]}, seu` : 'Seu'} presente foi confirmado!</strong></p>
            <p className="modal-desc">{giftName ? `Recebemos seu carinho para “${giftName}”.` : 'Recebemos sua contribuição.'} Ele vai fazer parte da nossa casa nova. Obrigado de coração! 🤍</p>
            <p className="pay-sign">Emily &amp; Joel</p>
            <button className="modal-primary-btn" onClick={onClose}>Voltar para a lista</button>
          </div>
        )}

        {step === 'failed' && (
          <div className="pay-center">
            <p><strong>O pagamento não foi concluído.</strong></p>
            <p className="modal-desc">O Pix expirou ou o pagamento foi recusado. Nenhum valor foi cobrado.</p>
            {target ? <button className="modal-primary-btn" onClick={() => { setStep('form'); setPaymentId(null); setPix(null); }}>Tentar novamente</button>
              : <button className="modal-primary-btn" onClick={onClose}>Voltar para a lista</button>}
          </div>
        )}
      </div>
    </div>
  );
}
