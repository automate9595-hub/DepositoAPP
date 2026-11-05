// Usado por publicar.bat: valida las claves recibidas por variables de entorno y escribe .env
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUrl, validateKey } from './lib.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const url = validateUrl(process.env.DEP_URL); const key = validateKey(process.env.DEP_KEY);
  const p = join(root, '.env');
  if (existsSync(p) && process.env.DEP_OVERWRITE !== '1') { console.error('El archivo .env ya existe y no se autorizó sobrescribirlo.'); process.exit(2); }
  writeFileSync(p, `SUPABASE_URL=${url}\nSUPABASE_ANON_KEY=${key}\nCURRENCY=ARS\nLOCALE=es-AR\n`);
  console.log('✔ Configuración guardada en .env (no se sube a GitHub).');
} catch (e) { console.error('✖ ' + e.message); process.exit(1); }
