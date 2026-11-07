import { read, rpc, friendly } from '../api.js';
import { esc, money, dateTime, accountBadge, debounce, one, orderTitle, PUBLIC_CUSTOMER } from '../format.js';
import { $, $$, busy, ok, fail, emptyBox, errorBox, spinner, modal, icon, confirmBox } from '../ui.js';
import { can, state } from '../state.js';
import { orderCard } from './order-common.js';

const isAdm = () => can('customers');
const num = (v) => Number(String(v ?? '').trim().replace(/\s/g, '').replace(',', '.'));
const FILTERS = [['', 'Todos'], ['CON_SALDO', 'Con saldo'], ['VENCIDO', 'Vencidos'], ['AL_DIA', 'Al día']];
const METHODS = ['Efectivo', 'Transferencia', 'Cheque', 'Tarjeta', 'Otro'];

const badge = (c) => (c.is_public ? accountBadge(null) : c.account_status ? accountBadge(c.account_status) : '');
export const balanceHtml = (c) => {
  if (!c.has_account) return c.is_public ? '<span class="muted small">Contado</span>' : '';
  const b = Number(c.balance || 0);
  return `<b class="mono" style="color:${b > 0 ? 'var(--bad)' : b < 0 ? 'var(--ok)' : 'var(--text)'}">${money(Math.abs(b))}</b><div class="muted small">${b > 0 ? 'debe' : b < 0 ? 'a favor' : 'sin deuda'}</div>`;
};

export async function customersView(el, ctx) {
  if (ctx.args[0]) return detail(el, ctx, ctx.args[0]);
  let rows = []; let filter = ''; let q = '';
  el.innerHTML = `<div class="stack"><div class="row"><input id="q" type="search" class="grow" placeholder="Buscar cliente" aria-label="Buscar cliente">
    <button class="btn primary" id="new">${icon('plus')} Nuevo</button></div><div id="sum"></div>
    <div class="chips">${FILTERS.map(([v, l]) => `<button class="chip ${v === filter ? 'on' : ''}" data-f="${v}">${l}</button>`).join('')}</div><div id="l" class="list"></div></div>`;
  const list = $('#l', el);
  const draw = () => {
    const t = q.trim().toLowerCase();
    const v = rows.filter((c) => (!filter || c.account_status === filter) && (!t || `${c.name} ${c.phone || ''} ${c.tax_id || ''} ${c.supplier_name || ''}`.toLowerCase().includes(t)));
    list.innerHTML = v.length ? v.map((c) => `<div class="card click row" data-id="${c.id}"><div class="grow"><div class="row"><b class="ellipsis">${esc(c.name)}</b>${c.active ? '' : '<span class="status s-idle">Inactivo</span>'}</div>
      <div class="muted small ellipsis">${[c.phone, isAdm() ? (c.supplier_name ? 'Proveedor: ' + c.supplier_name : c.is_public ? '' : 'Todos los proveedores') : ''].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div>
      <div style="margin-top:4px">${badge(c)}${c.account_status === 'VENCIDO' ? `<span class="muted small"> · plazo ${c.credit_days} días</span>` : ''}</div></div>
      <div class="right">${balanceHtml(c)}</div></div>`).join('') : emptyBox('No hay clientes para mostrar.');
  };
  async function load() {
    list.innerHTML = spinner();
    try {
      rows = await rpc('customers_overview', {}, { retries: 1 }); draw();
      const debt = rows.filter((c) => c.has_account && Number(c.balance) > 0); const over = rows.filter((c) => c.account_status === 'VENCIDO');
      $('#sum', el).innerHTML = debt.length || isAdm() ? `<div class="kpis">
        <div class="card kpi"><span class="muted small">Por cobrar</span><div class="kv-val ${debt.length ? 'bad' : ''}">${money(debt.reduce((t, c) => t + Number(c.balance), 0))}</div><span class="muted small">${debt.length} cliente${debt.length === 1 ? '' : 's'} con saldo</span></div>
        <div class="card kpi"><span class="muted small">Vencido</span><div class="kv-val ${over.length ? 'bad' : ''}">${money(over.reduce((t, c) => t + Number(c.balance), 0))}</div><span class="muted small">${over.length} cliente${over.length === 1 ? '' : 's'} fuera de plazo</span></div></div>` : '';
    } catch (e) {
      list.innerHTML = /customers_overview|PGRST202|schema cache/i.test(String(e?.message || '')) ? '<div class="notice">Falta actualizar la base de datos: ejecute <b>06_clientes_costos.sql</b> en Supabase.</div>' : errorBox(friendly(e));
      $('[data-retry]', list)?.addEventListener('click', load);
    }
  }
  $('#q', el).addEventListener('input', debounce((e) => { q = e.target.value; draw(); }, 200));
  $('#new', el).addEventListener('click', async () => { const r = await customerForm(null); if (r) { ok('Cliente guardado'); load(); } });
  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]'); if (f) { filter = f.dataset.f; $$('.chip', el).forEach((c) => c.classList.toggle('on', c === f)); draw(); return; }
    const c = e.target.closest('[data-id]'); if (c) ctx.navigate('#/clientes/' + c.dataset.id);
  });
  await load();
  return { refresh: (k) => { if (k.includes('resync')) load(); } };
}

async function detail(el, ctx, id) {
  ctx.setTitle('Cliente');
  async function load() {
    try {
      const all = await rpc('customers_overview', {}, { retries: 1 });
      if (!ctx.seq()) return;
      const c = all.find((x) => x.id === id);
      if (!c) { el.innerHTML = emptyBox('El cliente no existe o no tiene acceso.'); return; }
      const [mv, od] = await Promise.all([
        c.has_account ? read((s) => s.from('customer_movements').select('id,kind,amount,method,note,created_at,orders(order_number)').eq('customer_id', id).order('created_at', { ascending: false }).limit(100)).then((r) => r.data || []) : [],
        read((s) => s.from('orders').select('id,order_number,status,total_requested,total_approved,total_delivered,customer_name,created_at').eq('customer_id', id).order('created_at', { ascending: false }).limit(15)).then((r) => r.data || []).catch(() => []),
      ]);
      draw(c, mv, od);
    } catch (e) { el.innerHTML = errorBox(friendly(e)); $('[data-retry]', el)?.addEventListener('click', load); }
  }
  function draw(c, mv, od) {
    const adm = isAdm(); const editable = !c.is_public && (adm || c.has_account);
    const due = c.due_since ? new Date(new Date(c.due_since).getTime() + c.credit_days * 86400000) : null;
    el.innerHTML = `<div class="stack"><a href="#/clientes" class="small">← Clientes</a>
      <div class="card stack"><div class="row between"><h2 class="ellipsis">${esc(c.name)}</h2>${badge(c)}</div>
        ${c.has_account ? `<div class="row between"><span class="muted">Saldo</span><span class="right" style="font-size:1.4rem">${balanceHtml(c)}</span></div>
        <div class="kv small"><span class="muted">Total cargado</span><span class="mono">${money(c.charged)}</span><span class="muted">Total pagado</span><span class="mono">${money(c.paid)}</span>
        <span class="muted">Último pago</span><span>${c.last_payment ? dateTime(c.last_payment) : '—'}</span>
        ${Number(c.balance) > 0 && due ? `<span class="muted">${due < new Date() ? 'Venció el' : 'Vence el'}</span><span style="color:${due < new Date() ? 'var(--bad)' : 'inherit'}">${due.toLocaleDateString()}</span>` : ''}
        <span class="muted">Plazo de pago</span><span>${c.credit_days} días</span></div>` : `<p class="muted small">${c.is_public ? 'Venta de contado: no lleva cuenta corriente.' : 'La cuenta de este cliente no está disponible para usted.'}</p>`}
        <div class="kv small">${c.phone ? `<span class="muted">Teléfono</span><span>${esc(c.phone)}</span>` : ''}${c.email ? `<span class="muted">Correo</span><span>${esc(c.email)}</span>` : ''}
        ${c.address ? `<span class="muted">Dirección</span><span>${esc(c.address)}</span>` : ''}${c.tax_id ? `<span class="muted">CUIT / DNI</span><span>${esc(c.tax_id)}</span>` : ''}
        ${adm ? `<span class="muted">Proveedor</span><span>${esc(c.supplier_name || (c.is_public ? '—' : 'Todos los proveedores'))}</span>` : ''}</div>
        ${c.notes ? `<p class="small"><span class="muted">Notas:</span> ${esc(c.notes)}</p>` : ''}
        ${adm && c.has_account ? `<div class="row wrap"><button class="btn accent grow" id="pay">Registrar pago</button><button class="btn grow" id="adj">Ajuste</button></div>` : ''}
        ${editable ? '<button class="btn block" id="ed">Editar datos</button>' : ''}
        ${adm && !c.is_public ? `<button class="btn danger block" id="del">${icon('trash')} Eliminar cliente</button>` : ''}</div>
      ${c.has_account ? `<div class="card"><h3 style="margin-bottom:8px">Movimientos de la cuenta</h3>${mv.length ? mv.map((m) => `<div class="line"><div class="grow"><b>${m.kind === 'CARGO' ? 'Pedido entregado' : m.kind === 'PAGO' ? 'Pago' + (m.method ? ' · ' + esc(m.method) : '') : 'Ajuste'}</b>
        <div class="muted small">${dateTime(m.created_at)}${one(m.orders) ? ' · Pedido número ' + one(m.orders).order_number : ''}${m.note ? ' · ' + esc(m.note) : ''}</div></div>
        <b class="mono" style="color:${Number(m.amount) > 0 ? 'var(--bad)' : 'var(--ok)'}">${Number(m.amount) > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</b></div>`).join('') : '<p class="muted small">Todavía no hay movimientos.</p>'}</div>` : ''}
      <div class="stack"><h3>Pedidos del cliente</h3><div class="list" id="od">${od.length ? od.map((o) => orderCard(o)).join('') : emptyBox('Todavía no tiene pedidos.')}</div></div></div>`;
    $('#od', el)?.addEventListener('click', (e) => { const x = e.target.closest('[data-order]'); if (x) ctx.navigate('#/pedidos/' + x.dataset.order); });
    $('#pay', el)?.addEventListener('click', async () => { if (await paymentForm(c)) { ok('Pago registrado'); load(); } });
    $('#adj', el)?.addEventListener('click', async () => { if (await adjustForm(c)) { ok('Ajuste registrado'); load(); } });
    $('#ed', el)?.addEventListener('click', async () => { if (await customerForm(c)) { ok('Cliente guardado'); load(); } });
    $('#del', el)?.addEventListener('click', async (e) => {
      if (!(await confirmBox('Eliminar cliente', `¿Eliminar a «${c.name}»? Solo se puede si nunca tuvo pedidos ni movimientos de cuenta. Esta acción no se puede deshacer.`, { okText: 'Eliminar', danger: true }))) return;
      await busy(e.currentTarget, async () => {
        try { await rpc('delete_customer', { p_customer_id: c.id }); ok('Cliente eliminado'); ctx.navigate('#/clientes'); }
        catch (x) { fail(friendly(x)); }
      });
    });
  }
  await load();
  return { refresh: load };
}

function paymentForm(c) {
  const bal = Math.max(0, Number(c.balance || 0));
  return modal(`<h2>Registrar pago</h2><p class="muted small">${esc(c.name)} · saldo actual ${money(c.balance)}</p>
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Monto cobrado</span><input name="amount" inputmode="decimal" value="${bal > 0 ? bal : ''}" required autofocus></label>
      ${bal > 0 ? '<button type="button" class="btn sm" id="all">Cobrar saldo completo</button>' : ''}
      <label class="field"><span>Medio de pago</span><select name="method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></label>
      <label class="field"><span>Nota (opcional)</span><input name="note" maxlength="300"></label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn accent grow">Registrar</button></div></form>`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      $('#all', ov)?.addEventListener('click', () => { f.amount.value = bal; });
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden'); const a = num(f.amount.value);
        if (!(a > 0)) { err.textContent = 'Ingrese un monto mayor a 0.'; err.classList.remove('hidden'); return; }
        await busy($('button:not([type=button])', f), async () => {
          try { await rpc('customer_register_payment', { p_customer: c.id, p_amount: a, p_method: f.method.value, p_note: f.note.value || null }); close(true); }
          catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
        });
      });
    },
  }).then((v) => v === true);
}

function adjustForm(c) {
  return modal(`<h2>Ajuste de cuenta</h2><p class="muted small">${esc(c.name)} · saldo actual ${money(c.balance)}</p>
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Tipo</span><select name="sign"><option value="1">Aumenta la deuda (cargo)</option><option value="-1">Reduce la deuda (descuento / saldo a favor)</option></select></label>
      <label class="field"><span>Monto</span><input name="amount" inputmode="decimal" required></label>
      <label class="field"><span>Motivo (obligatorio)</span><input name="note" maxlength="300" required></label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Guardar</button></div></form>`, {
    onMount: (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden'); const a = num(f.amount.value);
        if (!(a > 0) || !f.note.value.trim()) { err.textContent = 'Ingrese un monto mayor a 0 y el motivo.'; err.classList.remove('hidden'); return; }
        await busy($('button:not([type=button])', f), async () => {
          try { await rpc('customer_adjust', { p_customer: c.id, p_amount: a * Number(f.sign.value), p_note: f.note.value }); close(true); }
          catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
        });
      });
    },
  }).then((v) => v === true);
}

// Alta / edición de cliente. Devuelve { id, name } o null. La usa también el carrito del proveedor.
export function customerForm(c) {
  const adm = isAdm(); const isNew = !c;
  return modal(`<h2>${isNew ? 'Nuevo cliente' : 'Editar cliente'}</h2>
    <form id="f" class="stack" novalidate>
      <label class="field"><span>Nombre o razón social</span><input name="name" value="${esc(c?.name || '')}" maxlength="120" required></label>
      <label class="field"><span>Teléfono</span><input name="phone" inputmode="tel" value="${esc(c?.phone || '')}" maxlength="40"></label>
      <label class="field"><span>Correo</span><input name="email" type="email" value="${esc(c?.email || '')}" maxlength="120"></label>
      <label class="field"><span>Dirección</span><input name="address" value="${esc(c?.address || '')}" maxlength="200"></label>
      <label class="field"><span>CUIT / DNI (opcional)</span><input name="tax_id" value="${esc(c?.tax_id || '')}" maxlength="40"></label>
      <label class="field"><span>Notas</span><textarea name="notes" maxlength="500">${esc(c?.notes || '')}</textarea></label>
      ${adm ? `<label class="field"><span>Plazo de pago (días)</span><input name="credit_days" inputmode="numeric" value="${c?.credit_days ?? 30}"></label>
      <label class="field"><span>Disponible para</span><select name="supplier_id"><option value="">Todos los proveedores</option></select></label>
      <label class="check"><input type="checkbox" name="active" ${c?.active === false ? '' : 'checked'}> Cliente activo</label>` : ''}
      <p class="notice bad hidden" id="err" role="alert"></p>
      <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button class="btn primary grow">Guardar</button></div></form>`, {
    onMount: async (ov, close) => {
      const f = $('#f', ov); const err = $('#err', ov);
      if (adm) {
        const sup = (await read((s) => s.from('suppliers').select('id,company_name').eq('active', true).order('company_name')).catch(() => ({ data: [] }))).data || [];
        f.supplier_id.innerHTML += sup.map((s) => `<option value="${s.id}" ${s.id === c?.supplier_id ? 'selected' : ''}>${esc(s.company_name)}</option>`).join('');
      }
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.classList.add('hidden');
        if (!f.name.value.trim()) { err.textContent = 'El nombre es obligatorio.'; err.classList.remove('hidden'); return; }
        await busy($('button:not([type=button])', f), async () => {
          try {
            const id = await rpc('save_customer', {
              p_id: c?.id ?? null, p_name: f.name.value, p_phone: f.phone.value || null, p_email: f.email.value || null, p_address: f.address.value || null,
              p_tax_id: f.tax_id.value || null, p_notes: f.notes.value || null,
              p_credit_days: adm ? Math.max(0, Math.min(365, parseInt(f.credit_days.value, 10) || 0)) : null,
              p_supplier_id: adm ? f.supplier_id.value || null : null, p_active: adm ? f.active.checked : true,
            });
            close({ id, name: f.name.value.trim() });
          } catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
        });
      });
    },
  }).then((v) => (v && v.id ? v : null));
}
