// Comisiones de preventistas: tarjeta "Mi comisión" (el preventista) y ficha de configuración/pago (administración).
import { state, bus } from '../state.js';
import { rpc, friendly } from '../api.js';
import { esc, money, dateTime } from '../format.js';
import { $, busy, ok, fail, modal, icon } from '../ui.js';
import { parseMoney } from '../cash-utils.js';

export const BASE_LABEL = { VENTAS: 'sobre lo vendido', GANANCIA: 'sobre la ganancia' };
const pctText = (n) => `${String(Number(n)).replace('.', ',')}%`;

// Tarjeta para el preventista: cuánto lleva ganado este mes, cuánto cobró y cuánto se le debe.
export function commissionCardHtml(s, { live = false } = {}) {
  const head = `<div class="row between"><h3>${icon('wallet')} Comisión en tiempo real</h3>${live ? '<span class="live-dot" title="Se actualiza sola"><i></i>En vivo</span>' : ''}</div>`;
  if (!s) return '';
  if (!s.configured) return `<section class="card stack cm-card" aria-label="Mi comisión">${head}<p class="muted">Todavía no tiene una comisión asignada. Cuando el administrador la configure, acá va a ver lo que va ganando y lo que le falta cobrar.</p></section>`;
  return `<section class="card stack cm-card" aria-label="Mi comisión">
    ${head}<span class="status s-ok" style="align-self:flex-start">${esc(pctText(s.pct))} ${esc(BASE_LABEL[s.base] || '')}</span>
    <div class="cm-grid">
      <div><small class="muted">Ganado este mes</small><b class="mono">${esc(money(s.month.earned))}</b><small class="muted">${s.month.orders} pedido${s.month.orders === 1 ? '' : 's'} entregado${s.month.orders === 1 ? '' : 's'}</small></div>
      <div><small class="muted">Ya cobrado</small><b class="mono">${esc(money(s.paid_total))}</b></div>
      <div><small class="muted">Te falta cobrar</small><b class="mono">${esc(money(s.balance))}</b></div>
    </div>
    ${(s.payouts || []).length ? `<details><summary class="small">Últimos pagos recibidos</summary>${s.payouts.slice(0, 8).map((p) => `<div class="row between small"><span>${esc(dateTime(p.at))} · ${esc(p.method)}</span><b class="mono">${esc(money(p.amount))}</b></div>`).join('')}</details>` : ''}
    ${(s.orders || []).length ? `<details><summary class="small">Detalle de este mes</summary>${s.orders.slice(0, 40).map((o) => `<div class="row between small"><span class="ellipsis">${esc(o.order_number)} · ${esc(o.customer)}</span><b class="mono">${esc(money(o.amount))}</b></div>`).join('')}</details>` : ''}
    <p class="muted small">La comisión se calcula cuando el pedido se entrega.${live && s.__at ? ` Actualizado ${esc(s.__at)}.` : ''}</p></section>`;
}

// Monta la tarjeta y la mantiene al día: se refresca al llegar un aviso (p. ej. pedido entregado), cada 30 s y al volver a la app.
export function mountLiveCommission(box) {
  let dead = false; let busy = false;
  const load = async () => {
    if (dead || busy) return; busy = true;
    try {
      const s = await rpc('commission_summary', {}); if (dead) return;
      s.__at = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      box.innerHTML = commissionCardHtml(s, { live: true });
    } catch (e) {
      if (!dead && !box.innerHTML) box.innerHTML = `<section class="card stack cm-card"><h3>${icon('wallet')} Comisión en tiempo real</h3><p class="notice bad small">No se pudo cargar la comisión: ${esc(friendly(e))}. Pida al administrador que instale la actualización 16 en Supabase.</p></section>`;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { if (!document.hidden) load(); }, 30000);
  const vis = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', vis);
  const off = bus.on('notification', () => setTimeout(load, 800));
  load();
  return { dispose: () => { dead = true; clearInterval(timer); document.removeEventListener('visibilitychange', vis); off?.(); }, refresh: load };
}

export async function mountMyCommission(box) { return mountLiveCommission(box); }

// Ficha para administración: configurar porcentaje/base (solo administrador principal) y registrar pagos.
export function commissionModal(supplierId, name) {
  const principal = state.profile?.role === 'admin_principal';
  return modal(`<h2>Comisión · ${esc(name || 'Preventista')}</h2><div id="cmb" class="stack"><p class="muted small">Cargando…</p></div>`, {
    onMount: (ov, close) => {
      const body = $('#cmb', ov);
      async function load() {
        let s;
        try { s = await rpc('commission_summary', { p_supplier: supplierId }); } catch (e) { body.innerHTML = `<p class="notice bad">${esc(friendly(e))}</p><button class="btn block" data-close>Cerrar</button>`; return; }
        body.innerHTML = `
          <div class="cm-grid"><div><small class="muted">Ganado este mes</small><b class="mono">${esc(money(s.month.earned))}</b></div>
            <div><small class="muted">Pagado en total</small><b class="mono">${esc(money(s.paid_total))}</b></div>
            <div><small class="muted">Se le debe</small><b class="mono">${esc(money(s.balance))}</b></div></div>
          ${principal ? `<form id="cf" class="stack" novalidate><h4>Configuración</h4>
            <label class="field"><span>Porcentaje de comisión (0 = sin comisión)</span><input name="pct" inputmode="decimal" value="${esc(String(s.pct).replace('.', ','))}"></label>
            <label class="field"><span>Se calcula</span><select name="base"><option value="VENTAS" ${s.base === 'VENTAS' ? 'selected' : ''}>Sobre lo vendido (total entregado)</option><option value="GANANCIA" ${s.base === 'GANANCIA' ? 'selected' : ''}>Sobre la ganancia (venta − costo)</option></select></label>
            <p class="muted small">Rige para los pedidos que se entreguen desde ahora; los ya entregados conservan su comisión.</p>
            <button class="btn primary block">Guardar comisión</button></form>`
            : `<p class="muted small">Comisión actual: ${esc(pctText(s.pct))} ${esc(BASE_LABEL[s.base] || '')}. Solo el administrador principal puede cambiarla.</p>`}
          <form id="pf2" class="stack" novalidate><h4>Registrar un pago</h4>
            <label class="field"><span>Monto</span><input name="amt" inputmode="decimal" placeholder="${esc(String(Number(s.balance)).replace('.', ','))}"></label>
            <label class="field"><span>Medio</span><select name="m"><option>Efectivo</option><option>Mercado Pago</option><option>Transferencia</option><option>Otro</option></select></label>
            <label class="field"><span>Nota (opcional)</span><input name="note" maxlength="200"></label>
            <button class="btn accent block" ${Number(s.balance) > 0 ? '' : 'disabled'}>Registrar pago</button></form>
          ${(s.payouts || []).length ? `<h4>Pagos anteriores</h4>${s.payouts.map((p) => `<div class="row between small"><span>${esc(dateTime(p.at))} · ${esc(p.method)}${p.note ? ' · ' + esc(p.note) : ''}</span><b class="mono">${esc(money(p.amount))}</b></div>`).join('')}` : ''}
          <button type="button" class="btn block" data-close>Cerrar</button>`;
        $('#cf', body)?.addEventListener('submit', async (e) => {
          e.preventDefault(); const f = e.currentTarget; const pct = parseMoney(f.pct.value);
          if (pct === null || pct < 0 || pct > 100) { fail('Escriba un porcentaje entre 0 y 100.'); return; }
          await busy($('button', f), async () => { try { await rpc('admin_set_commission', { p_supplier: supplierId, p_pct: pct, p_base: f.base.value }); ok('Comisión guardada'); await load(); } catch (x) { fail(friendly(x)); } });
        });
        $('#pf2', body).addEventListener('submit', async (e) => {
          e.preventDefault(); const f = e.currentTarget; const amt = parseMoney(f.amt.value);
          if (amt === null || amt <= 0) { fail('Escriba el monto a pagar.'); return; }
          await busy($('button', f), async () => { try { await rpc('commission_pay', { p_supplier: supplierId, p_amount: amt, p_method: f.m.value, p_note: f.note.value.trim() || null }); ok('Pago registrado'); await load(); } catch (x) { fail(friendly(x)); } });
        });
      }
      load();
    },
  });
}
