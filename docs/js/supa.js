// Cliente de Supabase. Solo usa la clave pública (anon/publishable); la seguridad real son las políticas RLS.
//
// Cambios para evitar que la app se quede "cargando" para siempre:
//  1) La librería se pide a varias CDN (si una falla o está bloqueada, prueba la siguiente) con tiempo límite.
//  2) El cliente NO usa navigator.locks: en Android/PWA un bloqueo huérfano (app cerrada a la fuerza) dejaba
//     colgado getSession() e iniciar sesión para siempre.
//  3) Toda petición HTTP tiene tiempo límite, así nunca queda una pantalla esperando sin fin.

const cfg = window.APP_CONFIG || {};
export const config = cfg;

const LIB_VERSION = '2.45.4';
const LIB_URLS = [
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${LIB_VERSION}/+esm`,
  `https://esm.sh/@supabase/supabase-js@${LIB_VERSION}`,
  `https://unpkg.com/@supabase/supabase-js@${LIB_VERSION}/dist/module/index.js?module`,
];
const LIB_TIMEOUT_MS = 7000;
export const REQUEST_TIMEOUT_MS = 20000;

function isPrivateKey(k) {
  if (/^sb_secret_/.test(k)) return true;
  try { return JSON.parse(atob(String(k).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === ('service' + '_role'); } catch { return false; }
}
export const configured = Boolean(!isPrivateKey(cfg.SUPABASE_ANON_KEY || '') &&
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/TU-PROYECTO|your-project/i.test(cfg.SUPABASE_URL),
);

const withTimeout = (p, ms, msg) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(msg)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

async function loadLib() {
  let last;
  for (const url of LIB_URLS) {
    try { return await withTimeout(import(/* @vite-ignore */ url), LIB_TIMEOUT_MS, 'timeout cargando la librería'); }
    catch (e) { last = e; console.warn('No se pudo cargar la librería desde', url, e); }
  }
  throw last || new Error('No se pudo cargar la librería');
}

// Lock sin navigator.locks: ejecuta la función directamente (la app usa una sola pestaña por sesión)
const noLock = async (_name, _timeout, fn) => fn();

// fetch con tiempo límite (no corta el realtime, que usa WebSocket)
function timedFetch(input, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  if (init.signal) { if (init.signal.aborted) ctrl.abort(); else init.signal.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  return fetch(input, { ...init, signal: ctrl.signal })
    .catch((e) => { throw e?.name === 'AbortError' ? new Error('timeout: el servidor tardó demasiado en responder') : e; })
    .finally(() => clearTimeout(t));
}

export let libError = null;
let createClient = null;
if (configured) {
  try { ({ createClient } = await loadLib()); }
  catch (e) { libError = e; console.error(e); }
}

const authOpts = { detectSessionInUrl: false, lock: noLock };
export const supabase = configured && createClient
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { ...authOpts, persistSession: true, autoRefreshToken: true, storageKey: 'deposito-auth' },
      global: { fetch: timedFetch },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

// Cliente aislado (sin guardar sesión) para registrar usuarios nuevos sin cerrar la sesión del administrador
export const createIsolatedClient = () =>
  createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { ...authOpts, persistSession: false, autoRefreshToken: false, storageKey: 'deposito-alta-usuario' },
    global: { fetch: timedFetch },
  });

// Sesión guardada en el dispositivo (plan B si getSession() no responde a tiempo)
export function storedSession() {
  try {
    const s = JSON.parse(localStorage.getItem('deposito-auth'));
    return s?.user && s?.access_token ? s : null;
  } catch { return null; }
}
export { withTimeout };
