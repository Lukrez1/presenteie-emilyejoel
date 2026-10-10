import { useEffect, useMemo, useState } from 'react';
import { Search, Sparkles, X, ChevronDown, Copy, Check } from 'lucide-react';
import type { FormEvent } from 'react';
import { fallbackGifts } from './data/gifts';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import type { Gift, ReservationRequest, GiftContribution } from './types';
import { PaymentModal } from './PaymentModal';
import type { PaymentConfig } from './PaymentModal';

const PRODUCT_IMAGE = 'https://images.unsplash.com/photo-1549465220-1a8b9238cd48?auto=format&fit=crop&w=800&q=80';
const DEFAULT_DESCRIPTION = 'Para o nosso novo lar com muito carinho.';
const QUOTA_THRESHOLD = 300;
const PIX_KEY = '093.533.693-12';

type PriceFilter = 'all' | 'upto200' | '200to500' | 'over500';
type SortType = 'suggested' | 'price-asc' | 'price-desc';

const PRICE_FILTERS: { id: PriceFilter; label: string }[] = [
  { id: 'all', label: 'Qualquer valor' },
  { id: 'upto200', label: 'Até R$ 200' },
  { id: '200to500', label: 'R$ 200 a 500' },
  { id: 'over500', label: 'Acima de R$ 500' },
];

function isUnavailable(gift: Gift) {
  if (gift.price > QUOTA_THRESHOLD) return (gift.contributed_amount || 0) >= gift.price;
  return gift.status !== 'available' || gift.received;
}

const CATEGORY_LABELS: Record<string, string> = { Eletrodomesticos: 'Eletrodomésticos' };
const categoryLabel = (c: string) => CATEGORY_LABELS[c] || c;

function normalizeText(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function formatBRL(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function whatsappUrl(gift: Gift, requestCode?: string) {
  const number = (import.meta.env.VITE_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  const price = gift.price > 0 ? ` — ${formatBRL(gift.price)}` : '';
  const qty = gift.quantity > 1 ? ` (${gift.quantity} unidades)` : '';
  const code = requestCode ? `\n\nPedido: *#${requestCode}*` : '';
  const message = `Oi, Emily e Joel! 🤍\n\nEscolhi presentear vocês com *${gift.name}*${qty}${price}.${code}\n\nPodem confirmar essa reserva pra mim?`;
  const base = number ? `https://wa.me/${number}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}

function whatsappContributionUrl(giftName: string | null, amount: number, requestCode: string) {
  const number = (import.meta.env.VITE_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  let message = `Oi, Emily e Joel! 🤍\n\nQuero contribuir com ${formatBRL(amount)}`;
  if (giftName) {
    message += ` para o presente *${giftName}*.\n\nCódigo da contribuição: *${requestCode}*`;
  } else {
    message += ` para a nova fase da casa de vocês.\n\nCódigo da contribuição: *${requestCode}*`;
  }
  const base = number ? `https://wa.me/${number}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}

function isProductPhoto(url?: string | null) {
  return Boolean(url && url.includes('/produtos/'));
}

// Obs.: o redimensionamento do Supabase (/render/image) não está habilitado no plano atual,
// então usamos a URL pública direta. As fotos dos produtos já sobem otimizadas (~600px).
function getOptimizedImageUrl(url?: string | null) {
  return url || PRODUCT_IMAGE;
}

function GiftImage({ gift, index, badge }: { gift: Gift; index?: number; badge?: string }) {
  const product = isProductPhoto(gift.image_url);
  return (
    <div className={`gift-image-wrap ${product ? 'is-product' : ''}`}>
      <img className="gift-image" src={getOptimizedImageUrl(gift.image_url)} alt={gift.name} loading={index !== undefined && index < 4 ? 'eager' : 'lazy'} decoding="async" />
      {gift.category && <span className="gift-category">{categoryLabel(gift.category)}</span>}
      {badge && <span className="gift-badge">{badge}</span>}
    </div>
  );
}

function GiftCard({ gift, index, onRequest, onContribute }: { gift: Gift; index?: number; onRequest: (gift: Gift) => Promise<void>, onContribute: (gift: Gift | 'free') => void }) {
  const [sending, setSending] = useState(false);
  const description = gift.description && gift.description !== DEFAULT_DESCRIPTION ? gift.description : null;

  if (gift.price > QUOTA_THRESHOLD) {
    const total = gift.price;
    const confirmed = gift.contributed_amount || 0;
    const percent = Math.min(100, Math.floor((confirmed / total) * 100));
    const isComplete = confirmed >= total;

    return (
      <article className={`gift-card collective-card ${isComplete ? 'is-complete' : ''}`}>
        <GiftImage gift={gift} index={index} badge={isComplete ? 'Completo 🤍' : undefined} />
        <div className="gift-body">
          <h3 title={gift.name}>{gift.name}</h3>
          {description && <p>{description}</p>}

          <div className="collective-stats">
            <strong>{formatBRL(total)}</strong>
            <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${percent}% arrecadado`}>
              <div className="progress-fill" style={{ width: `${percent}%` }}></div>
            </div>
            <div className="collective-bottom">
              <span>{percent}% arrecadado</span>
              {!isComplete && <span>faltam {formatBRL(total - confirmed)}</span>}
            </div>
          </div>

          <button className="gift-button" onClick={() => onContribute(gift)} disabled={isComplete}>
            {isComplete ? 'Presente completo' : 'Contribuir com uma parte'}
          </button>
        </div>
      </article>
    );
  }

  // Single gift
  const reserved = gift.status !== 'available' || gift.received;
  async function handleClick() {
    if (sending || reserved) return;
    setSending(true);
    try {
      await onRequest(gift);
    } finally {
      setSending(false);
    }
  }

  return (
    <article className={`gift-card ${reserved ? 'is-reserved' : ''}`}>
      <GiftImage gift={gift} index={index} badge={reserved ? 'Reservado' : undefined} />
      <div className="gift-body">
        <h3 title={gift.name}>{gift.name}</h3>
        {description && <p>{description}</p>}
        <strong className="gift-price">{formatBRL(gift.price)}</strong>
        <button className="gift-button" onClick={handleClick} disabled={reserved || sending}>
          {reserved ? 'Já reservado 🤍' : sending ? 'Abrindo WhatsApp…' : 'Quero presentear'}
        </button>
      </div>
    </article>
  );
}

function ContributionModal({ 
  gift, 
  onClose, 
  onConfirm 
}: { 
  gift: Gift | 'free'; 
  onClose: () => void; 
  onConfirm: (amount: number, giftId: number | null) => Promise<void> 
}) {
  const [customValue, setCustomValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFree = gift === 'free';
  const alreadyContributed = isFree ? 0 : (gift.contributed_amount || gift.confirmed_contributions_total || 0);
  const remaining = isFree ? Infinity : (gift.price - alreadyContributed);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  const title = isFree ? "Prefere contribuir de outra forma?" : "Faça parte deste presente 🤍";
  const desc = isFree 
    ? "Escolha o valor que quiser para nos ajudar a construir nossa casa nova."
    : "Escolha quanto você gostaria de contribuir. Cada pedacinho nos ajuda a construir essa nova fase.";

  const options = [50, 100, 200, 300].filter(v => v <= remaining);

  async function handleConfirm(amount: number) {
    if (amount <= 0 || amount > remaining) {
      setError(isFree ? 'Valor inválido.' : 'O valor não pode ultrapassar o restante do presente.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onConfirm(amount, isFree ? null : gift.id!);
    } catch (err: any) {
      setError(err.message || 'Erro ao criar contribuição.');
      setSending(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="contrib-title">
        <button className="modal-close" onClick={onClose} aria-label="Fechar"><X /></button>
        <h2 id="contrib-title">{title}</h2>
        {!isFree && <p className="modal-gift-name">{gift.name}</p>}
        <p className="modal-desc">{desc}</p>

        {!isFree && (
          <div className="modal-stats">
            <div><span>Já contribuíram</span><strong>{formatBRL(alreadyContributed)}</strong></div>
            <div><span>Faltam</span><strong>{formatBRL(remaining)}</strong></div>
          </div>
        )}

        <div className="modal-options">
          {options.map(val => (
            <button key={val} className="modal-opt-btn" onClick={() => handleConfirm(val)} disabled={sending}>
              {formatBRL(val)}
            </button>
          ))}
        </div>

        <div className="modal-custom">
          <label htmlFor="contrib-custom">Outro valor</label>
          <div className="custom-input-wrap">
            <span>R$</span>
            <input
              id="contrib-custom"
              type="number"
              inputMode="decimal"
              min="1"
              placeholder="0,00"
              value={customValue} 
              onChange={e => setCustomValue(e.target.value)} 
              disabled={sending}
            />
          </div>
          {error && <p className="modal-error">{error}</p>}
          <button 
            className="modal-primary-btn" 
            onClick={() => handleConfirm(Number(customValue))} 
            disabled={sending || !customValue || Number(customValue) <= 0 || Number(customValue) > remaining}
          >
            {sending ? 'Aguarde...' : 'Continuar pelo WhatsApp'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditGiftModal({ gift, onClose, onSave }: { gift: Partial<Gift>, onClose: () => void, onSave: (updated: Partial<Gift>) => Promise<void> }) {
  const [name, setName] = useState(gift.name || '');
  const [description, setDescription] = useState(gift.description || '');
  const [price, setPrice] = useState((gift.price || 0).toString());
  const [category, setCategory] = useState(gift.category || 'Outros');
  const [notes, setNotes] = useState(gift.notes || '');
  const [imageUrl, setImageUrl] = useState(gift.image_url || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(gift.id);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name,
        description,
        price: parseFloat(price) || 0,
        category,
        notes: notes || null,
        image_url: imageUrl || null
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Erro ao salvar o presente.');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" style={{ maxWidth: '500px', textAlign: 'left' }}>
        <button className="modal-close" onClick={onClose} type="button"><X /></button>
        <h2 style={{ marginBottom: '16px' }}>{isEditing ? 'Editar Presente' : 'Adicionar Presente'}</h2>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>Nome</strong>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>Categoria</strong>
            <input type="text" value={category} onChange={e => setCategory(e.target.value)} required style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>Descrição</strong>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>Preço (R$)</strong>
            <input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} required style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>URL da Loja</strong>
            <input type="url" value={notes} onChange={e => setNotes(e.target.value)} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.9rem' }}>
            <strong>URL da Imagem</strong>
            <input type="url" value={imageUrl} onChange={e => setImageUrl(e.target.value)} style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit' }} />
          </label>
          {error && <p className="modal-error">{error}</p>}
          <button type="submit" disabled={saving} className="modal-primary-btn" style={{ marginTop: '16px' }}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </form>
      </div>
    </div>
  );
}

function PublicPage() {
  const [gifts, setGifts] = useState<Gift[]>(fallbackGifts);
  const [loading, setLoading] = useState(hasSupabaseConfig);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<SortType>('suggested');
  const [activeModal, setActiveModal] = useState<Gift | 'free' | null>(null);
  const [pixCopied, setPixCopied] = useState(false);
  const [payConfig, setPayConfig] = useState<PaymentConfig | null>(null);
  const [checkout, setCheckout] = useState<{ target: Gift | 'free' | null; resumeId?: string } | null>(() => {
    const id = new URLSearchParams(window.location.search).get('pagamento');
    return id ? { target: null, resumeId: id } : null;
  });
  const paymentsOn = Boolean(payConfig?.enabled);

  useEffect(() => {
    fetch('/api/payments/config', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(setPayConfig).catch(() => setPayConfig(null));
  }, []);

  function closeCheckout() {
    setCheckout(null);
    if (window.location.search.includes('pagamento=')) window.history.replaceState(null, '', window.location.pathname);
  }

  // Com pagamento online ativo, os botões abrem o checkout; sem ele, mantém o fluxo antigo pelo WhatsApp
  async function onGiftClick(gift: Gift) {
    if (paymentsOn) setCheckout({ target: gift });
    else await requestGift(gift);
  }

  function onContributeClick(target: Gift | 'free') {
    if (paymentsOn) setCheckout({ target });
    else setActiveModal(target);
  }

  async function copyPix() {
    try {
      await navigator.clipboard.writeText(PIX_KEY.replace(/\D/g, ''));
      setPixCopied(true);
      setTimeout(() => setPixCopied(false), 2500);
    } catch {
      setNotice(`Não foi possível copiar automaticamente. A chave é ${PIX_KEY}`);
    }
  }

  async function loadGifts() {
    if (!supabase) return;
    
    const { data: giftsData, error: giftsError } = await supabase.from('gifts').select('*').order('sort_order', { ascending: true });
    
    if (giftsData) {
      setGifts(giftsData as Gift[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadGifts();
  }, []);

  const ordered = useMemo(() => {
    let filtered = gifts;
    if (searchQuery.trim()) {
      const q = normalizeText(searchQuery.trim());
      filtered = filtered.filter(g => normalizeText(`${g.name} ${g.category} ${g.description}`).includes(q));
    }
    if (selectedCategory) filtered = filtered.filter(g => g.category === selectedCategory);
    if (priceFilter === 'upto200') filtered = filtered.filter(g => g.price <= 200);
    if (priceFilter === '200to500') filtered = filtered.filter(g => g.price > 200 && g.price <= 500);
    if (priceFilter === 'over500') filtered = filtered.filter(g => g.price > 500);

    const bySort = (a: Gift, b: Gift) =>
      sort === 'price-asc' ? a.price - b.price : sort === 'price-desc' ? b.price - a.price : a.sort_order - b.sort_order;
    // Disponíveis primeiro; reservados/completos vão para o fim
    return [...filtered].sort((a, b) => Number(isUnavailable(a)) - Number(isUnavailable(b)) || bySort(a, b));
  }, [gifts, searchQuery, priceFilter, selectedCategory, sort]);

  const quotaGifts = ordered.filter(g => g.price > QUOTA_THRESHOLD);
  const singleGifts = ordered.filter(g => g.price <= QUOTA_THRESHOLD);
  const availableCount = gifts.filter(g => !isUnavailable(g)).length;
  const hasActiveFilters = Boolean(searchQuery.trim() || selectedCategory || priceFilter !== 'all');

  function clearFilters() {
    setSearchQuery('');
    setSelectedCategory(null);
    setPriceFilter('all');
  }

  const categories = useMemo(() => Array.from(new Set(gifts.map(g => g.category))).sort(), [gifts]);

  async function requestGift(gift: Gift) {
    if (!supabase || !gift.id) {
      window.location.assign(whatsappUrl(gift));
      return;
    }

    const { data, error } = await supabase.rpc('create_reservation_request', { p_gift_id: gift.id });
    if (error) {
      setNotice(error.message.includes('not available') ? 'Esse presente acabou de ser reservado por outra pessoa.' : 'Não conseguimos abrir a reserva agora. Tente novamente em instantes.');
      await loadGifts();
      return;
    }

    const result = Array.isArray(data) ? data[0] : data;
    const requestCode = result?.request_code as string | undefined;
    window.location.assign(whatsappUrl(gift, requestCode));
    setNotice(requestCode ? `Pedido #${requestCode} criado. Agora é só enviar a mensagem no WhatsApp 🤍` : null);
  }

  async function createContribution(amount: number, giftId: number | null) {
    if (!supabase) {
      window.location.assign(whatsappContributionUrl(giftId ? gifts.find(g=>g.id===giftId)?.name || '' : null, amount, 'TESTE123'));
      return;
    }

    const { data, error } = await supabase.rpc('create_contribution', { p_gift_id: giftId, p_amount: amount });
    if (error) {
      console.error(error);
      throw new Error(error.message || 'Falha ao processar a contribuição.');
    }
    const result = Array.isArray(data) ? data[0] : data;
    const requestCode = result?.request_code as string;
    
    const giftName = giftId ? gifts.find(g => g.id === giftId)?.name || '' : null;
    setActiveModal(null);
    window.location.assign(whatsappContributionUrl(giftName, amount, requestCode));
    setNotice(`Solicitação #${requestCode} criada. Confirme pelo WhatsApp 🤍`);
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <picture>
          <source media="(max-width: 600px)" srcSet="/hero-sm.webp" type="image/webp" />
          <source srcSet="/hero.webp" type="image/webp" />
          <img className="hero-image" src="/hero.jpg" alt="Mãos de Emily e Joel com as alianças" fetchPriority="high" />
        </picture>
        <div className="hero-gradient" />
        <div className="hero-copy">
          <span className="hero-kicker">Emily &amp; Joel</span>
          <h1>Um pedacinho da nossa nova casa pode começar com você.</h1>
          <p>Selecionamos alguns presentes que vão fazer parte da nossa rotina, dos nossos almoços, cafés, domingos e de tudo aquilo que ainda vamos construir juntos.</p>
          <a href="#presentes" className="hero-cta">
            Ver lista de presentes <ChevronDown size={18} aria-hidden="true" />
          </a>
        </div>
      </section>

      <section className="catalog" id="presentes">
        <div className="how-it-works">
          <h2>Como funciona</h2>
          <ol className="steps">
            <li><span>1</span><p>Escolha um presente ou uma parte de um presente maior.</p></li>
            {paymentsOn ? (
              <>
                <li><span>2</span><p>Pague aqui mesmo, com Pix ou cartão de crédito.</p></li>
                <li><span>3</span><p>Pronto! A confirmação é na hora e o presente sai da lista 🤍</p></li>
              </>
            ) : (
              <>
                <li><span>2</span><p>Toque no botão e o WhatsApp abre com a mensagem pronta.</p></li>
                <li><span>3</span><p>A gente confirma com você por lá. Simples assim 🤍</p></li>
              </>
            )}
          </ol>
        </div>

        <div className="catalog-filters">
          <div className="search-bar">
            <Search aria-hidden="true" />
            <input type="search" aria-label="Buscar presentes" placeholder="Buscar presente (ex.: panela, toalha)" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            {searchQuery && <button className="search-clear" onClick={() => setSearchQuery('')} aria-label="Limpar busca"><X size={16} /></button>}
          </div>
          <div className="filter-chips" role="group" aria-label="Categorias">
            <button className={`chip ${selectedCategory === null ? 'active' : ''}`} aria-pressed={selectedCategory === null} onClick={() => setSelectedCategory(null)}><Sparkles aria-hidden="true" /> Todos</button>
            {categories.map(cat => (
              <button key={cat} className={`chip ${selectedCategory === cat ? 'active' : ''}`} aria-pressed={selectedCategory === cat} onClick={() => setSelectedCategory(cat)}>
                {categoryLabel(cat)}
              </button>
            ))}
          </div>
          <div className="filter-chips" role="group" aria-label="Faixa de preço">
            {PRICE_FILTERS.map(f => (
              <button key={f.id} className={`chip chip-soft ${priceFilter === f.id ? 'active' : ''}`} aria-pressed={priceFilter === f.id} onClick={() => setPriceFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          <div className="results-bar">
            <span aria-live="polite">
              {hasActiveFilters ? `${ordered.length} de ${gifts.length} presentes` : `${availableCount} presentes disponíveis`}
              {hasActiveFilters && <button className="link-btn" onClick={clearFilters}>Limpar filtros</button>}
            </span>
            <label className="sort-select">
              <span className="sr-only">Ordenar por</span>
              <select value={sort} onChange={e => setSort(e.target.value as SortType)}>
                <option value="suggested">Sugeridos</option>
                <option value="price-asc">Menor preço</option>
                <option value="price-desc">Maior preço</option>
              </select>
            </label>
          </div>
        </div>

        {notice && <button className="notice" onClick={() => setNotice(null)}>{notice} <X size={14} aria-hidden="true" /></button>}
        {loading && (
          <div className="gift-grid" aria-busy="true" aria-label="Carregando presentes">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="gift-card skeleton" />)}
          </div>
        )}

        {!loading && ordered.length === 0 && (
          <div className="empty-state">
            <p>Nenhum presente encontrado com esses filtros.</p>
            <button className="gift-button quota-btn" onClick={clearFilters}>Ver todos os presentes</button>
          </div>
        )}

        {!loading && singleGifts.length > 0 && (
          <div className="gifts-section">
            <div className="section-head">
              <h2>Lista de presentes</h2>
              <p>Presentes até {formatBRL(QUOTA_THRESHOLD)}, para dar inteiros.</p>
            </div>
            <div className="gift-grid">
              {singleGifts.map((gift, index) => <GiftCard key={gift.source_id} gift={gift} index={index} onRequest={onGiftClick} onContribute={onContributeClick} />)}
            </div>
          </div>
        )}

        {!loading && quotaGifts.length > 0 && (
          <div className="quotas-section">
            <div className="section-head">
              <h2>Presentes compartilhados 🤍</h2>
              <p>Itens maiores que você pode presentear com uma parte do valor, junto com outras pessoas.</p>
            </div>
            <div className="gift-grid">
              {quotaGifts.map((gift, index) => <GiftCard key={gift.source_id} gift={gift} index={index} onRequest={onGiftClick} onContribute={onContributeClick} />)}
            </div>
          </div>
        )}

        {!loading && !paymentsOn && (
          <article className="gift-card free-contrib-card">
            <div className="gift-body">
              <h3>Prefere contribuir de outra forma?</h3>
              <p>Se nenhum presente específico fizer sentido para você, também é possível contribuir com o valor que quiser para essa nova fase da nossa casa.</p>
              <button className="gift-button" onClick={() => setActiveModal('free')}>Contribuir com um valor livre</button>
            </div>
          </article>
        )}
      </section>

      {paymentsOn ? (
      <section className="pix-section">
        <div className="pix-container">
          <h3>Prefere dar um valor livre?</h3>
          <p>Se nenhum presente fizer sentido, você pode contribuir com o valor que quiser para a nossa casa nova. O Pix é gerado na hora.</p>
          <button className="gift-button free-cta" onClick={() => setCheckout({ target: 'free' })}>Contribuir com um valor personalizado</button>
        </div>
        <p className="footer-note">Com carinho, Emily &amp; Joel 🤍</p>
      </section>
      ) : (
      <section className="pix-section">
        <div className="pix-container">
          <h3>Nossa chave Pix</h3>
          <p>Para quem preferir contribuir diretamente via Pix (CPF):</p>
          <button className={`pix-key ${pixCopied ? 'copied' : ''}`} onClick={copyPix} aria-label={`Copiar chave Pix ${PIX_KEY}`}>
            <span>{PIX_KEY}</span>
            {pixCopied ? <><Check size={18} aria-hidden="true" /> Copiada!</> : <><Copy size={18} aria-hidden="true" /> Copiar</>}
          </button>
        </div>
        <p className="footer-note">Com carinho, Emily &amp; Joel 🤍</p>
      </section>
      )}

      {checkout && payConfig && (
        <PaymentModal
          target={checkout.target}
          resumePaymentId={checkout.resumeId}
          config={payConfig}
          onClose={closeCheckout}
          onPaid={loadGifts}
          onWhatsapp={(gift) => { closeCheckout(); requestGift(gift); }}
        />
      )}

      {activeModal && (
        <ContributionModal gift={activeModal} onClose={() => setActiveModal(null)} onConfirm={createContribution} />
      )}
    </main>
  );
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
}

interface AdminPayment {
  id: string;
  kind: 'gift' | 'quota' | 'free';
  method: 'pix' | 'card';
  amount_net: number;
  fee_amount: number;
  amount_charged: number;
  payer_name: string;
  payer_email: string;
  message: string | null;
  status: string;
  created_at: string;
  approved_at: string | null;
  gift?: { name: string } | null;
}

const PAYMENT_STATUS: Record<string, string> = {
  approved: 'Pago', pending: 'Aguardando', rejected: 'Recusado', cancelled: 'Cancelado', expired: 'Expirado', refunded: 'Estornado',
};

function AdminPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [logged, setLogged] = useState(false);
  const [requests, setRequests] = useState<ReservationRequest[]>([]);
  const [contribs, setContribs] = useState<GiftContribution[]>([]);
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [tab, setTab] = useState<'payments' | 'requests' | 'contribs' | 'quotas' | 'all_gifts'>('payments');
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [editingGift, setEditingGift] = useState<Partial<Gift> | null>(null);
  const [adminGiftSearch, setAdminGiftSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!supabase) return;
    const [
      { data: requestData, error: requestError },
      { data: contribData, error: contribError },
      { data: giftData }
    ] = await Promise.all([
      supabase.from('reservation_requests').select('*, gift:gifts(*)').order('created_at', { ascending: false }),
      supabase.from('gift_contributions').select('*, gift:gifts(*)').order('created_at', { ascending: false }),
      supabase.from('gifts').select('*').order('sort_order', { ascending: true })
    ]);
    if (requestError) setError(requestError.message);
    else setRequests((requestData || []) as unknown as ReservationRequest[]);
    if (contribError) setError(contribError.message);
    else setContribs((contribData || []) as unknown as GiftContribution[]);
    setGifts((giftData || []) as Gift[]);
    // A tabela de pagamentos só existe depois de rodar supabase/payments.sql
    const { data: paymentData } = await supabase.from('payments').select('*, gift:gifts(name)').order('created_at', { ascending: false });
    setPayments((paymentData || []) as AdminPayment[]);
  }

  useEffect(() => {
    if (!supabase) {
      setSessionReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setLogged(Boolean(data.session));
      setSessionReady(true);
      if (data.session) refresh();
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setLogged(Boolean(session));
      if (session) refresh();
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!logged) return;
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [logged]);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setError(null);
    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError) setError('E-mail ou senha inválidos.');
  }

  async function actionReq(requestId: string, fn: 'confirm_reservation_request' | 'reject_reservation_request') {
    if (!supabase) return;
    setBusy(requestId);
    setError(null);
    const { error: actionError } = await supabase.rpc(fn, { p_request_id: requestId });
    if (actionError) setError(actionError.message);
    await refresh();
    setBusy(null);
  }

  async function actionContrib(contribId: string, fn: 'confirm_contribution' | 'reject_contribution') {
    if (!supabase) return;
    setBusy(contribId);
    setError(null);
    const { error: actionError } = await supabase.rpc(fn, { p_contribution_id: contribId });
    if (actionError) setError(actionError.message);
    await refresh();
    setBusy(null);
  }
  async function setGiftStatus(giftId: number, status: Gift['status']) {
    if (!supabase) return;
    setBusy(`gift-${giftId}`);
    const updates = status === 'received'
      ? { status, received: true }
      : status === 'available'
        ? { status, received: false, giver: null }
        : { status, received: false };
    const { error: updateError } = await supabase.from('gifts').update(updates).eq('id', giftId);
    if (updateError) setError(updateError.message);
    await refresh();
    setBusy(null);
  }

  
  
  async function setContributedAmount(giftId: number, amount: number) {
    if (!supabase) return;
    setBusy(`quota-${giftId}`);
    setError(null);
    const { error: updateError } = await supabase.from('gifts').update({ contributed_amount: amount }).eq('id', giftId);
    if (updateError) setError(updateError.message);
    await refresh();
    setBusy(null);
  }

  async function updateGiftDetails(giftId: number, data: Partial<Gift>) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from('gifts').update(data).eq('id', giftId);
    if (updateError) throw new Error(updateError.message);
    await refresh();
  }

  async function createGiftDetails(data: Partial<Gift>) {
    if (!supabase) return;
    const maxSourceId = gifts.length > 0 ? Math.max(...gifts.map(g => g.source_id)) : 0;
    const maxSortOrder = gifts.length > 0 ? Math.max(...gifts.map(g => g.sort_order)) : 0;
    const { error: insertError } = await supabase.from('gifts').insert({
      ...data,
      source_id: maxSourceId + 1,
      sort_order: maxSortOrder + 1,
      quantity: 1,
      received: false,
      thanked: false,
      status: 'available'
    });
    if (insertError) throw new Error(insertError.message);
    await refresh();
  }

  if (!hasSupabaseConfig) {
    return <main className="admin-shell"><div className="admin-empty"><h1>Admin</h1><p>Configure o Supabase no arquivo <code>.env</code> para usar o dashboard.</p></div></main>;
  }

  if (!sessionReady) return <main className="admin-shell"><div className="admin-empty">Carregando…</div></main>;

  if (!logged) {
    return (
      <main className="admin-shell admin-login-shell">
        <form className="admin-login" onSubmit={login}>
          <span className="admin-kicker">Emily & Joel</span>
          <h1>Painel de presentes</h1>
          <p>Entre com o acesso de administrador para gerenciar.</p>
          <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Senha<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="admin-error">{error}</p>}
          <button type="submit" className="admin-primary">Entrar</button>
        </form>
      </main>
    );
  }

  const pendingRequests = requests.filter((r) => r.status === 'pending').length;
  const pendingContribs = contribs.filter((c) => c.status === 'pending').length;
    
  const shownRequests = filter === 'pending' ? requests.filter((r) => r.status === 'pending') : requests;
  const shownContribs = filter === 'pending' ? contribs.filter((c) => c.status === 'pending') : contribs;
  
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div><span className="admin-kicker">Emily & Joel</span><h1>Painel</h1><p>Gerencie pedidos, cotas e reservas.</p></div>
        <div className="admin-header-actions"><button onClick={refresh}>Atualizar</button><button onClick={() => supabase?.auth.signOut()}>Sair</button></div>
      </header>

      <section className="admin-stats">
        <article><span>Recebido online</span><strong>{formatBRL(payments.filter(p => p.status === 'approved').reduce((s, p) => s + Number(p.amount_net), 0))}</strong></article>
        <article><span>Pedidos Pendentes</span><strong>{pendingRequests}</strong></article>
        <article><span>Contribuições Pendentes</span><strong>{pendingContribs}</strong></article>
      </section>

      {error && <p className="admin-error admin-error-wide">{error}</p>}

      <section className="admin-panel">
        <div className="admin-panel-head" style={{flexDirection: 'column', gap: '16px', alignItems: 'stretch'}}>
          
          
          <div className="admin-main-tabs" style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #ddd', paddingBottom: '12px', flexWrap: 'wrap' }}>
            <button className={`admin-tab-btn ${tab === 'payments' ? 'active' : ''}`} onClick={() => setTab('payments')}>💳 Pagamentos</button>
            <button className={`admin-tab-btn ${tab === 'requests' ? 'active' : ''}`} onClick={() => setTab('requests')}>🎁 Pedidos Normal</button>
            <button className={`admin-tab-btn ${tab === 'contribs' ? 'active' : ''}`} onClick={() => setTab('contribs')}>💸 Contribuições Pix</button>
            <button className={`admin-tab-btn ${tab === 'quotas' ? 'active' : ''}`} onClick={() => setTab('quotas')}>📈 Painel de Cotas</button>
            <button className={`admin-tab-btn ${tab === 'all_gifts' ? 'active' : ''}`} onClick={() => setTab('all_gifts')}>📝 Todos os Presentes</button>
          </div>
          <div className="admin-tabs" style={{alignSelf: 'flex-start', visibility: (tab === 'quotas' || tab === 'all_gifts') ? 'hidden' : 'visible'}}>

            <button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>Pendentes</button>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todos</button>
          </div>
        </div>

        <div className="request-list">
          {tab === 'payments' && (
            <>
              {(filter === 'pending' ? payments.filter(p => p.status === 'pending') : payments).length === 0 && (
                <div className="admin-empty inline"><strong>Nenhum pagamento por aqui.</strong><span>Os pagamentos aprovados já atualizam a lista sozinhos.</span></div>
              )}
              {(filter === 'pending' ? payments.filter(p => p.status === 'pending') : payments).map(p => (
                <article className="request-card" key={p.id}>
                  <div className="request-main">
                    <span className={`status-pill ${p.status === 'approved' ? 'confirmed' : p.status === 'pending' ? 'pending' : 'rejected'}`}>{PAYMENT_STATUS[p.status] || p.status}</span>
                    <small>{p.method === 'pix' ? 'Pix' : 'Cartão'} · {formatDate(p.created_at)}</small>
                    <h3>{p.payer_name} — {p.gift?.name || 'Contribuição livre'}{p.kind === 'quota' ? ' (cota)' : ''}</h3>
                    <p>Para vocês: <strong>{formatBRL(Number(p.amount_net))}</strong> · pago pelo convidado: {formatBRL(Number(p.amount_charged))} · {p.payer_email}</p>
                    {p.message && <p className="payment-message">“{p.message}”</p>}
                  </div>
                </article>
              ))}
            </>
          )}

          {tab === 'requests' && (
            <>
              {shownRequests.length === 0 && <div className="admin-empty inline"><strong>Nenhum pedido por aqui.</strong></div>}
              {shownRequests.map((request) => (
                <article className="request-card" key={request.id}>
                  <div className="request-main">
                    <span className={`status-pill ${request.status}`}>{request.status === 'pending' ? 'Pendente' : request.status === 'confirmed' ? 'Confirmado' : request.status === 'rejected' ? 'Recusado' : 'Cancelado'}</span>
                    <small>#{request.request_code} · {formatDate(request.created_at)}</small>
                    <h3>{request.gift?.name || 'Presente'}</h3>
                    <p>{request.gift ? formatBRL(request.gift.price) : ''}</p>
                    {/* Removed old toggle button */}
                  </div>
                  {request.status === 'pending' && (
                    <div className="request-actions">
                      <button disabled={busy === request.id} className="reject" onClick={() => actionReq(request.id, 'reject_reservation_request')}>Recusar</button>
                      <button disabled={busy === request.id} className="confirm" onClick={() => actionReq(request.id, 'confirm_reservation_request')}>Confirmar reserva</button>
                    </div>
                  )}
                  {request.status === 'confirmed' && request.gift?.id && (
                    <div className="request-actions">
                      {request.gift.status !== 'received' && <button disabled={busy === `gift-${request.gift.id}`} className="confirm" onClick={() => setGiftStatus(request.gift!.id!, 'received')}>Marcar como recebido</button>}
                      <button disabled={busy === `gift-${request.gift.id}`} className="reject" onClick={() => setGiftStatus(request.gift!.id!, 'available')}>Liberar presente</button>
                    </div>
                  )}
                </article>
              ))}
            </>
          )}

          {tab === 'quotas' && (
            <>
              <div className="admin-empty inline" style={{marginBottom:'16px', textAlign:'left'}}>
                <p>Atualize manualmente o valor arrecadado para presentes de cota (acima de R$ 300).</p>
              </div>
              {gifts.filter(g => g.price > 300).map((gift) => {
                const isComplete = (gift.contributed_amount || 0) >= gift.price;
                return (
                  <article className="request-card" key={gift.id}>
                    <div className="request-main">
                      {isComplete && <span className="status-pill confirmed">Completo</span>}
                      <h3>{gift.name}</h3>
                      <p>Valor total: <strong>{formatBRL(gift.price)}</strong></p>
                      
                      <div style={{marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center'}}>
                        <span style={{fontSize:'0.9rem', color:'#575644'}}>Arrecadado: R$</span>
                        <input 
                          type="number" 
                          defaultValue={gift.contributed_amount || 0}
                          id={`quota-input-${gift.id}`}
                          style={{
                            padding: '6px', borderRadius: '6px', border: '1px solid #ddd', width: '100px'
                          }}
                        />
                        <button 
                          disabled={busy === `quota-${gift.id}`} 
                          onClick={() => {
                            const val = (document.getElementById(`quota-input-${gift.id}`) as HTMLInputElement).value;
                            setContributedAmount(gift.id!, parseFloat(val) || 0);
                          }}
                          style={{
                            padding: '6px 12px', background: '#556B2F', color: '#fff', borderRadius: '6px', border: 'none', cursor: 'pointer'
                          }}
                        >
                          Salvar
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </>
          )}

          {tab === 'contribs' && (
            <>
              {shownContribs.length === 0 && <div className="admin-empty inline"><strong>Nenhuma contribuição por aqui.</strong></div>}
              {shownContribs.map((contrib) => (
                <article className="request-card" key={contrib.id}>
                  <div className="request-main">
                    <span className={`status-pill ${contrib.status}`}>{contrib.status === 'pending' ? 'Pendente' : contrib.status === 'confirmed' ? 'Confirmado' : contrib.status === 'rejected' ? 'Recusado' : 'Cancelado'}</span>
                    <small>#{contrib.request_code} · {formatDate(contrib.created_at)}</small>
                    <h3>{contrib.gift ? contrib.gift.name : 'Contribuição Livre 🤍'}</h3>
                    <p><strong>{formatBRL(contrib.amount)}</strong></p>
                  </div>
                  {contrib.status === 'pending' && (
                    <div className="request-actions">
                      <button disabled={busy === contrib.id} className="reject" onClick={() => actionContrib(contrib.id, 'reject_contribution')}>Recusar</button>
                      <button disabled={busy === contrib.id} className="confirm" onClick={() => actionContrib(contrib.id, 'confirm_contribution')}>Confirmar valor</button>
                    </div>
                  )}
                </article>
              ))}
            </>
          )}

          {tab === 'all_gifts' && (
            <>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <Search style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', width: '18px', color: '#888' }} />
                  <input 
                    type="text" 
                    placeholder="Pesquisar presentes por nome ou categoria..." 
                    value={adminGiftSearch}
                    onChange={(e) => setAdminGiftSearch(e.target.value)}
                    style={{ padding: '8px 12px 8px 36px', borderRadius: '6px', border: '1px solid #ddd', width: '100%', fontFamily: 'inherit' }}
                  />
                </div>
                <button 
                  onClick={() => setEditingGift({ name: '', description: '', price: 0, category: 'Cozinha' })}
                  style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#556B2F', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, whiteSpace: 'nowrap' }}
                >
                  Adicionar Presente
                </button>
              </div>
              {gifts.filter(g => g.name.toLowerCase().includes(adminGiftSearch.toLowerCase()) || g.category.toLowerCase().includes(adminGiftSearch.toLowerCase())).map((gift) => (
                <article className="request-card" key={gift.id}>
                  <div className="request-main">
                    <h3>{gift.name}</h3>
                    <p>Preço: <strong>{formatBRL(gift.price)}</strong> | Categoria: {gift.category}</p>
                    <p style={{fontSize: '0.85rem', color: '#666', marginTop: '4px'}}>{gift.description}</p>
                  </div>
                  <div className="request-actions">
                    <button className="confirm" onClick={() => setEditingGift(gift)}>Editar</button>
                  </div>
                </article>
              ))}
            </>
          )}
        </div>
      </section>
      
      {editingGift && (
        <EditGiftModal 
          gift={editingGift} 
          onClose={() => setEditingGift(null)} 
          onSave={async (data) => {
            if (editingGift.id) {
              await updateGiftDetails(editingGift.id, data);
            } else {
              await createGiftDetails(data);
            }
          }}
        />
      )}
    </main>
  );
}

export default function App() {
  return window.location.pathname.startsWith('/admin') ? <AdminPage /> : <PublicPage />;
}
