// Utilidades puras de respaldos (sin dependencias del navegador: se prueban con node --test)

export const GROUPS = [
  { id: 'catalog', icon: 'box', label: 'Productos, categorías, costos e inventario', tables: ['categories', 'products', 'product_costs', 'inventory'] },
  { id: 'orders', icon: 'clip', label: 'Pedidos, detalles e historial de estados', tables: ['orders', 'order_items', 'order_item_costs', 'order_transitions', 'order_status_history'] },
  { id: 'stock', icon: 'layers', label: 'Reservas y movimientos de stock', tables: ['stock_reservations', 'stock_movements'] },
  { id: 'customers', icon: 'users', label: 'Clientes, cuentas corrientes, movimientos y pagos', tables: ['customers', 'customer_movements', 'order_payments'] },
  { id: 'people', icon: 'user', label: 'Usuarios del negocio, proveedores, depósito y roles', tables: ['profiles', 'suppliers', 'warehouse_workers', 'roles'] },
  { id: 'system', icon: 'bell', label: 'Notificaciones y auditoría', tables: ['notifications', 'audit_logs', 'backup_settings', 'backup_runs'] },
];

// Tablas que la restauración sabe cargar (backup_runs es solo historial del servidor y no se restaura).
export const RESTORABLE = GROUPS.flatMap((g) => g.tables).filter((t) => t !== 'backup_runs');

export const FORMAT = 'depositoapp-backup';

// Ruta segura dentro del bucket de fotografías: sin «..», sin barras iniciales ni caracteres de control.
export function safePhotoPath(p) {
  if (typeof p !== 'string') return null;
  const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.length > 300) return null;
  if (clean.split('/').some((s) => !s || s === '.' || s === '..')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(clean)) return null;
  return clean;
}

// Lee el texto de un respaldo (manual v2, o automático v1) y lo valida.
// Devuelve { ok:false, error } o { ok:true, meta, tables, photos, ignored, totalRows }.
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'El archivo está vacío.' };
  let data;
  try { data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { return { ok: false, error: 'El archivo no es un respaldo válido (no se pudo leer el contenido JSON).' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== FORMAT) {
    return { ok: false, error: 'Este archivo no es un respaldo de DepositoAPP.' };
  }
  const raw = data.tables ?? data.database_tables;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'El respaldo no contiene tablas de datos.' };

  const tables = {}; const ignored = [];
  for (const [name, rows] of Object.entries(raw)) {
    if (name === 'backup_runs') continue;                       // historial del servidor: nunca se restaura
    if (!RESTORABLE.includes(name)) { ignored.push(name); continue; }
    if (!Array.isArray(rows)) return { ok: false, error: `La tabla «${name}» del respaldo está dañada.` };
    tables[name] = rows;
  }
  const photos = [];
  const files = data.storage?.files;
  if (Array.isArray(files)) {
    for (const f of files) {
      const path = safePhotoPath(f?.path);
      if (path && typeof f.base64 === 'string' && f.base64.length) photos.push({ path, content_type: f.content_type || 'image/jpeg', base64: f.base64 });
    }
  }
  const totalRows = Object.values(tables).reduce((n, rows) => n + rows.length, 0);
  if (!totalRows && !photos.length) return { ok: false, error: 'El respaldo no contiene ningún dato para restaurar.' };
  return {
    ok: true, tables, photos, ignored, totalRows,
    meta: {
      createdAt: data.created_at || data.generated_at || null,
      version: Number(data.format_version) || 1,
      kind: data.created_at ? 'manual' : 'automatic',
    },
  };
}

// Resumen por grupo (para mostrar qué trae el archivo)
export function summarize(tables) {
  return GROUPS.map((g) => {
    const present = g.tables.filter((t) => Array.isArray(tables[t]));
    return { id: g.id, icon: g.icon, label: g.label, tables: present, rows: present.reduce((n, t) => n + tables[t].length, 0) };
  }).filter((g) => g.tables.length);
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(v < 10485760 ? 1 : 0)} MB`;
  return `${(v / 1073741824).toFixed(1)} GB`;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Nombres de tablas amigables para el informe final
export const TABLE_LABELS = {
  roles: 'Roles', order_transitions: 'Transiciones de pedido', profiles: 'Usuarios', suppliers: 'Proveedores', warehouse_workers: 'Personal de depósito',
  categories: 'Categorías', products: 'Productos', inventory: 'Inventario', product_costs: 'Costos', customers: 'Clientes', orders: 'Pedidos',
  order_items: 'Detalle de pedidos', order_item_costs: 'Costos de pedidos', stock_reservations: 'Reservas', stock_movements: 'Movimientos de stock',
  order_status_history: 'Historial de estados', notifications: 'Notificaciones', audit_logs: 'Auditoría', customer_movements: 'Cuenta corriente',
  order_payments: 'Pagos', backup_settings: 'Ajustes de respaldo',
};
