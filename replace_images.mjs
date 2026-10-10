import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Load .env variables
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

const uploadDir = "C:\\Users\\Joel Vieira\\.gemini\\antigravity-ide\\brain\\9c0e5ac4-3a28-49b4-8b4c-56cb36d9bffe\\.user_uploaded";

const imageMapping = {
  'Quarto': 'media_1786993223656.jpg',
  'Cozinha': 'media_1786993223728.jpg',
  'Eletrodomesticos': 'media_1786993223728.jpg',
};

async function run() {
  console.log('Uploading images to Supabase Storage...');
  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
  if (bucketError) console.error("Bucket error:", bucketError);
  else console.log("Buckets disponíveis:", buckets.map(b => b.name));
  
  if (!buckets.find(b => b.name === 'gift-images')) {
      await supabase.storage.createBucket('gift-images', { public: true });
      console.log('Bucket gift-images criado.');
  }

  const uploadedUrls = {};

  const uniqueFiles = [...new Set(Object.values(imageMapping))];
  
  for (const filename of uniqueFiles) {
    const filePath = path.join(uploadDir, filename);
    const fileContent = fs.readFileSync(filePath);
    
    const newName = `cat-${filename}`;
    
    const { data, error } = await supabase.storage
      .from('gift-images')
      .upload(newName, fileContent, {
        contentType: 'image/jpeg',
        upsert: true
      });

    if (error) {
      console.error(`Error uploading ${filename}:`, error);
    } else {
      const publicUrl = supabase.storage.from('gift-images').getPublicUrl(newName).data.publicUrl;
      uploadedUrls[filename] = publicUrl;
      console.log(`Uploaded ${filename} -> ${publicUrl}`);
    }
  }

  console.log('Updating gifts table...');
  const { data: gifts, error } = await supabase.from('gifts').select('id, category');
  if (error) {
    console.error("Error fetching gifts:", error);
    return;
  }

  let count = 0;
  for (const gift of gifts) {
    const filename = imageMapping[gift.category];
    if (filename && uploadedUrls[filename]) {
      const { error: updateError } = await supabase.from('gifts').update({
        image_url: uploadedUrls[filename]
      }).eq('id', gift.id);

      if (updateError) {
        console.error(`Error updating gift ${gift.id}:`, updateError);
      } else {
        count++;
      }
    }
  }

  console.log(`Successfully updated ${count} gifts with category images.`);
}

run();
