// Cliente de Supabase. Solo usa la clave pública (anon/publishable); la seguridad real son las políticas RLS.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const cfg = window.APP_CONFIG || {};
export const config = cfg;
function isPrivateKey(k) {
  if (/^sb_secret_/.test(k)) return true;
  try { return JSON.parse(atob(String(k).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === ('service' + '_role'); } catch { return false; }
}
export const configured = Boolean(!isPrivateKey(cfg.SUPABASE_ANON_KEY || '') &&
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/TU-PROYECTO|your-project/i.test(cfg.SUPABASE_URL),
);

const common = { detectSessionInUrl: false };
export const supabase = configured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { ...common, persistSession: true, autoRefreshToken: true, storageKey: 'deposito-auth' },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

// Cliente aislado (sin guardar sesión) para registrar usuarios nuevos sin cerrar la sesión del administrador
export const createIsolatedClient = () =>
  createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { ...common, persistSession: false, autoRefreshToken: false, storageKey: 'deposito-alta-usuario' },
  });
