import { read, rpc, friendly } from '../api.js';
import { esc, money, STATUS, toInt, statusLabel, dateTime, one } from '../format.js';
import { orderToolsHtml, bindOrderTools, downloadCsv, fetchAll, stamp } from '../tools.js';
import { icon, $, $$, busy, ok, fail, emptyBox, errorBox, spinner, confirmBox, askText, modal } from '../ui.js';
import { state } from '../state.js';
import { fetchOrder, orderCard, historyHtml, summaryHtml, totals } from './order-common.js';
import { pickProducts } from './product-picker.js';
import { can } from '../state.js';

const PAGE = 20;
const FILTERS = [['PENDIENTE_APROBACION', 'Pendientes'], ['APROBADO', 'Aprobados'], ['EN_PREPARACION', 'En preparación'], ['PREPARADO_PARCIALMENTE', 'Parciales'],
  ['LISTO_PARA_ENTREGAR', 'Listos'], ['ENTREGADO', 'Entregados'], ['RECHAZADO', 'Rechazados'], ['CANCELADO', 'Cancelados'], ['', 'Todos']];

export async function adminOrdersView(el, ctx) {
  if (ctx.args[0]) return detail(el, ctx, ctx.args[0]);
  let st = sessionStorage.getItem('adm-filter') ?? 'PENDIENTE_APROBACION'; let page = 0; let rows = []; let gen = 0;
  el.innerHTML = `<div class="stack"><div class="chips">${FILTERS.map(([v, l]) => `<button class="chip ${v === st ? 'on' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
    <button class="btn sm block" id="exp" type="button">${icon('download')} Exportar a Excel (CSV)</button>
    <div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  async function exportCsv(btn) {
    await busy(btn, async () => {
      try {
        const all = await fetchAll((a, b) => read((s) => { let r = s.from('orders').select('order_number,status,customer_name,total_requested,total_approved,total_delivered,created_at,delivered_at,suppliers(company_name)').order('created_at', { ascending: false }).range(a, b); if (st) r = r.eq('status', st); return r; }));
        downloadCsv(`pedidos-${st ? st.toLowerCase() : 'todos'}-${stamp()}.csv`, ['Pedido', 'Fecha', 'Estado', 'Cliente', 'Proveedor', 'Total pedido', 'Total aprobado', 'Total entregado', 'Entregado el'],
          all.map((o) => [o.order_number, dateTime(o.created_at), statusLabel(o.status), o.customer_name || 'Cliente público general', one(o.suppliers)?.company_name || '', o.total_requested, o.total_approved ?? '', o.total_delivered ?? '', o.delivered_at ? dateTime(o.delivered_at) : '']));
        ok(`Se exportaron ${all.length} pedidos`);
      } catch (x) { fail(friendly(x)); }
    });
  }
  async function load(reset) {
    const my = ++gen; if (reset) { page = 0; rows = []; list.innerHTML = spinner(); }
    try {
      const { data } = await read((s) => {
        let b = s.from('orders').select('id,order_number,status,total_requested,total_approved,total_delivered,customer_name,created_at,suppliers(company_name)')
          .order('created_at', { ascending: st === 'PENDIENTE_APROBACION' }).range(page * PAGE, page * PAGE + PAGE - 1);
        if (st) b = b.eq('status', st); return b;
      });
      if (my !== gen) return;
      rows = rows.concat(data || []); more.classList.toggle('hidden', (data || []).length < PAGE);
      list.innerHTML = rows.length ? rows.map((o) => orderCard(o)).join('') : emptyBox('No hay pedidos en este estado.');
    } catch (e) { if (my === gen) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); } }
  }
  el.addEventListener('click', (e) => {
    if (e.target.closest('#exp')) { exportCsv(e.target.closest('#exp')); return; }
    const f = e.target.closest('[data-f]'); if (f) { st = f.dataset.f; sessionStorage.setItem('adm-filter', st); $$('.chip', el).forEach((c) => c.classList.toggle('on', c === f)); load(true); return; }
    const c = e.target.closest('[data-order]'); if (c) ctx.navigate('#/pedidos/' + c.dataset.order);
    if (e.target === more) { page += 1; load(false); }
  });
  await load(true);
  return { refresh: () => load(true), dispose: () => { gen++; } };
}

async function detail(el, ctx, id) {
  ctx.setTitle('Pedido');
  async function load() {
    try {
      const o = await fetchOrder(id);
      if (!ctx.seq()) return;
      if (!o) { el.innerHTML = emptyBox('El pedido no existe o no tiene acceso.'); return; }
      const ids = o.items.map((i) => i.product_id);
      const inv = ids.length ? (await read((s) => s.from('inventory').select('product_id,available_stock,physical_stock').in('product_id', ids))).data || [] : [];
      const av = Object.fromEntries(inv.map((r) => [r.product_id, r.available_stock]));
      let worker = '';
      if (o.assigned_to) { const w = await read((s) => s.from('profiles').select('full_name').eq('id', o.assigned_to).maybeSingle()).catch(() => null); worker = w?.data?.full_name || ''; }
      draw(o, av, worker);
    } catch (e) { el.innerHTML = errorBox(friendly(e)); $('[data-retry]', el)?.addEventListener('click', load); }
  }
  function draw(o, av, worker) {
    const pending = o.status === 'PENDIENTE_APROBACION';
    const editable = ['APROBADO', 'EN_PREPARACION', 'PREPARADO_PARCIALMENTE'].includes(o.status);
    const final = ['ENTREGADO', 'RECHAZADO', 'CANCELADO'].includes(o.status);
    const rowHtml = (i) => {
      const base = pending ? i.qty_requested : i.qty_approved ?? 0;
      const min = editable ? (i.qty_prepared ?? 0) : 0;
      const avail = av[i.product_id] ?? 0;
      const room = pending ? avail : avail + (i.qty_approved ?? 0);
      return `<div class="line" data-item="${i.id}"><div class="grow"><div class="pname">${esc(i.product_name)}</div>
        <div class="muted small mono">${esc(i.product_code)} · ${money(i.unit_price)} · pidió ${i.qty_requested}</div>
        ${(pending || editable) ? `<div class="small ${room < base ? '' : 'muted'}" style="${room < base ? 'color:var(--bad)' : ''}">Stock disponible${editable ? ' para este pedido' : ''}: ${room}</div>` : ''}
        ${i.prepared ? `<div class="small" style="color:var(--ok)">Preparado: ${i.qty_prepared}${i.shortage_reason ? ' · ' + esc(i.shortage_reason) : ''}</div>` : ''}
        ${i.qty_delivered != null ? `<div class="small">Entregado: <b>${i.qty_delivered}</b></div>` : ''}</div>
        ${(pending || editable) ? `<div class="stepper" style="width:120px"><button data-d="-1" aria-label="Quitar uno">−</button>
          <input inputmode="numeric" value="${base}" data-q data-min="${min}" data-max="${i.qty_requested}" data-orig="${base}" aria-label="Cantidad aprobada"><button data-d="1" aria-label="Agregar uno">+</button></div>`
          : `<div class="right mono small">Aprobado: <b>${i.qty_approved ?? '—'}</b></div>`}</div>`;
    };
    el.innerHTML = `<div class="stack"><a href="#/pedidos" class="small">← Pedidos</a>${summaryHtml(o)}
      ${worker ? `<p class="small muted">Preparado por: ${esc(worker)}</p>` : ''}
      ${o.customer_id && can('customers') ? `<a class="btn sm block" href="#/clientes/${o.customer_id}">Ver cuenta del cliente</a>` : ''}
      <div class="card">${o.items.map(rowHtml).join('')}<hr class="hr">${totals(o)}</div>
      ${orderToolsHtml()}
      ${(pending || editable) ? `<label class="field"><span>Observaciones</span><textarea id="obs" maxlength="500">${esc(o.admin_notes || '')}</textarea></label>` : ''}
      <div class="stack">
        ${pending ? '<button class="btn accent block" id="ap">Aprobar y reservar stock</button><button class="btn danger block" id="rj">Rechazar</button>' : ''}
        ${editable ? `<a class="btn accent block" href="#/preparacion/${id}">Preparar este pedido ahora</a>` : ''}
        ${(pending || editable) ? `<button class="btn block" id="addp">${icon('plus')} Agregar productos al pedido</button>` : ''}
        ${editable ? '<button class="btn primary block" id="md">Guardar cantidades modificadas</button><button class="btn block" id="as">Asignar / reasignar preparador</button>' : ''}
        ${o.status === 'LISTO_PARA_ENTREGAR' ? '<button class="btn accent block" id="dl">Confirmar entrega</button>' : ''}
        ${!final && !pending ? '<button class="btn danger block" id="cx">Cancelar pedido</button>' : ''}
        ${pending ? '<button class="btn ghost block" id="cx">Cancelar pedido</button>' : ''}
      </div>
      <div class="card"><h3 style="margin-bottom:8px">Historial</h3>${historyHtml(o)}</div></div>`;

    bindOrderTools(el, o);
    const items = () => $$('[data-item]', el).map((r) => ({ item_id: r.dataset.item, qty: toInt($('[data-q]', r).value) }));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const inp = $('[data-q]', b.closest('.stepper')); const lo = toInt(inp.dataset.min); const hi = toInt(inp.dataset.max);
      inp.value = Math.min(hi, Math.max(lo, toInt(inp.value) + toInt(b.dataset.d)));
    }, { signal: sig() });
    const obs = () => ($('#obs', el)?.value || '').trim() || null;
    const run = (sel, fn) => $(sel, el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (x) { fail(friendly(x)); await load(); } }));
    run('#ap', async () => { await rpc('approve_order', { p_order_id: id, p_items: items(), p_notes: obs() }); ok('Pedido aprobado y stock reservado'); await load(); });
    run('#rj', async () => { const r = await askText('Rechazar pedido', 'Motivo del rechazo', { okText: 'Rechazar' }); if (!r) return; await rpc('reject_order', { p_order_id: id, p_reason: r }); ok('Pedido rechazado'); await load(); });
    $('#addp', el)?.addEventListener('click', async () => {
      const picks = await pickProducts({ title: 'Agregar productos al pedido', hint: pending ? 'Se suman a lo pedido por el proveedor. El stock se reserva al aprobar.' : 'Se suman al pedido y se reserva el stock enseguida.' });
      if (!picks) return;
      try { await rpc('admin_add_order_items', { p_order_id: id, p_items: picks.map((p) => ({ product_id: p.product_id, qty: p.qty })) }); ok(`${picks.length} producto${picks.length === 1 ? '' : 's'} agregado${picks.length === 1 ? '' : 's'} al pedido`); await load(); }
      catch (x) { fail(friendly(x)); }
    });
    run('#md', async () => { await rpc('modify_approved_order', { p_order_id: id, p_items: items(), p_notes: obs() }); ok('Cantidades y reservas actualizadas'); await load(); });
    run('#dl', async () => { if (!(await confirmBox('Confirmar entrega', 'Se descontará del stock físico lo preparado y se liberará el resto de la reserva.', { okText: 'Confirmar entrega' }))) return; await rpc('confirm_delivery', { p_order_id: id }); ok('Entrega confirmada'); await load(); });
    run('#cx', async () => { const r = await askText('Cancelar pedido', 'Motivo (opcional)', { required: false, okText: 'Cancelar pedido' }); if (r === null) return; await rpc('cancel_order', { p_order_id: id, p_reason: r || null }); ok('Pedido cancelado y reservas liberadas'); await load(); });
    run('#as', async () => {
      const canPrep = true;
      const ws = (await read((s) => s.from('warehouse_workers').select('profile_id,display_name').eq('active', true).order('display_name'))).data || [];
      const sel = await modal(`<h2>Preparador</h2><label class="field"><span>Asignar a</span><select id="w"><option value="">Sin asignar</option>${canPrep ? `<option value="${state.profile.id}" ${state.profile.id === o.assigned_to ? 'selected' : ''}>Yo (administración)</option>` : ''}${ws.map((w) => `<option value="${w.profile_id}" ${w.profile_id === o.assigned_to ? 'selected' : ''}>${esc(w.display_name)}</option>`).join('')}</select></label>
        <div class="row" style="margin-top:16px"><button class="btn grow" data-close>Volver</button><button class="btn primary grow" id="okb">Guardar</button></div>`,
      { onMount: (ov, close) => $('#okb', ov).addEventListener('click', () => close({ v: $('#w', ov).value })) });
      if (!sel) return;
      await rpc('assign_order', { p_order_id: id, p_worker: sel.v || null }); ok('Asignación actualizada'); await load();
    });
  }
  let ac; const sig = () => { ac?.abort(); ac = new AbortController(); return ac.signal; };
  await load();
  return { refresh: load, dispose: () => ac?.abort() };
}
