import { supabase } from './supa.js';

export class AppError extends Error {
  constructor(message, { network = false, code = '' } = {}) { super(message); this.network = network; this.code = code; }
}

const NET_RE = /failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|timed out/i;

// Convierte errores de Postgres/Supabase en mensajes claros en español
export function toAppError(err) {
  if (err instanceof AppError) return err;
  const raw = String(err?.message || err || 'Error desconocido');
  if (NET_RE.test(raw) || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return new AppError('Sin conexión con el servidor. La operación NO se realizó. Revise su Internet e intente de nuevo.', { network: true });
  }
  const m = raw.match(/^([A-Z_]{4,}):\s*([\s\S]+)$/);
  if (m) return new AppError(m[2], { code: m[1] });
  const code = err?.code || '';
  if (code === '23505') return new AppError('Ya existe un registro con ese valor (por ejemplo, un código repetido).', { code });
  if (code === '23514') return new AppError('Los datos no cumplen las reglas (por ejemplo, valores negativos).', { code });
  if (code === '23503') return new AppError('El registro está relacionado con otros datos y no se puede modificar así.', { code });
  if (code === '42501' || /row-level security|permission denied/i.test(raw)) return new AppError('No tiene permiso para realizar esta operación.', { code: '42501' });
  if (/Invalid login credentials/i.test(raw)) return new AppError('Correo o contraseña incorrectos.', { code: 'auth' });
  if (/Email not confirmed/i.test(raw)) return new AppError('El correo aún no está confirmado. Pida al administrador desactivar la confirmación por correo en Supabase.', { code: 'auth' });
  if (/already registered|already been registered/i.test(raw)) return new AppError('Ese correo ya está registrado.', { code: 'auth' });
  if (/Password should be at least/i.test(raw)) return new AppError('La contraseña es demasiado corta (mínimo 8 caracteres).', { code: 'auth' });
  if (/rate limit|too many/i.test(raw)) return new AppError('Demasiados intentos. Espere un momento y vuelva a probar.', { code: 'rate' });
  return new AppError('No se pudo completar la operación: ' + raw.slice(0, 160), { code });
}
export const friendly = (e) => toAppError(e).message;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lecturas: se reintentan solo ante fallas de red. Escrituras: NUNCA se reintentan automáticamente
// (salvo submit_order, que es idempotente por client_request_id).
export async function read(run, { retries = 2 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await run(supabase);
      if (res.error) throw res.error;
      return res;
    } catch (e) {
      last = toAppError(e);
      if (!last.network || i === retries) break;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}

export async function rpc(name, args = {}, { retries = 0 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data, error } = await supabase.rpc(name, args);
      if (error) throw error;
      return data;
    } catch (e) {
      last = toAppError(e);
      if (!last.network || i === retries) break;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

export async function write(run) {
  try {
    const res = await run(supabase);
    if (res.error) throw res.error;
    return res;
  } catch (e) { throw toAppError(e); }
}
