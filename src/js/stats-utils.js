// Utilidades puras de períodos y series para Estadísticas (se prueban con node --test)
const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; };

export const PERIODS = [
  { key: 'hoy', label: 'Hoy' }, { key: '7d', label: '7 días' }, { key: '30d', label: '30 días' }, { key: '90d', label: '90 días' },
  { key: 'mes', label: 'Este mes' }, { key: 'mes_ant', label: 'Mes anterior' }, { key: 'anio', label: 'Este año' }, { key: 'custom', label: 'Personalizado' },
];

export function periodRange(key, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (key) {
    case 'hoy': return { from: iso(t), to: iso(t) };
    case '7d': return { from: iso(addDays(t, -6)), to: iso(t) };
    case '90d': return { from: iso(addDays(t, -89)), to: iso(t) };
    case 'mes': return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) };
    case 'mes_ant': return { from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
    case 'anio': return { from: iso(new Date(t.getFullYear(), 0, 1)), to: iso(t) };
    case '30d': default: return { from: iso(addDays(t, -29)), to: iso(t) };
  }
}
export const daysBetween = (from, to) => Math.round((parseISO(to) - parseISO(from)) / 86400000) + 1;
export function previousRange({ from, to }) {
  const n = daysBetween(from, to); const f = parseISO(from);
  return { from: iso(addDays(f, -n)), to: iso(addDays(f, -1)) };
}
export const granularityFor = (days) => (days <= 45 ? 'day' : days <= 200 ? 'week' : 'month');

const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7)); // lunes
export function bucketSeries(series, gran) {
  const out = new Map();
  for (const p of series) {
    const d = parseISO(p.d);
    const k = gran === 'day' ? iso(d) : gran === 'week' ? iso(weekStart(d)) : iso(new Date(d.getFullYear(), d.getMonth(), 1));
    const b = out.get(k) || { key: k, orders: 0, revenue: 0, cost: 0 };
    b.orders += Number(p.orders || 0); b.revenue += Number(p.revenue || 0); b.cost += Number(p.cost || 0);
    out.set(k, b);
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, profit: b.revenue - b.cost }));
}

export function niceScale(max, count = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / count; const mag = 10 ** Math.floor(Math.log10(raw)); const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag; const top = Math.ceil(max / step - 1e-9) * step; const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: top, step, ticks };
}

// Variación porcentual contra el período anterior (null si no hay base de comparación)
export const delta = (cur, prev) => { const p = Number(prev || 0); return p > 0 ? ((Number(cur || 0) - p) / p) * 100 : null; };

export function bucketLabel(key, gran, locale = 'es-AR') {
  const d = parseISO(key);
  if (gran === 'month') return d.toLocaleDateString(locale, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
export function bucketTitle(key, gran, locale = 'es-AR') {
  const d = parseISO(key);
  if (gran === 'month') return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  if (gran === 'week') return 'Semana del ' + d.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}
