import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

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
  const { data: gifts, error } = await supabase.from('gifts').select('*').order('sort_order', { ascending: true });
  if (error) {
    console.error("Error fetching gifts:", error);
    return;
  }

  // Update src/data/gifts.ts
  const tsContent = `import type { Gift } from '../types';\n\nexport const fallbackGifts: Gift[] = ${JSON.stringify(gifts, null, 2)};\n`;
  fs.writeFileSync('src/data/gifts.ts', tsContent);

  // Update supabase/seed.sql
  let sql = `insert into public.gifts (source_id, name, category, brand, price, quantity, giver, received, thanked, notes, description, status, sort_order, image_url) values\n`;
  const values = gifts.map(g => {
    const imageUrl = g.image_url ? `'${g.image_url}'` : 'null';
    const notes = g.notes ? `'${g.notes.replace(/'/g, "''")}'` : 'null';
    return `  (${g.source_id}, '${g.name.replace(/'/g, "''")}', '${g.category}', null, ${g.price}, ${g.quantity}, null, false, false, ${notes}, '${g.description}', '${g.status}', ${g.sort_order}, ${imageUrl})`;
  });
  sql += values.join(',\n') + '\n';
  sql += `on conflict (source_id) do update set
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
  fs.writeFileSync('supabase/seed.sql', sql);

  console.log("Locals synced!");
}
run();
