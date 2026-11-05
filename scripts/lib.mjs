import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function validateUrl(u) {
  const url = String(u || '').trim().replace(/\/+$/, '');
  if (!url || /TU-PROYECTO|your-project/i.test(url)) throw new Error('Falta la URL del proyecto de Supabase (SUPABASE_URL).');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(url)) throw new Error('SUPABASE_URL debe empezar con https:// y no tener rutas (ej.: https://abcdxyz.supabase.co).');
  return url;
}

// Acepta solo claves PÚBLICAS. Rechaza service_role / secret.
export function validateKey(k) {
  const key = String(k || '').trim();
  if (!key) throw new Error('Falta la clave pública de Supabase (SUPABASE_ANON_KEY).');
  if (/^sb_secret_/.test(key)) throw new Error('Esa es una clave SECRETA de Supabase. Use la clave pública (anon / publishable). No la publique nunca.');
  if (/^sb_publishable_/.test(key)) return key;
  const parts = key.split('.');
  if (parts.length !== 3) throw new Error('La clave no tiene formato válido (debe ser la clave "anon public" de Supabase).');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new Error('La clave no tiene formato válido.'); }
  if (payload.role === 'service_role') throw new Error('Esa es la clave service_role (administrativa). NUNCA debe ir en la aplicación. Use la clave "anon public".');
  if (payload.role !== 'anon') throw new Error(`La clave tiene un rol inesperado (${payload.role}). Use la clave "anon public".`);
  return key;
}

export function normalizeRepo(input) {
  let s = String(input || '').trim();
  const ssh = s.match(/^git@github\.com:(.+)$/i);
  if (ssh) s = 'https://github.com/' + ssh[1];
  s = s.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = s.match(/^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  if (!m) throw new Error('La dirección debe ser del tipo github.com/usuario/repositorio');
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], name: m[2], pages: `https://${m[1].toLowerCase()}.github.io/${m[2]}/` };
}
export const rootDir = (importMetaUrl) => join(new URL('.', importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
