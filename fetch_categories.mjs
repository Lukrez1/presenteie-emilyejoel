import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Carregar variáveis do .env manualmente
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
  const { data: gifts, error } = await supabase.from('gifts').select('id, category, name');
  if (error) {
    console.error("Error fetching gifts:", error);
    return;
  }
  
  const categories = [...new Set(gifts.map(g => g.category))];
  console.log("Categorias encontradas:", categories);
}

run();
