import { supabase } from '../supa.js';
import { read, rpc, write, friendly } from '../api.js';
import { esc, money, cleanSearch, debounce, one, toInt, dateTime } from '../format.js';
import { $, $$, busy, ok, fail, emptyBox, errorBox, spinner, modal, img, icon, compressImage, confirmBox, toast } from '../ui.js';
import { can } from '../state.js';
import { attachScanner, scanBarcode, scannerSupported, downloadCsv, fetchAll, stamp } from '../tools.js';
import { parseLow } from '../export-utils.js';

const LOW_KEY = 'deposito-low-stock';
const getLow = () => { try { return parseLow(localStorage.getItem(LOW_KEY)); } catch { return parseLow(null); } };
const setLow = (n) => { try { localStorage.setItem(LOW_KEY, String(n)); } catch { /* sin espacio */ } };

const PAGE = 25;
const costOf = (p) => Number(one(p?.product_costs)?.cost_price ?? 0);
const marginOf = (p) => (Number(p.price) > 0 ? ((Number(p.price) - costOf(p)) / Number(p.price)) * 100 : 0);

// ---------------- Productos ----------------
export async function productsView(el) {
  let page = 0; let q = ''; let rows = []; let gen = 0; let cats = []; let cat = '';
  async function loadCats() { cats = (await read((s) => s.from('categories').select('id,name,active').order('name')).catch(() => ({ data: [] }))).data || []; }
  await loadCats();
  el.innerHTML = `<div class="stack"><div class="row"><input id="q" type="search" class="grow" placeholder="Buscar producto o código" aria-label="Buscar">
    <button class="btn primary" id="new">${icon('plus')} Nuevo</button></div>
    <div class="chips wrap" id="cc" role="group" aria-label="Filtrar por categoría"></div>
    <button class="btn sm block" id="cats">Administrar categorías</button>
    <div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  attachScanner($('#q', el));
  // Categorías para tocar y filtrar: «Todos» (principal), cada categoría y «Sin categoría»
  function renderChips() {
    if (cat && cat !== '__none' && !cats.some((c) => c.id === cat)) cat = '';
    const chip = (k, label, cls = '') => `<button type="button" class="chip ${cls} ${k === cat ? 'on' : ''}" data-c="${esc(k)}" aria-pressed="${k === cat}">${label}</button>`;
    $('#cc', el).innerHTML = chip('', 'Todos') + cats.map((c) => chip(c.id, esc(c.name) + (c.active ? '' : ' (inactiva)'), c.active ? '' : 'muted')).join('') + (cats.length ? chip('__none', 'Sin categoría') : '');
  }
  renderChips();
  $('#cc', el).addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; cat = b.dataset.c; renderChips(); load(true); });
  async function load(reset) {
    const my = ++gen; if (reset) { page = 0; rows = []; list.innerHTML = spinner(); }
    try {
      const { data } = await read((s) => {
        let b = s.from('products').select('id,code,name,description,price,photo_url,active,category_id,inventory(physical_stock,reserved_stock,available_stock),product_costs(cost_price)').order('name').range(page * PAGE, page * PAGE + PAGE - 1);
        if (cat === '__none') b = b.is('category_id', null); else if (cat) b = b.eq('category_id', cat);
        const t = cleanSearch(q); if (t) b = b.or(`name.ilike.%${t}%,code.ilike.%${t}%`); return b;
      });
      if (my !== gen) return;
      rows = rows.concat(data || []); more.classList.toggle('hidden', (data || []).length < PAGE);
      list.innerHTML = rows.length ? rows.map((p) => `<div class="card click row" data-id="${p.id}">
        <div class="thumb" style="display:grid;place-items:center;overflow:hidden">${img(p.photo_url, p.name) || icon('image')}</div>
        <div class="grow"><div class="pname">${esc(p.name)}</div><div class="muted small ellipsis">${esc(p.code)} · Venta ${money(p.price)} · Costo ${money(costOf(p))}</div>
        <div class="small">Disponible: <b>${one(p.inventory)?.available_stock ?? 0}</b>${Number(p.price) > 0 ? ` · Margen <b style="color:${marginOf(p) >= 0 ? 'var(--ok)' : 'var(--bad)'}">${marginOf(p).toFixed(0)}%</b>` : ''}</div></div>
        ${p.active ? '' : '<span class="status s-idle">Inactivo</span>'}</div>`).join('') : emptyBox(q || cat ? 'No hay productos con ese filtro.' : 'No hay productos. Cree el primero con "Nuevo".');
    } catch (e) { if (my === gen) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); } }
  }
  $('#q', el).addEventListener('input', debounce((e) => { q = e.target.value; load(true); }, 400));
  $('#new', el).addEventListener('click', async () => { if (await productForm(null, cats)) { await loadCats(); renderChips(); load(true); } });
  $('#cats', el).addEventListener('click', async () => { await categoriesForm(cats); await loadCats(); renderChips(); load(true); });
  list.addEventListener('click', async (e) => { const c = e.target.closest('[data-id]'); if (c && await productForm(rows.find((r) => r.id === c.dataset.id), cats)) load(true); });
  more.addEventListener('click', () => { page += 1; load(false); });
  await load(true);
  return { dispose: () => { gen++; } };
}

function productForm(p, cats) {
  const isNew = !p;
  return modal(`<h2>${isNew ? 'Nuevo producto' : 'Editar producto'}</h2>
    <form id="f" class="stack" novalidate>
      <div class="field"><span>Código de barras o código interno</span><div class="row"><input name="code" class="grow" value="${esc(p?.code || '')}" maxlength="40" required autocomplete="off" autocapitalize="characters" aria-label="Código">
        ${scannerSupported() ? `<button type="button" class="btn scanbtn" id="scan" aria-label="Escanear código de barras" title="Escanear con la cámara">${icon('scan')}</button>` : ''}</div>
        <p class="small hidden" id="codehint" aria-live="polite"></p></div>
      <label class="field"><span>Nombre</span><input name="name" value="${esc(p?.name || '')}" maxlength="120" required></label>
      <label class="field"><span>Descripción</span><textarea name="description" maxlength="500">${esc(p?.description || '')}</textarea></label>
      <label class="field"><span>Categoría</span><select name="category_id"><option value="">Sin categoría</option>
        ${cats.filter((c) => c.active || c.id === p?.category_id).map((c) => `<option value="${c.id}" ${c.id === p?.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div class="row"><label class="field grow"><span>Precio de costo</span><input name="cost" inputmode="decimal" value="${p ? costOf(p) : ''}" placeholder="0"></label>
        <label class="field grow"><span>Precio de venta</span><input name="price" inputmode="decimal" value="${p ? p.price : ''}" required></label></div>
      <p class="small muted" id="mg" aria-live="polite"></p>
      ${isNew ? '<label class="field"><span>Stock inicial (opcional)</span><input name="stock" inputmode="numeric" value="0"></label>' : ''}
      <div class="field"><span>Fotografía</span><div class="pimg pvbox" id="pv">${icon('image')}${img(p?.photo_url, '')}</div>
        <input name="photo" type="file" accept="image/*" style="margin-top:8px"><p class="small muted">Así se verá en el catálogo: centrada y completa. Si sacó la foto con el celular, se endereza sola.</p></div>
      <label class="check"><input type="checkbox" name="active" ${p?.active === false ? '' : 'checked'}> Producto activo (visible para preventistas)</label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Guardar</button></div>
      ${!isNew && can('products') ? `<button type="button" class="btn danger block" id="del">${icon('trash')} Eliminar producto</button>` : ''}
    </form>`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      const num = (v) => Number(String(v ?? '').trim().replace(',', '.'));
      const margin = () => {
        const c = num(f.cost.value || 0); const v = num(f.price.value);
        $('#mg', ov).innerHTML = Number.isFinite(c) && Number.isFinite(v) && v > 0 ? `Ganancia por unidad: <b style="color:${v - c >= 0 ? 'var(--ok)' : 'var(--bad)'}">${money(v - c)}</b> · Margen sobre la venta: <b>${(((v - c) / v) * 100).toFixed(1)}%</b> · Recargo sobre el costo: <b>${c > 0 ? (((v - c) / c) * 100).toFixed(1) + '%' : '—'}</b>` : 'El costo solo lo ven los administradores.';
      };
      f.cost.addEventListener('input', margin); f.price.addEventListener('input', margin); margin();

      // ----- Código: escanear con la cámara (o lector físico) y avisar si ya existe -----
      const hint = $('#codehint', ov);
      async function checkCode() {
        const code = f.code.value.trim(); hint.classList.add('hidden');
        if (!code || code === p?.code) return;
        try {
          const { data } = await read((s) => s.from('products').select('id,name').eq('code', code).limit(1));
          const hit = (data || [])[0];
          if (hit && hit.id !== p?.id) { hint.innerHTML = `Ya existe un producto con este código: <b>${esc(hit.name)}</b>. No se pueden repetir códigos.`; hint.style.color = 'var(--bad)'; hint.classList.remove('hidden'); }
        } catch { /* sin conexión: el servidor igual rechaza duplicados al guardar */ }
      }
      f.code.addEventListener('change', checkCode);
      // Los lectores físicos terminan con Enter: pasa al nombre en vez de guardar a medias
      f.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); f.code.dispatchEvent(new Event('change')); f.name.focus(); } });
      $('#scan', ov)?.addEventListener('click', async () => {
        const code = await scanBarcode({ title: 'Escanear código del producto' });
        if (!code) return;
        f.code.value = String(code).trim().slice(0, 40);
        toast(`Código leído: ${f.code.value}`, 'ok');
        await checkCode();
        f.name.focus();
      });
      $('#del', ov)?.addEventListener('click', async (e) => {
        if (!(await confirmBox('Eliminar producto', `¿Eliminar «${p.name}»? Se borran también su stock, su costo y su foto. Los pedidos ya entregados o cancelados conservan su nombre, código y precio. No se puede eliminar si está en un pedido en curso. Esta acción no se puede deshacer.`, { okText: 'Eliminar', danger: true }))) return;
        await busy(e.currentTarget, async () => {
          try {
            const res = await rpc('delete_product', { p_product_id: p.id });
            const path = String(res?.photo_url || '').split('/product-photos/')[1];
            if (path) await supabase.storage.from('product-photos').remove([decodeURIComponent(path.split('?')[0])]).catch(() => {});
            ok('Producto eliminado'); close(true);
          } catch (x) { show(friendly(x)); }
        });
      });
      f.photo.addEventListener('change', () => { const file = f.photo.files[0]; if (file) { $('#pv', ov).innerHTML = `${icon('image')}<img class="ok" data-pimg alt="" src="${URL.createObjectURL(file)}">`; } });
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        const price = Number(String(f.price.value).replace(',', '.')); const cost = f.cost.value.trim() === '' ? 0 : Number(String(f.cost.value).replace(',', '.'));
        if (!f.code.value.trim() || !f.name.value.trim()) return show('Código y nombre son obligatorios.');
        if (!Number.isFinite(price) || price < 0) return show('Ingrese un precio de venta válido (0 o mayor).');
        if (!Number.isFinite(cost) || cost < 0) return show('Ingrese un precio de costo válido (0 o mayor).');
        const stock = isNew ? toInt(f.stock.value) : 0;
        if (stock < 0) return show('El stock inicial no puede ser negativo.');
        await busy($('button:not([type=button])', f), async () => {
          let uploadedPath = null; let createdId = null;
          try {
            let photo_url = p?.photo_url ?? null;
            const file = f.photo.files[0];
            if (file) {
              const blob = await compressImage(file);
              const path = `${crypto.randomUUID()}.jpg`;
              const up = await supabase.storage.from('product-photos').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
              if (up.error) throw up.error;
              uploadedPath = path;
              photo_url = supabase.storage.from('product-photos').getPublicUrl(path).data.publicUrl;
            }
            const row = { code: f.code.value.trim(), name: f.name.value.trim(), description: f.description.value.trim(), category_id: f.category_id.value || null, price, photo_url, active: f.active.checked };
            if (isNew) {
              const { data } = await write((s) => s.from('products').insert(row).select('id').single());
              createdId = data.id;              await rpc('set_product_cost', { p_product_id: data.id, p_cost: cost });
              if (stock > 0) await rpc('adjust_stock', { p_product_id: data.id, p_delta: stock, p_type: 'INGRESO', p_note: 'Stock inicial' });
            } else {
              await write((s) => s.from('products').update(row).eq('id', p.id));
              await rpc('set_product_cost', { p_product_id: p.id, p_cost: cost });
            }
            if (uploadedPath && p?.photo_url) {   // al reemplazar la foto, se borra la anterior (no acumular archivos)
              const old = String(p.photo_url).split('/product-photos/')[1];
              if (old) supabase.storage.from('product-photos').remove([decodeURIComponent(old.split('?')[0])]).catch(() => {});
            }
            ok('Producto guardado'); close(true);
          } catch (x) {
            if (uploadedPath) supabase.storage.from('product-photos').remove([uploadedPath]).catch(() => {});   // no dejar fotos huérfanas
            if (createdId) await rpc('delete_product', { p_product_id: createdId }).catch(() => {});             // no dejar un producto a medias (sin costo/stock)
            show(friendly(x));
          }
        });
      });
      function show(m) { err.textContent = m; err.classList.remove('hidden'); }
    },
  }).then((v) => v === true);
}

function categoriesForm(cats) {
  return modal(`<h2>Categorías</h2><div id="cl" class="list"></div>
    <form id="cf" class="row" style="margin-top:12px"><input name="n" class="grow" placeholder="Nueva categoría" maxlength="60" aria-label="Nueva categoría"><button class="btn primary">${icon('plus')}</button></form>
    <button class="btn block" data-close style="margin-top:12px">Cerrar</button>`, {
    onMount: (ov) => {
      const draw = () => { $('#cl', ov).innerHTML = cats.length ? cats.map((c) => `<div class="row between card" data-id="${c.id}"><span>${esc(c.name)}</span>
        <label class="check"><input type="checkbox" ${c.active ? 'checked' : ''}> activa</label></div>`).join('') : '<p class="muted">No hay categorías.</p>'; };
      draw();
      $('#cf', ov).addEventListener('submit', async (e) => {
        e.preventDefault(); const n = e.target.n.value.trim(); if (!n) return;
        await busy($('button', e.target), async () => {
          try { const { data } = await write((s) => s.from('categories').insert({ name: n }).select('id,name,active').single()); cats.push(data); cats.sort((a, b) => a.name.localeCompare(b.name)); e.target.reset(); draw(); }
          catch (x) { fail(friendly(x)); }
        });
      });
      $('#cl', ov).addEventListener('change', async (e) => {
        const id = e.target.closest('[data-id]').dataset.id; const c = cats.find((x) => x.id === id);
        try { await write((s) => s.from('categories').update({ active: e.target.checked }).eq('id', id)); c.active = e.target.checked; }
        catch (x) { fail(friendly(x)); e.target.checked = c.active; }
      });
    },
  });
}

// ---------------- Inventario ----------------
export async function inventoryView(el) {
  let page = 0; let q = ''; let rows = []; let gen = 0; let tab = 'stock'; let low = getLow();
  el.innerHTML = `<div class="stack"><div class="chips"><button class="chip on" data-t="stock">Stock</button><button class="chip" data-t="low" id="lowchip">Stock bajo</button><button class="chip" data-t="mov">Movimientos</button></div>
    <input id="q" type="search" placeholder="Buscar producto o código" aria-label="Buscar">
    <div class="lowbar hidden" id="lowbar"><label class="small muted" for="lowv">Considerar bajo cuando el disponible sea menor o igual a</label><input id="lowv" inputmode="numeric" value="${low}" aria-label="Umbral de stock bajo"></div>
    ${can('inventory') || can('orders') ? `<button class="btn sm block" id="exp" type="button">${icon('download')} Exportar a Excel (CSV)</button>` : ''}
    <div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  attachScanner($('#q', el));
  async function countLow() {
    try {
      const { count } = await read((s) => s.from('inventory').select('product_id,products!inner(active)', { count: 'exact', head: true }).eq('products.active', true).lte('available_stock', low));
      $('#lowchip', el).textContent = count ? `⚠ Stock bajo (${count})` : 'Stock bajo';
    } catch { /* el contador es opcional */ }
  }
  async function load(reset) {
    const my = ++gen; if (reset) { page = 0; rows = []; list.innerHTML = spinner(); }
    try {
      const t = cleanSearch(q);
      const { data } = await read((s) => {
        if (tab === 'stock' || tab === 'low') {
          let b = s.from('inventory').select('product_id,physical_stock,reserved_stock,available_stock,products!inner(code,name,active)').range(page * PAGE, page * PAGE + PAGE - 1);
          b = tab === 'low' ? b.eq('products.active', true).lte('available_stock', low).order('available_stock', { ascending: true }).order('products(name)') : b.order('products(name)');
          if (t) b = b.or(`name.ilike.%${t}%,code.ilike.%${t}%`, { referencedTable: 'products' });
          return b;
        }
        let b = s.from('stock_movements').select('id,movement_type,quantity,physical_after,reserved_after,note,created_at,order_id,products!inner(code,name),profiles(full_name)').order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
        if (t) b = b.or(`name.ilike.%${t}%,code.ilike.%${t}%`, { referencedTable: 'products' });
        return b;
      });
      if (my !== gen) return;
      rows = rows.concat(data || []); more.classList.toggle('hidden', (data || []).length < PAGE);
      list.innerHTML = rows.length ? rows.map(tab === 'mov' ? movCard : stockCard).join('') : emptyBox(tab === 'low' ? 'Ningún producto activo con stock bajo.' : 'Sin resultados.');
      if (reset) countLow();
    } catch (e) { if (my === gen) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); } }
  }
  const stockCard = (r) => { const p = one(r.products); return `<div class="card click" data-id="${r.product_id}"><div class="row between"><b class="ellipsis">${esc(p.name)}</b>${p.active ? '' : '<span class="status s-idle">Inactivo</span>'}</div>
    <div class="muted small">${esc(p.code)}</div><div class="row between mono small" style="margin-top:6px"><span>Físico <b>${r.physical_stock}</b></span><span>Reservado <b>${r.reserved_stock}</b></span>
    <span>Disponible <b style="color:${r.available_stock <= 0 ? 'var(--bad)' : r.available_stock <= low ? 'var(--warn)' : 'var(--ok)'}">${r.available_stock}</b></span></div>
    ${p.active && r.available_stock <= low ? `<div class="small" style="color:${r.available_stock <= 0 ? 'var(--bad)' : 'var(--warn)'};margin-top:4px">${icon('alert')} ${r.available_stock <= 0 ? 'Sin stock: reponer' : 'Stock bajo: conviene reponer'}</div>` : ''}</div>`; };
  const TYPE = { INGRESO: 'Ingreso', AJUSTE: 'Ajuste', RESERVA: 'Reserva', LIBERACION: 'Liberación', ENTREGA: 'Entrega' };
  const movCard = (m) => { const p = one(m.products); return `<div class="card"><div class="row between"><b class="ellipsis">${esc(p.name)}</b><span class="status s-info">${TYPE[m.movement_type]}</span></div>
    <div class="row between small"><span class="mono"><b>${m.quantity > 0 ? '+' : ''}${m.quantity}</b> u. · físico ${m.physical_after} · reserv. ${m.reserved_after}</span></div>
    <div class="muted small">${dateTime(m.created_at)} · ${esc(one(m.profiles)?.full_name || 'Sistema')}${m.note ? ' · ' + esc(m.note) : ''}</div></div>`; };

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; $$('[data-t]', el).forEach((c) => c.classList.toggle('on', c === t)); $('#lowbar', el).classList.toggle('hidden', tab !== 'low'); load(true); return; }
    if (e.target.closest('#exp')) { exportCsv(e.target.closest('#exp')); return; }
    if (e.target === more) { page += 1; load(false); return; }
    const c = e.target.closest('[data-id]'); if (!c || tab === 'mov') return;
    const r = rows.find((x) => x.product_id === c.dataset.id);
    if (r && can('inventory') && await stockForm(r)) load(true);
  });
  $('#q', el).addEventListener('input', debounce((e) => { q = e.target.value; load(true); }, 400));
  $('#lowv', el).addEventListener('change', (e) => { low = parseLow(e.target.value); e.target.value = low; setLow(low); load(true); });
  async function exportCsv(btn) {
    await busy(btn, async () => {
      try {
        const t = cleanSearch(q);
        if (tab === 'mov') {
          const all = await fetchAll((a, b) => read((s) => { let r = s.from('stock_movements').select('created_at,movement_type,quantity,physical_after,reserved_after,note,products!inner(code,name),profiles(full_name)').order('created_at', { ascending: false }).range(a, b); if (t) r = r.or(`name.ilike.%${t}%,code.ilike.%${t}%`, { referencedTable: 'products' }); return r; }), { max: 20000 });
          downloadCsv(`movimientos-${stamp()}.csv`, ['Fecha', 'Código', 'Producto', 'Tipo', 'Cantidad', 'Físico luego', 'Reservado luego', 'Usuario', 'Nota'],
            all.map((m) => [dateTime(m.created_at), one(m.products)?.code, one(m.products)?.name, TYPE[m.movement_type] || m.movement_type, m.quantity, m.physical_after, m.reserved_after, one(m.profiles)?.full_name || 'Sistema', m.note || '']));
          ok(`Se exportaron ${all.length} movimientos`); return;
        }
        const all = await fetchAll((a, b) => read((s) => { let r = s.from('inventory').select('physical_stock,reserved_stock,available_stock,products!inner(code,name,active)').order('products(name)').range(a, b); if (tab === 'low') r = r.eq('products.active', true).lte('available_stock', low); if (t) r = r.or(`name.ilike.%${t}%,code.ilike.%${t}%`, { referencedTable: 'products' }); return r; }));
        downloadCsv(`${tab === 'low' ? 'stock-bajo' : 'inventario'}-${stamp()}.csv`, ['Código', 'Producto', 'Activo', 'Físico', 'Reservado', 'Disponible'],
          all.map((r) => [one(r.products)?.code, one(r.products)?.name, one(r.products)?.active ? 'Sí' : 'No', r.physical_stock, r.reserved_stock, r.available_stock]));
        ok(`Se exportaron ${all.length} productos`);
      } catch (x) { fail(friendly(x)); }
    });
  }
  await load(true);
  return { refresh: (k) => { if (k.includes('inventory') || k.includes('resync')) load(true); }, dispose: () => { gen++; } };
}

function stockForm(r) {
  const p = one(r.products);
  return modal(`<h2>${esc(p.name)}</h2><p class="muted small">Físico ${r.physical_stock} · Reservado ${r.reserved_stock} · Disponible ${r.available_stock}</p>
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Operación</span><select name="type"><option value="INGRESO">Ingreso de mercadería (+)</option><option value="AJUSTE">Ajuste por recuento (+ o −)</option></select></label>
      <label class="field"><span>Cantidad</span><input name="qty" inputmode="numeric" placeholder="Ej.: 20 (en ajustes puede ser −3)" required></label>
      <label class="field"><span>Motivo / nota</span><input name="note" maxlength="200"></label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Registrar</button></div></form>`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        const n = parseInt(f.qty.value, 10);
        const bad = (m) => { err.textContent = m; err.classList.remove('hidden'); };
        if (!Number.isInteger(n) || n === 0) return bad('Ingrese una cantidad entera distinta de 0.');
        if (f.type.value === 'INGRESO' && n < 0) return bad('Un ingreso debe ser positivo. Use "Ajuste" para restar.');
        if (f.type.value === 'AJUSTE' && !f.note.value.trim()) return bad('Indique el motivo del ajuste.');
        await busy($('button:not([type=button])', f), async () => {
          try { await rpc('adjust_stock', { p_product_id: r.product_id, p_delta: n, p_type: f.type.value, p_note: f.note.value.trim() || null }); ok('Stock actualizado'); close(true); }
          catch (x) { bad(friendly(x)); }
        });
      });
    },
  }).then((v) => v === true);
}
