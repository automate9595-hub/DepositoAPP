// Utilidades puras de formato (sin dependencias del navegador, se prueban con node --test)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currency = 'ARS';
let locale = 'es-AR';
export function setLocale(cur, loc) { if (cur) currency = cur; if (loc) locale = loc; }

export const money = (n) => {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n || 0)); }
  catch { return '$ ' + Number(n || 0).toFixed(2); }
};

export const dateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const STATUS = {
  PENDIENTE_APROBACION: { label: 'Pendiente de aprobación', cls: 's-warn' },
  APROBADO: { label: 'Aprobado', cls: 's-info' },
  EN_PREPARACION: { label: 'En preparación', cls: 's-info' },
  PREPARADO_PARCIALMENTE: { label: 'Preparado parcialmente', cls: 's-warn' },
  LISTO_PARA_ENTREGAR: { label: 'Listo para entregar', cls: 's-ok' },
  ENTREGADO: { label: 'Entregado', cls: 's-ok' },
  RECHAZADO: { label: 'Rechazado', cls: 's-bad' },
  CANCELADO: { label: 'Cancelado', cls: 's-idle' },
};
export const statusLabel = (s) => STATUS[s]?.label ?? s ?? '—';
export const statusBadge = (s) => `<span class="status ${STATUS[s]?.cls ?? 's-idle'}">${esc(statusLabel(s))}</span>`;

export const ROLES = {
  admin_principal: 'Administrador principal',
  admin_secundario: 'Segundo administrador',
  proveedor: 'Proveedor',
  deposito: 'Depósito',
};
export const roleLabel = (r) => ROLES[r] ?? 'Sin rol asignado';

export const PERMS = {
  orders: 'Pedidos', inventory: 'Inventario', products: 'Productos', stats: 'Estadísticas', users: 'Usuarios', audit: 'Auditoría',
};

// Quita caracteres que rompen los filtros de PostgREST (.or / ilike)
export const cleanSearch = (s) => String(s ?? '').replace(/[,()%*\\:"']/g, ' ').trim().slice(0, 60);

export function debounce(fn, ms = 350) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const one = (x) => (Array.isArray(x) ? x[0] : x) ?? null;
export const toInt = (v, def = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
