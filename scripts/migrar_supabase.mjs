// Copia tudo do projeto Supabase antigo para o novo e troca o .env para o novo.
//   1. Rode supabase/setup_completo.sql no projeto novo (já feito)
//   2. Preencha no .env: NEW_SUPABASE_URL, NEW_SUPABASE_ANON_KEY, NEW_SUPABASE_SERVICE_ROLE_KEY
//   3. node scripts/migrar_supabase.mjs
// Copia: gifts, reservation_requests, gift_contributions e as fotos do bucket gift-images.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envText = fs.readFileSync('.env', 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim()]; })
);
for (const k of ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEW_SUPABASE_URL', 'NEW_SUPABASE_ANON_KEY', 'NEW_SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) throw new Error(`Falta ${k} no .env`);
}
if (env.VITE_SUPABASE_URL === env.NEW_SUPABASE_URL) throw new Error('O .env já aponta para o projeto novo.');

const OLD_URL = env.VITE_SUPABASE_URL;
const NEW_URL = env.NEW_SUPABASE_URL.replace(/\/$/, '');
const oldDb = createClient(OLD_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const newDb = createClient(NEW_URL, env.NEW_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BUCKET = 'gift-images';

async function all(db, table, order) {
  const { data, error } = await db.from(table).select('*').order(order);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

// 1) Fotos: copia cada arquivo usado pelos presentes e reescreve a URL para o projeto novo
const gifts = await all(oldDb, 'gifts', 'sort_order');
const oldPublicPrefix = `${OLD_URL}/storage/v1/object/public/${BUCKET}/`;
let copied = 0;
for (const g of gifts) {
  if (!g.image_url?.startsWith(oldPublicPrefix)) continue;
  const [pathWithName, query] = g.image_url.slice(oldPublicPrefix.length).split('?');
  const path = decodeURIComponent(pathWithName);
  const res = await fetch(g.image_url);
  if (!res.ok) { console.log(`! foto do presente ${g.source_id} não baixou (${res.status})`); continue; }
  const { error } = await newDb.storage.from(BUCKET).upload(path, Buffer.from(await res.arrayBuffer()), {
    contentType: res.headers.get('content-type') || 'image/jpeg', upsert: true,
  });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  g.image_url = `${NEW_URL}/storage/v1/object/public/${BUCKET}/${pathWithName}${query ? `?${query}` : ''}`;
  copied++;
}
console.log(`✓ ${copied} fotos copiadas`);

// 2) Dados (mantendo os mesmos ids, para os pedidos continuarem apontando para os presentes certos)
const upsert = async (table, rows, onConflict) => {
  if (!rows.length) return console.log(`- ${table}: vazio`);
  const { error } = await newDb.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`✓ ${table}: ${rows.length}`);
};
await upsert('gifts', gifts, 'id');
await upsert('reservation_requests', await all(oldDb, 'reservation_requests', 'created_at'), 'id');
await upsert('gift_contributions', await all(oldDb, 'gift_contributions', 'created_at'), 'id');

// 3) Confere
const { count } = await newDb.from('gifts').select('*', { count: 'exact', head: true });
if (count !== gifts.length) throw new Error(`Conferência falhou: ${count} de ${gifts.length} presentes no projeto novo`);

// 4) Troca o .env: o projeto novo vira o principal; o antigo fica guardado como OLD_*
let out = envText
  .replace(/^VITE_SUPABASE_URL=.*$/m, `VITE_SUPABASE_URL=${NEW_URL}`)
  .replace(/^VITE_SUPABASE_ANON_KEY=.*$/m, `VITE_SUPABASE_ANON_KEY=${env.NEW_SUPABASE_ANON_KEY}`)
  .replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, `SUPABASE_SERVICE_ROLE_KEY=${env.NEW_SUPABASE_SERVICE_ROLE_KEY}`)
  .replace(/^NEW_SUPABASE_.*\r?\n?/gm, '');
out += `\n# Projeto Supabase antigo (antes da migração em ${new Date().toISOString().slice(0, 10)})\nOLD_SUPABASE_URL=${OLD_URL}\nOLD_SUPABASE_ANON_KEY=${env.VITE_SUPABASE_ANON_KEY}\nOLD_SUPABASE_SERVICE_ROLE_KEY=${env.SUPABASE_SERVICE_ROLE_KEY}\n`;
fs.writeFileSync('.env', out);
console.log('✓ .env agora aponta para o projeto novo');
