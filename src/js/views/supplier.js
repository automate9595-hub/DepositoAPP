import { categoryBar } from '../category-bar.js';
import { state, bus, persistCart, replaceCart } from '../state.js';
import { read, rpc, friendly } from '../api.js';
import { esc, money, cleanSearch, debounce, one, toInt } from '../format.js';
import { customerForm } from './customers.js';
import { icon, $, $$, busy, ok, fail, emptyBox, errorBox, spinner, photoBox, img, confirmBox } from '../ui.js';
import { setQty, getQty, removeItem, itemList, cartTotal, cartCount, toPayload, resetCart, MAX_QTY } from '../cart.js';
import { fetchOrder, orderCard, historyHtml, summaryHtml, totals } from './order-common.js';
import { attachScanner, orderToolsHtml, bindOrderTools } from '../tools.js';

const PAGE = 20;

// ---------------- Catálogo ----------------
export async function catalogView(el) {
  let page = 0; let q = ''; let cat = ''; let rows = []; let done = false; let loading = false; let gen = 0;
  const cats = (await read((s) => s.from('categories').select('id,name').eq('active', true).order('name')).catch(() => ({ data: [] }))).data || [];
  el.innerHTML = `<div class="search stack">
      <input id="q" type="search" placeholder="Buscar por nombre o código" autocomplete="off" aria-label="Buscar">
      <div id="cb"></div>
    </div><div id="g" class="grid"></div><div id="s" class="empty hidden"></div>
    <button class="btn block hidden" id="more" style="margin-top:12px">Ver más productos</button>`;
  const grid = $('#g', el); const status = $('#s', el); const more = $('#more', el);
  if (cats.length) categoryBar($('#cb', el), { cats: () => cats, value: () => cat, onChange: (k) => { cat = k; load(true); } }); else $('#cb', el).remove();
  attachScanner($('#q', el)); // botón de cámara para buscar por código de barras (si el dispositivo lo permite)

  const card = (p) => {
    const av = one(p.inventory)?.available_stock ?? 0;
    const n = getQty(state.cart, p.id);
    return `<div class="card pcard" data-id="${p.id}">${photoBox(p.photo_url, p.name)}
      <div class="pbody"><div class="pname">${esc(p.name)}</div>
        <div class="muted small ellipsis">${esc(p.code)}</div>
        <div class="row between"><span class="price mono">${money(p.price)}</span>
          <span class="status ${av > 0 ? (av <= 5 ? 's-warn' : 's-ok') : 's-bad'}">${av > 0 ? `${av} disp.` : 'Sin stock'}</span></div>
        ${av > 0 ? `<div class="stepper"><button data-d="-1" aria-label="Quitar uno">−</button>
          <input inputmode="numeric" pattern="[0-9]*" value="${n}" aria-label="Cantidad" data-q>
          <button data-d="1" aria-label="Agregar uno">+</button></div>` : ''}</div></div>`;
  };
  async function load(reset) {
    if (loading) return; loading = true; const my = ++gen;
    if (reset) { page = 0; rows = []; done = false; grid.innerHTML = ''; status.classList.remove('hidden'); status.textContent = 'Cargando…'; }
    more.classList.add('hidden');
    try {
      let qb = (s) => {
        let b = s.from('products').select('id,code,name,price,photo_url,inventory(available_stock)').eq('active', true).order('name').range(page * PAGE, page * PAGE + PAGE - 1);
        if (cat) b = b.eq('category_id', cat);
        const t = cleanSearch(q); if (t) b = b.or(`name.ilike.%${t}%,code.ilike.%${t}%`);
        return b;
      };
      const { data } = await read(qb);
      if (my !== gen) return;
      const got = data || [];
      rows = rows.concat(got); done = got.length < PAGE;
      grid.insertAdjacentHTML('beforeend', got.map(card).join(''));
      status.classList.toggle('hidden', rows.length > 0); status.textContent = 'No hay productos para mostrar.';
      more.classList.toggle('hidden', done);
    } catch (e) { if (my === gen) { status.classList.remove('hidden'); status.innerHTML = ''; status.append(Object.assign(document.createElement('div'), { innerHTML: errorBox(friendly(e)) })); $('[data-retry]', status)?.addEventListener('click', () => load(reset)); } }
    finally { loading = false; }
  }
  const search = debounce(() => { q = $('#q', el).value; load(true); }, 400);
  $('#q', el).addEventListener('input', search);
  el.addEventListener('click', (e) => {
    if (e.target === more) { page += 1; load(false); return; }
    const b = e.target.closest('[data-d]'); if (!b) return;
    const c = b.closest('.pcard'); const inp = $('[data-q]', c); setFrom(c, toInt(inp.value) + toInt(b.dataset.d));
  });
  el.addEventListener('change', (e) => { if (e.target.matches('[data-q]')) setFrom(e.target.closest('.pcard'), toInt(e.target.value)); });
  function setFrom(c, n) {
    const p = rows.find((r) => r.id === c.dataset.id); if (!p) return;
    const av = one(p.inventory)?.available_stock ?? 0;
    let v = Math.max(0, Math.min(n, MAX_QTY));
    if (v > av) { v = av; fail(`Solo hay ${av} unidades disponibles de "${p.name}".`); }
    setQty(state.cart, { ...p, available: av }, v); persistCart();
    $('[data-q]', c).value = v;
  }
  await load(true);
  const dsp = debounce(() => load(true), 300);
  return { refresh: (k) => { if (k.includes('inventory') || k.includes('resync')) dsp(); }, dispose: () => { gen++; } };
}

// ---------------- Carrito ----------------
export async function cartView(el, ctx) {
  let sending = false; let customers = [];
  const loadCustomers = async () => {
    try { customers = (await read((s) => s.from('customers').select('id,name,is_public').eq('active', true))).data || []; } catch { customers = []; }
    customers.sort((a, b) => Number(b.is_public) - Number(a.is_public) || a.name.localeCompare(b.name));
    if (state.cart.customerId && !customers.some((c) => c.id === state.cart.customerId)) { state.cart.customerId = ''; persistCart(); }
  };
  await loadCustomers();
  function draw() {
    const items = itemList(state.cart);
    if (!items.length) { el.innerHTML = `<div class="empty stack"><p>Su carrito está vacío.</p><a class="btn primary" href="#/catalogo">Ver catálogo</a></div>`; return; }
    el.innerHTML = `<div class="stack"><div class="card">${items.map((i) => `<div class="line" data-id="${i.id}">
        <div class="thumb" style="display:grid;place-items:center;overflow:hidden">${img(i.photo_url, i.name) || icon('image')}</div>
        <div class="grow"><div class="pname">${esc(i.name)}</div><div class="muted small mono">${money(i.price)} × ${i.qty} = <b>${money(i.price * i.qty)}</b></div>
          <div class="stepper" style="margin-top:6px;max-width:170px"><button data-d="-1" aria-label="Quitar uno">−</button>
          <input inputmode="numeric" value="${i.qty}" data-q aria-label="Cantidad"><button data-d="1" aria-label="Agregar uno">+</button></div></div>
        <button class="iconbtn" data-rm aria-label="Eliminar" style="color:var(--bad)">${icon('x')}</button></div>`).join('')}</div>
      <div class="card stack" id="cbox"><div class="row between"><b>Cliente del pedido</b><button class="btn sm" id="newc" type="button">${icon('plus')} Nuevo cliente</button></div>
        <select id="cu" aria-label="Cliente del pedido"><option value="">Elegir cliente…</option>${customers.map((c) => `<option value="${c.id}" ${c.id === state.cart.customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <p class="muted small">Todo pedido se asigna a un cliente. Si es una venta de mostrador, elija "Cliente público general".</p></div>
      <label class="field"><span>Nota para el depósito (opcional)</span><textarea id="n" maxlength="500">${esc(state.cart.notes)}</textarea></label>
      <div class="card"><div class="row between"><span class="muted">${cartCount(state.cart)} unidades · ${items.length} productos</span></div>
        <div class="row between"><span>Total estimado</span><b class="total mono">${money(cartTotal(state.cart))}</b></div>
        <p class="muted small">El total definitivo lo calcula el servidor con los precios vigentes.</p></div>
      <button class="btn accent block" id="send">Enviar pedido</button>
      <button class="btn ghost block" id="clr">Vaciar carrito</button></div>`;
  }
  draw();
  el.addEventListener('click', async (e) => {
    const line = e.target.closest('.line');
    const d = e.target.closest('[data-d]');
    if (d && line) { const it = state.cart.items[line.dataset.id]; if (it) { setQty(state.cart, it, it.qty + toInt(d.dataset.d)); persistCart(); draw(); } return; }
    if (e.target.closest('[data-rm]') && line) { removeItem(state.cart, line.dataset.id); persistCart(); draw(); return; }
    if (e.target.closest('#newc')) { const r = await customerForm(null); if (r) { await loadCustomers(); state.cart.customerId = r.id; persistCart(); draw(); ok('Cliente creado y seleccionado'); } return; }
    if (e.target.id === 'clr') { if (await confirmBox('Vaciar carrito', '¿Quitar todos los productos?', { danger: true, okText: 'Vaciar' })) { replaceCart(resetCart()); draw(); } return; }
    if (e.target.closest('#send')) await send(e.target.closest('#send'));
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-q]')) { const it = state.cart.items[e.target.closest('.line').dataset.id]; if (it) { setQty(state.cart, it, toInt(e.target.value)); persistCart(); draw(); } }
    if (e.target.id === 'n') { state.cart.notes = e.target.value; persistCart(); }
    if (e.target.id === 'cu') { state.cart.customerId = e.target.value; persistCart(); $('#cbox', el)?.classList.remove('flag'); }
  });
  async function send(btn) {
    if (sending) return;
    if (!navigator.onLine) return fail('Sin conexión: el pedido NO se envió. Intente cuando recupere Internet.');
    const notes = $('#n', el)?.value ?? ''; state.cart.notes = notes; persistCart();
    if (!state.cart.customerId) { const cb = $('#cbox', el); cb?.classList.add('flag'); cb?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return fail('Elija un cliente para el pedido (o "Cliente público general").'); }
    sending = true;
    await busy(btn, async () => {
      try {
        // El mismo requestId se reutiliza en cada reintento: la base de datos garantiza un único pedido
        const id = await rpc('submit_order', { p_client_request_id: state.cart.requestId, p_items: toPayload(state.cart), p_notes: notes || null, p_customer_id: state.cart.customerId }, { retries: 2 });
        replaceCart(resetCart());
        ok('Pedido enviado y confirmado');
        ctx.navigate('#/pedidos/' + id);
      } catch (x) {
        fail(friendly(x));
        if (x.code === 'STOCK_INSUFICIENTE' || x.code === 'PRODUCTO_NO_DISPONIBLE') { /* se mantiene el carrito para ajustarlo */ }
      } finally { sending = false; }
    });
  }
  return {};
}

// ---------------- Mis pedidos ----------------
export async function supplierOrdersView(el, ctx) {
  if (ctx.args[0]) return orderDetail(el, ctx, ctx.args[0]);
  let page = 0; let rows = [];
  el.innerHTML = `<div class="stack"><div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  async function load(reset) {
    if (reset) { page = 0; rows = []; }
    try {
      const { data } = await read((s) => s.from('orders').select('id,order_number,status,total_requested,total_approved,total_delivered,customer_name,created_at,suppliers(company_name)').order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1));
      rows = rows.concat(data || []); more.classList.toggle('hidden', (data || []).length < PAGE);
      list.innerHTML = rows.length ? rows.map((o) => orderCard(o)).join('') : emptyBox('Todavía no envió pedidos.');
    } catch (e) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); }
  }
  list.addEventListener('click', (e) => { const c = e.target.closest('[data-order]'); if (c) ctx.navigate('#/pedidos/' + c.dataset.order); });
  more.addEventListener('click', () => { page += 1; load(false); });
  await load(true);
  return { refresh: () => load(true) };
}

async function orderDetail(el, ctx, id) {
  ctx.setTitle('Pedido');
  async function load() {
    try {
      const o = await fetchOrder(id);
      if (!ctx.seq()) return;
      if (!o) { el.innerHTML = emptyBox('El pedido no existe o no tiene acceso.'); return; }
      el.innerHTML = `<div class="stack"><a href="#/pedidos" class="small">← Mis pedidos</a>${summaryHtml(o)}
        <div class="card">${o.items.map((i) => `<div class="line"><div class="grow"><div class="pname">${esc(i.product_name)}</div>
          <div class="muted small mono">${esc(i.product_code)} · ${money(i.unit_price)}</div>
          ${i.shortage_reason ? `<div class="small" style="color:var(--warn)">Faltante: ${esc(i.shortage_reason)}</div>` : ''}</div>
          <div class="right mono small"><div>Pedido: <b>${i.qty_requested}</b></div>
          ${i.qty_approved != null ? `<div>Aprobado: <b>${i.qty_approved}</b></div>` : ''}
          ${i.qty_delivered != null ? `<div>Entregado: <b>${i.qty_delivered}</b></div>` : ''}</div></div>`).join('')}
          <hr class="hr">${totals(o)}</div>
        ${orderToolsHtml()}
        <button class="btn primary block" id="rep">${icon('repeat')} Repetir este pedido</button>
        <div class="card"><h3 style="margin-bottom:8px">Seguimiento</h3>${historyHtml(o)}</div>
        ${o.status === 'PENDIENTE_APROBACION' ? '<button class="btn danger block" id="cx">Cancelar pedido</button>' : ''}</div>`;
      bindOrderTools(el, o);
      $('#rep', el)?.addEventListener('click', (e) => busy(e.currentTarget, () => repeatOrder(o, ctx)));
      $('#cx', el)?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!(await confirmBox('Cancelar pedido', 'El pedido pendiente se cancelará.', { danger: true, okText: 'Cancelar pedido' }))) return;
        await busy(btn, async () => { try { await rpc('cancel_order', { p_order_id: id, p_reason: 'Cancelado por el preventista' }); ok('Pedido cancelado'); load(); } catch (x) { fail(friendly(x)); } });
      });
    } catch (e) { el.innerHTML = errorBox(friendly(e)); $('[data-retry]', el)?.addEventListener('click', load); }
  }
  await load();
  return { refresh: load };
}

// Vuelve a cargar en el carrito los productos de un pedido anterior, con precios y stock ACTUALES
async function repeatOrder(o, ctx) {
  try {
    const ids = o.items.map((i) => i.product_id);
    const { data } = await read((s) => s.from('products').select('id,code,name,price,photo_url,active,inventory(available_stock)').in('id', ids));
    const byId = Object.fromEntries((data || []).map((p) => [p.id, p]));
    let added = 0; const skipped = []; const reduced = [];
    for (const i of o.items) {
      const p = byId[i.product_id]; const av = one(p?.inventory)?.available_stock ?? 0;
      if (!p || !p.active || av <= 0) { skipped.push(i.product_name); continue; }
      const q = Math.min(i.qty_requested, av);
      if (q < i.qty_requested) reduced.push(i.product_name);
      setQty(state.cart, { ...p, available: av }, q); added += 1;
    }
    if (!added) { fail('Ningún producto de este pedido tiene stock disponible ahora.'); return; }
    if (o.customer_id) state.cart.customerId = o.customer_id;
    persistCart();
    ok(`${added} producto${added === 1 ? '' : 's'} en el carrito${reduced.length ? ` · cantidad ajustada al stock en ${reduced.length}` : ''}${skipped.length ? ` · sin stock: ${skipped.length}` : ''}`);
    ctx.navigate('#/carrito');
  } catch (x) { fail(friendly(x)); }
}
