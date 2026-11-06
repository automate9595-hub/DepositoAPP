import { read, rpc, friendly } from '../api.js';
import { esc, money, dateTime, one, toInt } from '../format.js';
import { state } from '../state.js';
import { $, $$, busy, ok, fail, emptyBox, errorBox, spinner, modal, confirmBox } from '../ui.js';
import { fetchOrder, orderCard, historyHtml, summaryHtml } from './order-common.js';

const TABS = [['todo', 'Por preparar', ['APROBADO']], ['curso', 'En preparación', ['EN_PREPARACION', 'PREPARADO_PARCIALMENTE']], ['listo', 'Listos', ['LISTO_PARA_ENTREGAR']]];

export async function warehouseOrdersView(el, ctx) {
  if (ctx.args[0]) return detail(el, ctx, ctx.args[0]);
  const base = '#/' + (ctx.path || 'pedidos');
  let tab = sessionStorage.getItem('wh-tab') || 'todo'; let gen = 0;
  el.innerHTML = `<div class="stack"><div class="chips">${TABS.map(([k, l]) => `<button class="chip ${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="l" class="list"></div></div>`;
  const list = $('#l', el);
  async function load() {
    const my = ++gen; const sts = TABS.find((t) => t[0] === tab)[2];
    try {
      const { data } = await read((s) => s.from('orders').select('id,order_number,status,total_approved,total_requested,customer_name,created_at,assigned_to,suppliers(company_name)').in('status', sts).order('created_at', { ascending: true }).limit(100));
      if (my !== gen) return;
      list.innerHTML = (data || []).length ? data.map((o) => orderCard(o, o.assigned_to === state.profile.id ? '<div class="small" style="color:var(--ok)">Asignado a usted</div>' : o.assigned_to ? '<div class="small muted">Asignado a otra persona</div>' : '')).join('') : emptyBox('No hay pedidos en esta lista.');
    } catch (e) { if (my === gen) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', load); } }
  }
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; sessionStorage.setItem('wh-tab', tab); $$('.chip', el).forEach((c) => c.classList.toggle('on', c === t)); list.innerHTML = spinner(); load(); return; }
    const c = e.target.closest('[data-order]'); if (c) ctx.navigate(base + '/' + c.dataset.order);
  });
  list.innerHTML = spinner(); await load();
  return { refresh: load, dispose: () => { gen++; } };
}

async function detail(el, ctx, id) {
  ctx.setTitle('Preparar pedido');
  const base = '#/' + (ctx.path || 'pedidos');
  const isAdm = ['admin_principal', 'admin_secundario'].includes(state.profile.role);
  async function load() {
    try {
      const o = await fetchOrder(id);
      if (!ctx.seq()) return;
      if (!o) { el.innerHTML = emptyBox('El pedido no existe o no tiene acceso.'); return; }
      draw(o);
    } catch (e) { el.innerHTML = errorBox(friendly(e)); $('[data-retry]', el)?.addEventListener('click', load); }
  }
  function draw(o) {
    const mine = o.assigned_to === state.profile.id;
    const working = ['EN_PREPARACION', 'PREPARADO_PARCIALMENTE'].includes(o.status);
    const items = o.items.filter((i) => (i.qty_approved ?? 0) > 0);
    const allDone = items.every((i) => i.prepared);
    const doneN = items.filter((i) => i.prepared).length; const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;
    el.innerHTML = `<div class="stack"><div class="row between"><a href="${base}" class="small">← ${isAdm ? 'Preparación' : 'Pedidos'}</a>${isAdm ? `<a href="#/pedidos/${id}" class="small">Ver ficha del pedido</a>` : ''}</div>${summaryHtml(o)}
      ${working ? `<div class="card stack"><div class="row between small"><b>Progreso de preparación</b><span class="mono muted">${doneN} de ${items.length} · ${pct}%</span></div><div class="progress"><i style="width:${pct}%"></i></div></div>` : ''}
      ${working && !mine ? `<p class="notice">${o.assigned_to ? 'Este pedido lo prepara otra persona.' : 'Pedido sin asignar.'}</p>` : ''}
      <div class="card">${items.map((i) => `<div class="line" data-item="${i.id}" data-ap="${i.qty_approved}" data-name="${esc(i.product_name)}">
        <div class="grow"><div class="pname">${esc(i.product_name)}</div><div class="muted small">${esc(i.product_code)}</div>
          <div class="mono">Cantidad: <b style="font-size:1.15rem">${i.qty_approved}</b></div>
          ${i.prepared ? `<div class="small" style="color:${i.qty_prepared < i.qty_approved ? 'var(--warn)' : 'var(--ok)'}">Preparado: ${i.qty_prepared}${i.shortage_reason ? ' · ' + esc(i.shortage_reason) : ''}</div>` : ''}</div>
        ${working && mine ? (i.prepared ? '<button class="btn sm" data-undo>Deshacer</button>' : '<div class="stack" style="min-width:132px"><button class="btn accent sm" data-full>Preparado</button><button class="btn sm" data-short>Faltante</button></div>') : ''}
      </div>`).join('')}</div>
      ${o.status === 'APROBADO' ? '<button class="btn accent block" id="st">Comenzar a preparar</button>' : ''}
      ${working && mine ? `<button class="btn primary block" id="fin" ${allDone ? '' : 'disabled'}>Finalizar preparación</button>${allDone ? '' : '<p class="muted small">Marque todos los productos para finalizar.</p>'}` : ''}
      ${o.status === 'LISTO_PARA_ENTREGAR' ? '<button class="btn accent block" id="dl">Confirmar entrega</button>' : ''}
      <div class="card"><h3 style="margin-bottom:8px">Historial</h3>${historyHtml(o)}</div></div>`;
    const run = (sel, fn) => $(sel, el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (x) { fail(friendly(x)); await load(); } }));
    run('#st', async () => { await rpc('start_preparation', { p_order_id: id }); ok('Preparación iniciada'); await load(); });
    run('#fin', async () => { await rpc('finish_preparation', { p_order_id: id }); ok('Pedido listo para entregar'); await load(); });
    run('#dl', async () => { if (!(await confirmBox('Confirmar entrega', 'Se descontará del stock lo realmente preparado.', { okText: 'Entregado' }))) return; await rpc('confirm_delivery', { p_order_id: id }); ok('Entrega confirmada'); await load(); });
    $$('[data-item]', el).forEach((row) => {
      const iid = row.dataset.item; const ap = toInt(row.dataset.ap);
      $('[data-full]', row)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await rpc('report_item', { p_item_id: iid, p_qty: ap }); await load(); } catch (x) { fail(friendly(x)); await load(); } }));
      $('[data-undo]', row)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await rpc('unprepare_item', { p_item_id: iid }); await load(); } catch (x) { fail(friendly(x)); await load(); } }));
      $('[data-short]', row)?.addEventListener('click', async () => {
        const r = await modal(`<h2>Informar faltante</h2><p class="muted">${esc(row.dataset.name)} · pedido: ${ap}</p>
          <label class="field"><span>Cantidad realmente preparada (0 a ${ap - 1})</span><input id="q" inputmode="numeric" value="0"></label>
          <label class="field" style="margin-top:10px"><span>Motivo</span><input id="m" maxlength="200" placeholder="Ej.: producto agotado en estantería"></label>
          <p class="notice bad hidden" id="err" style="margin-top:10px"></p>
          <div class="row" style="margin-top:16px"><button class="btn grow" data-close>Volver</button><button class="btn primary grow" id="okb">Guardar</button></div>`, {
          onMount: (ov, close) => $('#okb', ov).addEventListener('click', () => {
            const q = toInt($('#q', ov).value, -1); const m = $('#m', ov).value.trim();
            const bad = (t) => { const x = $('#err', ov); x.textContent = t; x.classList.remove('hidden'); };
            if (q < 0 || q >= ap) return bad(`La cantidad debe estar entre 0 y ${ap - 1}.`);
            if (!m) return bad('Indique el motivo del faltante.');
            close({ q, m });
          }),
        });
        if (!r) return;
        try { await rpc('report_item', { p_item_id: iid, p_qty: r.q, p_reason: r.m }); ok('Faltante informado al administrador'); } catch (x) { fail(friendly(x)); }
        await load();
      });
    });
  }
  await load();
  return { refresh: load };
}
