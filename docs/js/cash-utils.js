// Arqueo de caja: lógica pura (sin DOM) para el informe del día, el cálculo del cierre y el comprobante.
import { money, dateOnly, timeOnly, esc } from './format.js';

export const AR_TZ = 'America/Argentina/Buenos_Aires';
export const METHODS = [
  { key: 'Efectivo', color: '#2f9e6b', icon: 'cash' },
  { key: 'Mercado Pago', color: '#009ee3', icon: 'wallet' },
  { key: 'Transferencia', color: '#2b7bb9', icon: 'send' },
  { key: 'Tarjeta', color: '#8a5cc7', icon: 'card' },
  { key: 'Cheque', color: '#e0a526', icon: 'file' },
  { key: 'Otro', color: '#7c8a93', icon: 'coins' },
];

// Fecha de hoy en Argentina (AAAA-MM-DD), sin depender de la zona del dispositivo
export function todayAR(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AR_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function shiftDay(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const utcDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const fmtDayLong = (iso) => utcDate(iso).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const fmtDayShort = (iso) => utcDate(iso).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace('.', '');

// "1.234,50" / "1234.5" / "$ 1 234" → número (o null si está vacío o no es válido)
export function parseMoney(v) {
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1 || /^-?\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');   // 12.500 = doce mil quinientos
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Segmentos para el gráfico de anillo
export const methodSegments = (by = {}) => METHODS.map((m) => ({ label: m.key, value: Number(by[m.key] || 0), color: m.color })).filter((s) => s.value > 0);

// Arqueo: efectivo esperado = fondo inicial + cobros en efectivo − retiros; diferencia = contado − esperado
export function calcArqueo({ opening = 0, withdrawals = 0, cashIncome = 0, counted = null } = {}) {
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const expected = r2(r2(opening) + r2(cashIncome) - r2(withdrawals));
  if (counted === null || counted === undefined || counted === '' || Number.isNaN(Number(counted))) return { expected, difference: null, state: 'pending' };
  const difference = r2(Number(counted) - expected);
  return { expected, difference, state: difference === 0 ? 'ok' : difference > 0 ? 'over' : 'short' };
}
// Mercado Pago: saldo esperado = saldo inicial + cobrado − retención (% de lo cobrado por Mercado Pago)
export function calcMp({ opening = 0, gross = 0, pct = 0, counted = null } = {}) {
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const retention = r2(r2(gross) * Number(pct || 0) / 100);
  const net = r2(r2(gross) - retention);
  const expected = r2(r2(opening) + net);
  if (counted === null || counted === undefined || counted === '' || Number.isNaN(Number(counted))) return { retention, net, expected, difference: null, state: 'pending' };
  const difference = r2(Number(counted) - expected);
  return { retention, net, expected, difference, state: difference === 0 ? 'ok' : difference > 0 ? 'over' : 'short' };
}
export const ARQUEO_LABEL = { pending: 'Falta contar el efectivo', ok: 'La caja cuadra', over: 'Sobra dinero', short: 'Falta dinero' };

// Texto para compartir (WhatsApp, correo…)
export function receiptText(rep, arq, { opening = 0, withdrawals = 0, counted = null, countedMp = null, notes = '', who = '', title = 'Arqueo de caja' } = {}) {
  const by = rep.by_method || {};
  const lines = [`*${title}*`, `Fecha: ${fmtDayLong(rep.day)}`, '', '*Ingresos del día*'];
  for (const m of METHODS) if (Number(by[m.key] || 0) > 0) lines.push(`• ${m.key}: ${money(by[m.key])}`);
  if (!Object.values(by).some((v) => Number(v) > 0)) lines.push('• Sin cobros registrados');
  lines.push(`*Total cobrado: ${money(rep.total)}* (${rep.count} cobro${rep.count === 1 ? '' : 's'})`);
  if (Number(rep.delivered_count) > 0) lines.push(`Pedidos entregados: ${rep.delivered_count} por ${money(rep.delivered_total)}`);
  lines.push('', '*Arqueo de efectivo*', `Fondo inicial: ${money(opening)}`, `+ Cobros en efectivo: ${money(by.Efectivo || 0)}`, `− Retiros / gastos: ${money(withdrawals)}`, `= Efectivo esperado: ${money(arq.expected)}`);
  if (arq.state !== 'pending') lines.push(`Efectivo contado: ${money(counted)}`, `${ARQUEO_LABEL[arq.state]}${arq.difference ? `: ${money(Math.abs(arq.difference))}` : ''}`);
  const mpOn = rep.mp && (Number(rep.mp.gross) > 0 || Number(rep.mp.opening) > 0 || (countedMp !== null && countedMp !== ''));
  if (mpOn) {
    const mp = calcMp({ opening: rep.mp.opening, gross: rep.mp.gross, pct: rep.mp.pct, counted: countedMp });
    lines.push('', '*Mercado Pago*', `Saldo inicial: ${money(rep.mp.opening)}`, `+ Cobrado: ${money(rep.mp.gross)}`, `− Retención (${rep.mp.pct}%): ${money(mp.retention)}`, `= Saldo esperado: ${money(mp.expected)}`);
    if (mp.state !== 'pending') lines.push(`Saldo real: ${money(countedMp)}`, `${ARQUEO_LABEL[mp.state]}${mp.difference ? `: ${money(Math.abs(mp.difference))}` : ''}`);
  }
  if (notes) lines.push('', `Nota: ${notes}`);
  if (who) lines.push('', `Cerró: ${who}`);
  return lines.join('\n');
}

// Comprobante imprimible (HTML autónomo, listo para imprimir o guardar como PDF)
export function receiptHtml(rep, arq, { opening = 0, withdrawals = 0, counted = null, countedMp = null, notes = '', who = '', business = 'Depósito', closedAt = null } = {}) {
  const by = rep.by_method || {};
  const rows = METHODS.filter((m) => Number(by[m.key] || 0) > 0).map((m) => `<tr><td>${esc(m.key)}</td><td class="n">${esc(money(by[m.key]))}</td></tr>`).join('') || '<tr><td colspan="2">Sin cobros registrados</td></tr>';
  const pays = (rep.payments || []).map((p) => `<tr><td>${esc(timeOnly(p.at))}</td><td>${p.order_number ? `Pedido ${esc(p.order_number)} · ` : 'Pago a cuenta · '}${esc(p.customer || '')}${p.preventista ? ` <small>(${esc(p.preventista)})</small>` : ''}</td><td>${esc(p.method)}</td><td class="n">${esc(money(p.amount))}</td></tr>`).join('');
  const verdict = arq.state === 'pending' ? 'Pendiente de contar' : `${ARQUEO_LABEL[arq.state]}${arq.difference ? ': ' + money(Math.abs(arq.difference)) : ''}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Arqueo de caja ${esc(rep.day)}</title>
<style>body{font:14px/1.45 system-ui,Arial,sans-serif;margin:28px;color:#111}h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 6px;border-bottom:2px solid #111;padding-bottom:3px}
.sub{color:#555;margin:2px 0 0}table{width:100%;border-collapse:collapse}td,th{padding:5px 4px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}
.big{font-size:24px;font-weight:800;text-align:right;margin-top:8px}.box{border:2px solid #111;border-radius:8px;padding:10px 14px;margin-top:10px;font-weight:700;text-align:center}
.firma{margin-top:64px;display:flex;gap:40px}.firma div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:12px}small{color:#555}</style></head><body>
<h1>${esc(business)} · Arqueo de caja</h1><p class="sub">${esc(fmtDayLong(rep.day))}${closedAt ? ` · cerrado ${esc(dateOnly(closedAt))} ${esc(timeOnly(closedAt))}` : ''}${who ? ` · por ${esc(who)}` : ''}</p>
<h2>Ingresos por medio de pago</h2><table>${rows}</table><div class="big">Total cobrado: ${esc(money(rep.total))}</div>
${Number(rep.delivered_count) > 0 ? `<p class="sub">Pedidos entregados: ${esc(rep.delivered_count)} por ${esc(money(rep.delivered_total))}</p>` : ''}
<h2>Arqueo de efectivo</h2><table>
<tr><td>Fondo inicial</td><td class="n">${esc(money(opening))}</td></tr><tr><td>+ Cobros en efectivo</td><td class="n">${esc(money(by.Efectivo || 0))}</td></tr>
<tr><td>− Retiros / gastos</td><td class="n">${esc(money(withdrawals))}</td></tr><tr><td><b>= Efectivo esperado</b></td><td class="n"><b>${esc(money(arq.expected))}</b></td></tr>
<tr><td>Efectivo contado</td><td class="n">${counted === null || counted === '' ? '—' : esc(money(counted))}</td></tr></table>
<div class="box">${esc(verdict)}</div>
${rep.mp && (Number(rep.mp.gross) > 0 || Number(rep.mp.opening) > 0 || (countedMp !== null && countedMp !== '')) ? (() => { const mp = calcMp({ opening: rep.mp.opening, gross: rep.mp.gross, pct: rep.mp.pct, counted: countedMp });
  return `<h2>Mercado Pago</h2><table><tr><td>Saldo inicial</td><td class="n">${esc(money(rep.mp.opening))}</td></tr><tr><td>+ Cobrado</td><td class="n">${esc(money(rep.mp.gross))}</td></tr>
<tr><td>− Retención (${esc(rep.mp.pct)}%)</td><td class="n">${esc(money(mp.retention))}</td></tr><tr><td><b>= Saldo esperado</b></td><td class="n"><b>${esc(money(mp.expected))}</b></td></tr>
<tr><td>Saldo real</td><td class="n">${countedMp === null || countedMp === '' ? '—' : esc(money(countedMp))}</td></tr></table>${mp.state === 'pending' ? '' : `<div class="box">${esc(ARQUEO_LABEL[mp.state])}${mp.difference ? ': ' + esc(money(Math.abs(mp.difference))) : ''}</div>`}`; })() : ''}
${notes ? `<p><b>Nota:</b> ${esc(notes)}</p>` : ''}
${pays ? `<h2>Detalle de cobros</h2><table><tr><th>Hora</th><th>Concepto</th><th>Medio</th><th class="n">Importe</th></tr>${pays}</table>` : ''}
<div class="firma"><div>Cerró la caja</div><div>Controló (firma y aclaración)</div></div></body></html>`;
}
