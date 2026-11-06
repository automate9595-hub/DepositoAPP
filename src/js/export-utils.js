// Utilidades puras (sin DOM) para exportar a CSV y armar el texto / remito de un pedido. Se prueban con node --test.
import { esc, money, dateOnly, timeOnly, statusLabel, orderClient } from './format.js';

// Evita "inyección de fórmulas" en Excel: un texto que empieza con = + @ o - (no numérico) se antepone con apóstrofo
const safe = (v) => (typeof v === 'string' && /^([=+@\t\r]|-(?!\d))/.test(v) ? `'${v}` : v);
export const csvCell = (v) => {
  const s = String(safe(v) ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Separador ";" y BOM UTF-8: Excel en español abre el archivo con columnas y tildes correctas
export const toCsv = (header, rows) => '\ufeff' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');

// Cantidad "final" de un renglón según hasta dónde avanzó el pedido
export const finalQty = (i) => i.qty_delivered ?? i.qty_approved ?? i.qty_requested ?? 0;
export const finalTotal = (o) => o.total_delivered ?? o.total_approved ?? o.total_requested ?? 0;

export function orderText(o) {
  const lines = (o.items || []).map((i) => `• ${i.product_name} (${i.product_code}) × ${finalQty(i)} — ${money(i.unit_price * finalQty(i))}`);
  return [
    `*Pedido número ${o.order_number}*`,
    `Cliente: ${orderClient(o)}`,
    o.supplier ? `Proveedor: ${o.supplier}` : null,
    `Fecha: ${dateOnly(o.created_at)} ${timeOnly(o.created_at)}`,
    `Estado: ${statusLabel(o.status)}`,
    '',
    ...lines,
    '',
    `*Total: ${money(finalTotal(o))}*`,
  ].filter((x) => x !== null).join('\n');
}

// Remito imprimible (HTML autónomo)
export function remitoHtml(o) {
  const rows = (o.items || []).map((i) => `<tr><td>${esc(i.product_code)}</td><td>${esc(i.product_name)}</td><td class="n">${finalQty(i)}</td><td class="n">${esc(money(i.unit_price))}</td><td class="n">${esc(money(i.unit_price * finalQty(i)))}</td></tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Pedido ${esc(o.order_number)}</title>
<style>body{font:14px/1.4 system-ui,Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}p{margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #ccc;padding:6px 4px;text-align:left}th{background:#f1f1f1}.n{text-align:right;white-space:nowrap}
.tot{margin-top:14px;text-align:right;font-size:17px;font-weight:700}.firma{margin-top:60px;display:flex;gap:40px}.firma div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:12px}</style></head><body>
<h1>Pedido número ${esc(o.order_number)}</h1>
<p><b>Cliente:</b> ${esc(orderClient(o))}</p>${o.supplier ? `<p><b>Proveedor:</b> ${esc(o.supplier)}</p>` : ''}
<p><b>Fecha:</b> ${esc(dateOnly(o.created_at))} ${esc(timeOnly(o.created_at))} · <b>Estado:</b> ${esc(statusLabel(o.status))}</p>
<table><thead><tr><th>Código</th><th>Producto</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Subtotal</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot">Total: ${esc(money(finalTotal(o)))}</div>
<div class="firma"><div>Entregó</div><div>Recibió (firma y aclaración)</div></div></body></html>`;
}

// Umbral de "stock bajo" (se guarda por dispositivo)
export const DEFAULT_LOW = 5;
export const parseLow = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : DEFAULT_LOW; };
