import { writeFile } from 'node:fs/promises';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required Netlify environment variable: ${name}`);
}
const config = `// Generated during Netlify build. Do not commit secrets here.
export const SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY)};
export const VAPID_PUBLIC_KEY = ${JSON.stringify(process.env.VAPID_PUBLIC_KEY || '')};
`;
await writeFile(new URL('../public/config.js', import.meta.url), config, 'utf8');
console.log('Generated public/config.js from Netlify environment variables.');
