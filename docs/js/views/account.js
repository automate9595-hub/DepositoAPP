import { supabase } from '../supa.js';
import { state, bus } from '../state.js';
import { read, rpc, friendly } from '../api.js';
import { esc, dateTime, roleLabel } from '../format.js';
import { icon, $, busy, ok, fail, emptyBox, errorBox, spinner } from '../ui.js';

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });

export async function accountView(el) {
  const p = state.profile;
  const notifOk = 'Notification' in window;
  el.innerHTML = `<div class="stack">
    <div class="card stack">
      <div><h2>${esc(p.full_name || 'Sin nombre')}</h2><div class="muted small">${esc(p.email || '')} · ${esc(roleLabel(p.role))}</div></div>
      <form id="pf" class="stack">
        <label class="field"><span>Nombre</span><input name="n" value="${esc(p.full_name)}" maxlength="120" required></label>
        <label class="field"><span>Teléfono</span><input name="t" value="${esc(p.phone || '')}" inputmode="tel" maxlength="40"></label>
        <button class="btn primary block">Guardar datos</button>
      </form>
    </div>
    <div class="card stack"><h3>Cambiar contraseña</h3>
      <form id="pw" class="stack">
        <label class="field"><span>Nueva contraseña (mínimo 8 caracteres)</span><input name="p" type="password" autocomplete="new-password" minlength="8" required></label>
        <button class="btn block">Cambiar contraseña</button>
      </form>
    </div>
    <div class="card stack"><h3>Aplicación</h3>
      ${notifOk ? `<button class="btn block" id="np">${icon('bell')} Activar avisos del sistema</button>
      <p class="muted small">Con la app abierta o en segundo plano, el teléfono mostrará un aviso cuando llegue algo nuevo. Si Android cierra la app por completo, verá los avisos al volver a abrirla.</p>` : ''}
      <button class="btn block ${installEvt ? '' : 'hidden'}" id="ins">Instalar en el teléfono</button>
      <button class="btn block" id="upd">${icon('refresh')} Buscar actualización</button>
    </div>
    <button class="btn danger block" id="out">${icon('logout')} Cerrar sesión</button></div>`;

  $('#pf', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy($('button', e.target), async () => {
      try {
        await rpc('update_my_profile', { p_full_name: e.target.n.value, p_phone: e.target.t.value });
        state.profile.full_name = e.target.n.value.trim(); state.profile.phone = e.target.t.value.trim();
        ok('Datos guardados');
      } catch (x) { fail(friendly(x)); }
    });
  });
  $('#pw', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = e.target.p.value;
    if (v.length < 8) return fail('La contraseña debe tener al menos 8 caracteres.');
    await busy($('button', e.target), async () => {
      const { error } = await supabase.auth.updateUser({ password: v });
      if (error) fail(friendly(error)); else { ok('Contraseña actualizada'); e.target.reset(); }
    });
  });
  $('#np', el)?.addEventListener('click', async () => {
    const r = await Notification.requestPermission();
    r === 'granted' ? ok('Avisos activados') : fail('El permiso fue rechazado. Puede activarlo desde los ajustes del navegador.');
  });
  $('#ins', el).addEventListener('click', async () => { if (installEvt) { installEvt.prompt(); installEvt = null; $('#ins', el).classList.add('hidden'); } });
  $('#upd', el).addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return ok('La aplicación ya está actualizada');
    await reg.update().catch(() => {});
    ok(reg.waiting ? 'Hay una versión nueva: pulse "Actualizar" en el aviso' : 'Ya tiene la última versión');
  });
  $('#out', el).addEventListener('click', () => bus.emit('logout'));
}

const PAGE = 20;
export async function noticesView(el, ctx) {
  let page = 0; let items = [];
  el.innerHTML = `<div class="stack"><div class="row between"><h2>Avisos</h2><button class="btn sm" id="all">Marcar leídos</button></div><div id="l" class="list"></div><button class="btn block hidden" id="more">Ver más</button></div>`;
  const list = $('#l', el); const more = $('#more', el);
  async function load(reset) {
    if (reset) { page = 0; items = []; list.innerHTML = spinner(); }
    try {
      const { data } = await read((s) => s.from('notifications').select('id,title,body,order_id,read,created_at').order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1));
      items = items.concat(data || []);
      more.classList.toggle('hidden', (data || []).length < PAGE);
      draw();
    } catch (e) { list.innerHTML = errorBox(friendly(e)); $('[data-retry]', list)?.addEventListener('click', () => load(true)); }
  }
  function draw() {
    list.innerHTML = items.length ? items.map((n) => `<div class="card click" data-id="${n.id}" data-o="${n.order_id || ''}">
      <div class="row between"><b>${esc(n.title)}</b>${n.read ? '' : '<span class="status s-warn">Nuevo</span>'}</div>
      <div class="muted">${esc(n.body || '')}</div><div class="muted small">${dateTime(n.created_at)}</div></div>`).join('') : emptyBox('No tiene avisos.');
  }
  async function markRead(ids) {
    try { await rpc('mark_notifications_read', { p_ids: ids }); bus.emit('refresh-unread'); } catch { /* no crítico */ }
  }
  list.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-id]'); if (!c) return;
    const n = items.find((x) => x.id === c.dataset.id);
    if (n && !n.read) { n.read = true; markRead([n.id]); }
    if (c.dataset.o) ctx.navigate('#/pedidos/' + c.dataset.o); else draw();
  });
  more.addEventListener('click', () => { page += 1; load(false); });
  $('#all', el).addEventListener('click', async (e) => {
    await busy(e.currentTarget, async () => { try { await rpc('mark_notifications_read', {}); items.forEach((n) => (n.read = true)); draw(); bus.emit('unread', 0); } catch (x) { fail(friendly(x)); } });
  });
  await load(true);
  const off = bus.on('notification', () => load(true));
  return { dispose: off, refresh: () => load(true) };
}
