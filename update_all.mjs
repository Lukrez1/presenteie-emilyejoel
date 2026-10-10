import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const csvContent = fs.readFileSync('data/lista_presentes.csv', 'utf8');
const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
const items = lines.slice(1).map(line => {
  const [name, priceStr, link] = line.split(';');
  const price = parseFloat(priceStr.replace(',', '.'));
  return { name, price, link };
});

const getCategory = (name) => {
  const n = name.toLowerCase();
  if (n.includes('panela') || n.includes('assadeira') || n.includes('talher') || n.includes('faqueiro') && !n.includes('churrasco') || n.includes('jantar') || n.includes('xícara') || n.includes('copo') || n.includes('pote') || n.includes('saladeira') || n.includes('bowl') || n.includes('jarro') || n.includes('açucareiro') || n.includes('escorredor') || n.includes('utensílio') || n.includes('ralador') || n.includes('peneira') || n.includes('fruteira') || n.includes('garrafa') || n.includes('porta-temperos') || n.includes('cuscuzeira')) return 'Cozinha';
  if (n.includes('air fryer') || n.includes('micro-ondas') || n.includes('fogão') || n.includes('batedeira') || n.includes('multiprocessador') || n.includes('chaleira') || n.includes('grill') || n.includes('ferro') || n.includes('liquidificador')) return 'Eletrodomesticos';
  if (n.includes('guarda-roupa') || n.includes('cabeceira') || n.includes('lençol') || n.includes('edredom') || n.includes('colcha') || n.includes('travesseiro') || n.includes('cortina') || n.includes('cama')) return 'Quarto';
  if (n.includes('toalha') || n.includes('banheiro') || n.includes('shampoo')) return 'Banheiro';
  if (n.includes('espelho grande') || n.includes('cesto')) return 'Sala';
  if (n.includes('lixeira') || n.includes('tábua')) return 'Lavanderia';
  if (n.includes('churrasco')) return 'Lazer';
  return 'Cozinha';
};

const imageMapping = {
  'Quarto': 'https://okuhlbczgvolpholvebc.supabase.co/storage/v1/object/public/gift-images/cat-media_1786993223656.jpg',
  'Cozinha': 'https://okuhlbczgvolpholvebc.supabase.co/storage/v1/object/public/gift-images/cat-media_1786993223728.jpg',
  'Eletrodomesticos': 'https://okuhlbczgvolpholvebc.supabase.co/storage/v1/object/public/gift-images/cat-media_1786993223728.jpg',
};

const gifts = items.map((item, idx) => {
  const category = getCategory(item.name);
  return {
    source_id: idx + 1,
    name: item.name,
    category: category,
    brand: null,
    price: item.price,
    quantity: 1,
    giver: null,
    received: false,
    thanked: false,
    notes: item.link,
    description: 'Para o nosso novo lar com muito carinho.',
    status: 'available',
    sort_order: idx + 1,
    image_url: imageMapping[category] || null
  };
});

// Update data/gifts.ts
const giftsTsContent = `import type { Gift } from '../types';

export const fallbackGifts: Gift[] = ${JSON.stringify(gifts, null, 2)};
`;
fs.writeFileSync('src/data/gifts.ts', giftsTsContent);

// Update seed.sql
const seedSql = `insert into public.gifts (source_id, name, category, brand, price, quantity, giver, received, thanked, notes, description, status, sort_order, image_url) values\n` + 
gifts.map((g, i) => {
  const img = g.image_url ? `'${g.image_url}'` : 'null';
  return `  (${g.source_id}, '${g.name.replace(/'/g, "''")}', '${g.category}', null, ${g.price}, ${g.quantity}, null, false, false, '${g.notes}', '${g.description}', '${g.status}', ${g.sort_order}, ${img})${i === gifts.length - 1 ? '' : ','}`;
}).join('\n') +
`\non conflict (source_id) do update set
  name = excluded.name,
  category = excluded.category,
  brand = excluded.brand,
  price = excluded.price,
  quantity = excluded.quantity,
  giver = excluded.giver,
  received = excluded.received,
  thanked = excluded.thanked,
  notes = excluded.notes,
  description = excluded.description,
  status = excluded.status,
  sort_order = excluded.sort_order,
  image_url = excluded.image_url;
`;
fs.writeFileSync('supabase/seed.sql', seedSql);

// Update Supabase
const envPath = path.resolve('.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = Object.fromEntries(
  envContent.split('\n')
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
        const [k, ...v] = line.split('=');
        return [k.trim(), v.join('=').trim()];
    })
);

const supabaseUrl = env['VITE_SUPABASE_URL'];
const SUPABASE_SERVICE_ROLE_KEY = env['SUPABASE_SERVICE_ROLE_KEY'];
const supabase = createClient(supabaseUrl, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log("Deleting old gifts...");
  await supabase.from('gifts').delete().neq('source_id', -1);
  console.log("Inserting new gifts...");
  const { error } = await supabase.from('gifts').insert(gifts);
  if (error) console.error("Error inserting gifts:", error);
  else console.log("Gifts updated successfully!");
}
run();
