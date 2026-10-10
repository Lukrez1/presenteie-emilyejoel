// Pesquisa preço médio + foto real de cada presente no Buscapé (que agrega
// Magalu, Amazon, Casas Bahia, Mercado Livre etc.) e opcionalmente grava no Supabase.
//
//   node scripts/atualizar_precos.mjs                 -> só pesquisa e gera relatório (não altera nada)
//   node scripts/atualizar_precos.mjs --apply         -> grava preço e foto no Supabase
//   node scripts/atualizar_precos.mjs --apply --from-report  -> grava o último relatório sem pesquisar de novo
//   opções extras: --ids=1,2,3   --only-prices   --only-images   --include-reserved
//
// O --apply precisa de SUPABASE_SERVICE_ROLE_KEY no arquivo .env.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_PRICES = args.includes('--only-prices');
const ONLY_IMAGES = args.includes('--only-images');
const INCLUDE_RESERVED = args.includes('--include-reserved');
const FROM_REPORT = args.includes('--from-report'); // aplica o último relatório salvo, sem pesquisar de novo
const ONLY_IDS = args.find(a => a.startsWith('--ids='))?.slice(6).split(',').map(Number);

const MIN_RESULTS = 3;       // abaixo disso o preço não é aplicado (pouca confiança)
const OUTLIER_FACTOR = 1.6;  // descarta preços fora de [mediana/1.6, mediana*1.6]
const BUCKET = 'gift-images';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim()]; })
);
const queries = JSON.parse(fs.readFileSync('data/precos_busca.json', 'utf8'));

const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const brl = n => n == null ? '-' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function fetchPage(q, page) {
  const res = await fetch(`https://www.buscape.com.br/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' } });
  if (!res.ok) throw new Error(`Buscapé respondeu ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Formato da página do Buscapé mudou (sem __NEXT_DATA__)');
  return JSON.parse(m[1])?.props?.initialReduxState?.hits?.hits ?? [];
}

async function searchBuscape(q) {
  const hits = [...await fetchPage(q, 1)];
  await sleep(800);
  hits.push(...(await fetchPage(q, 2)).map(h => ({ ...h, position: (h.position ?? 0) + 100 })));
  // O mesmo anúncio costuma aparecer várias vezes (vendedores repetidos): fica só o mais barato de cada nome
  const byName = new Map();
  for (const h of hits) {
    if (!h.name) continue;
    const key = normalize(h.name).replace(/[^a-z0-9]/g, '');
    if (!byName.has(key) || h.price < byName.get(key).price) byName.set(key, h);
  }
  return [...byName.values()];
}

function analyze(hits, cfg) {
  const req = (cfg.require || []).map(r => new RegExp(r));
  const exc = [...(cfg.exclude || []), ...(queries._exclude_global || [])].map(r => new RegExp(r));
  const matched = hits.filter(h => {
    if (!h.name || !(h.price > 0)) return false;
    const n = normalize(h.name);
    return req.every(r => r.test(n)) && !exc.some(r => r.test(n));
  });
  if (!matched.length) return { matched: 0, kept: [] };
  const med = median(matched.map(h => h.price));
  const kept = matched.filter(h => h.price >= med / OUTLIER_FACTOR && h.price <= med * OUTLIER_FACTOR);
  const prices = kept.map(h => h.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  // Foto: o resultado mais bem posicionado com preço próximo da média
  const byPos = [...kept].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const pick = byPos.find(h => Math.abs(h.price - avg) / avg < 0.3) || byPos[0];
  return {
    matched: matched.length, kept,
    avg: Math.round(avg), median: Math.round(median(prices) * 100) / 100,
    min: Math.min(...prices), max: Math.max(...prices),
    image: pick?.image?.replace(/\/thumbs\/\d+\//, '/thumbs/12/'), // ~600px
    imageFrom: pick?.name,
  };
}

async function main() {
  const publicClient = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  const { data: gifts, error } = await publicClient.from('gifts').select('id,source_id,name,price,status,image_url').order('sort_order');
  if (error) throw error;

  const report = [];
  if (FROM_REPORT) {
    const saved = JSON.parse(fs.readFileSync('data/relatorio_precos.json', 'utf8')).itens;
    for (const r of saved) {
      const live = gifts.find(g => g.source_id === r.source_id);
      if (live && (!ONLY_IDS || ONLY_IDS.includes(r.source_id))) report.push({ ...r, id: live.id, status: live.status });
    }
    console.log(`Usando relatório salvo (${report.length} itens).`);
  }
  for (const g of FROM_REPORT ? [] : gifts) {
    if (ONLY_IDS && !ONLY_IDS.includes(g.source_id)) continue;
    const cfg = queries[g.source_id] || { q: g.name, require: [] };
    let r;
    try { r = analyze(await searchBuscape(cfg.q), cfg); }
    catch (e) { r = { error: e.message, matched: 0, kept: [] }; }
    const row = {
      source_id: g.source_id, id: g.id, name: g.name, status: g.status, manter_preco: Boolean(cfg.keepPrice),
      preco_atual: g.price, media: r.avg ?? null, mediana: r.median ?? null, min: r.min ?? null, max: r.max ?? null,
      resultados: r.kept.length, imagem: r.image ?? null, imagem_de: r.imageFrom ?? null, erro: r.error ?? null,
      ofertas: r.kept.map(h => ({ nome: h.name, preco: h.price })),
    };
    report.push(row);
    const diff = row.media != null ? ((row.media - g.price) / g.price * 100).toFixed(0) + '%' : '';
    console.log(`${String(g.source_id).padStart(2)} ${g.name.slice(0, 48).padEnd(48)} ${brl(g.price).padStart(12)} -> ${brl(row.media).padStart(12)} ${diff.padStart(5)} (${row.resultados} ofertas)${row.erro ? ' ERRO: ' + row.erro : ''}`);
    await sleep(1500); // educado com o site
  }

  let fullReport = report;
  if (ONLY_IDS && fs.existsSync('data/relatorio_precos.json')) {
    // Rodada parcial: atualiza só os itens pesquisados dentro do relatório existente
    const prev = JSON.parse(fs.readFileSync('data/relatorio_precos.json', 'utf8')).itens;
    fullReport = prev.map(p => report.find(r => r.source_id === p.source_id) || p);
  }
  if (!FROM_REPORT) fs.writeFileSync('data/relatorio_precos.json', JSON.stringify({ gerado_em: new Date().toISOString(), itens: fullReport }, null, 2));
  const csv = ['source_id;nome;status;preco_atual;media;mediana;min;max;ofertas;imagem']
    .concat(fullReport.map(r => [r.source_id, r.name, r.status, r.preco_atual, r.media, r.mediana, r.min, r.max, r.resultados, r.imagem].map(v => String(v ?? '').replace('.', ',')).join(';')));
  fs.writeFileSync('data/relatorio_precos.csv', csv.join('\n'));
  console.log('\nRelatório salvo em data/relatorio_precos.json e data/relatorio_precos.csv');

  if (!APPLY) { console.log('Modo simulação: nada foi alterado. Rode com --apply para gravar no Supabase.'); return; }

  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Defina SUPABASE_SERVICE_ROLE_KEY no .env para usar --apply');
  const admin = createClient(env.VITE_SUPABASE_URL, key);

  // Backup completo antes de alterar qualquer coisa
  const { data: backup, error: backupErr } = await admin.from('gifts').select('*').order('sort_order');
  if (backupErr) throw backupErr;
  const backupFile = `data/backup_gifts_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`Backup salvo em ${backupFile}`);

  for (const r of report) {
    // Preço de item já reservado/recebido não muda (a pessoa já se comprometeu com aquele valor)
    // "keepPrice" na config = busca só a foto (produto genérico demais para confiar no preço)
    const canChangePrice = (r.status === 'available' || INCLUDE_RESERVED) && !r.manter_preco;
    const update = {};
    if (!ONLY_IMAGES && canChangePrice && r.media != null && r.resultados >= MIN_RESULTS) update.price = r.media;
    if (!ONLY_PRICES && r.imagem) {
      // Nem todo produto tem todos os tamanhos: tenta ~600px, depois ~1500px, depois a miniatura
      let img;
      for (const size of ['12', '1', '45']) {
        img = await fetch(r.imagem.replace(/\/thumbs\/\d+\//, `/thumbs/${size}/`), { headers: { 'User-Agent': UA } });
        if (img.ok) break;
      }
      if (img.ok) {
        const path = `produtos/presente-${r.source_id}.jpg`;
        const { error: upErr } = await admin.storage.from(BUCKET).upload(path, Buffer.from(await img.arrayBuffer()), { contentType: 'image/jpeg', upsert: true });
        if (upErr) console.log(`! ${r.source_id} falha no upload da imagem: ${upErr.message}`);
        else update.image_url = `${admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
      }
    }
    if (!Object.keys(update).length) { console.log(`- ${r.source_id} sem dados confiáveis, mantido`); continue; }
    const { error: upd } = await admin.from('gifts').update(update).eq('id', r.id);
    console.log(upd ? `! ${r.source_id} erro: ${upd.message}` : `✓ ${r.source_id} ${r.name} ${update.price ? brl(update.price) : ''}${update.image_url ? ' +foto' : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
