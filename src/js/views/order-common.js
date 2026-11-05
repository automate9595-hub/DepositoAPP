import { read } from '../api.js';
import { esc, money, dateTime, statusBadge, statusLabel, one } from '../format.js';

export const ORDER_SELECT = 'id,order_number,status,supplier_notes,admin_notes,total_requested,total_approved,total_delivered,assigned_to,created_at,approved_at,prepared_at,delivered_at,suppliers(company_name)';

export async function fetchOrder(id) {
  const [o, items, hist] = await Promise.all([
    read((s) => s.from('orders').select(ORDER_SELECT).eq('id', id).maybeSingle()),
    read((s) => s.from('order_items').select('id,product_id,product_code,product_name,unit_price,qty_requested,qty_approved,qty_prepared,qty_delivered,prepared,shortage_reason').eq('order_id', id).order('product_name')),
    read((s) => s.from('order_status_history').select('to_status,note,created_at').eq('order_id', id).order('created_at')),
  ]);
  if (!o.data) return null;
  return { ...o.data, supplier: one(o.data.suppliers)?.company_name ?? '—', items: items.data || [], history: hist.data || [] };
}

export function orderCard(o, extra = '') {
  return `<div class="card click" data-order="${o.id}">
    <div class="row between"><b>Pedido #${o.order_number}</b>${statusBadge(o.status)}</div>
    ${o.suppliers ? `<div class="ellipsis">${esc(one(o.suppliers)?.company_name ?? '')}</div>` : ''}
    <div class="row between muted small"><span>${dateTime(o.created_at)}</span>
    <b class="mono" style="color:var(--text)">${money(o.total_delivered ?? o.total_approved ?? o.total_requested)}</b></div>${extra}</div>`;
}

export function historyHtml(o) {
  return `<div class="timeline">${o.history.map((h) => `<div><b>${esc(statusLabel(h.to_status))}</b> <span class="muted small">${dateTime(h.created_at)}</span>${h.note ? `<div class="muted small">${esc(h.note)}</div>` : ''}</div>`).join('')}</div>`;
}

export function summaryHtml(o) {
  return `<div class="card stack">
    <div class="row between"><h2>Pedido #${o.order_number}</h2>${statusBadge(o.status)}</div>
    <div class="kv small"><span class="muted">Proveedor</span><span>${esc(o.supplier)}</span>
      <span class="muted">Fecha</span><span>${dateTime(o.created_at)}</span>
      ${o.delivered_at ? `<span class="muted">Entregado</span><span>${dateTime(o.delivered_at)}</span>` : ''}</div>
    ${o.supplier_notes ? `<p class="small"><span class="muted">Nota del proveedor:</span> ${esc(o.supplier_notes)}</p>` : ''}
    ${o.admin_notes ? `<p class="small"><span class="muted">Observaciones:</span> ${esc(o.admin_notes)}</p>` : ''}</div>`;
}

export const totals = (o) => `<div class="kv"><span class="muted">Total pedido</span><b class="mono">${money(o.total_requested)}</b>
  ${o.total_approved != null ? `<span class="muted">Total aprobado</span><b class="mono">${money(o.total_approved)}</b>` : ''}
  ${o.total_delivered != null ? `<span class="muted">Total entregado</span><b class="mono total">${money(o.total_delivered)}</b>` : ''}</div>`;
