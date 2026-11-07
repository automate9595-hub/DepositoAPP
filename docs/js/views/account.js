import { supabase } from '../supa.js';
import { state, bus } from '../state.js';
import { read, rpc, friendly } from '../api.js';
import { esc, dateTime, roleLabel } from '../format.js';
import { icon, $, $$, busy, ok, fail, emptyBox, errorBox, spinner } from '../ui.js';
import { themePref, setTheme } from '../theme.js';
import { soundEnabled, setSound, previewSound } from '../sound.js';
import { bioSupported, bioEnabled, bioEnable, bioDisable, bioVerify } from '../bio.js';

const APP_VERSION = (() => { try { return new URL(import.meta.url).searchParams.get('v') || ''; } catch { return ''; } })();

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
    <div class="card stack"><h3>Apariencia y sonido</h3>
      <div class="seg" id="theme" role="group" aria-label="Tema">${[['auto', 'Automático', 'refresh'], ['light', 'Claro', 'sun'], ['dark', 'Oscuro', 'moon']].map(([k, l, i]) => `<button type="button" data-th="${k}" class="${themePref() === k ? 'on' : ''}">${icon(i)}${l}</button>`).join('')}</div>
      <div class="row between"><div class="grow"><b>Sonido de avisos</b><div class="muted small">Suena cuando llega un pedido o cambia su estado.</div></div>
        <button type="button" class="switch" id="sw" role="switch" aria-label="Sonido de avisos" aria-checked="${soundEnabled()}"></button></div>
      <button type="button" class="btn sm" id="tst">${icon('volume')} Probar sonido</button>
    </div>
    <div class="card stack" id="biocard"><h3>Acceso con huella o rostro</h3><p class="muted small">Comprobando el dispositivo…</p></div>
    <div class="card stack"><h3>Aplicación</h3>
      ${notifOk ? `<button class="btn block" id="np">${icon('bell')} Activar avisos del sistema</button>
      <p class="muted small">Con la app abierta o en segundo plano, el teléfono mostrará un aviso cuando llegue algo nuevo. Si Android cierra la app por completo, verá los avisos al volver a abrirla.</p>` : ''}
      <button class="btn block ${installEvt ? '' : 'hidden'}" id="ins">Instalar en el teléfono</button>
      <button class="btn block" id="upd">${icon('refresh')} Buscar actualización</button>
      <p class="muted small">La aplicación se actualiza sola cuando se publica una versión nueva.${APP_VERSION ? ` Versión instalada: <span class="mono">${esc(APP_VERSION)}</span>` : ''}</p>
    </div>
    <button class="btn danger block" id="out">${icon('logout')} Cerrar sesión</button></div>`;

  $$('[data-th]', el).forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.th); $$('[data-th]', el).forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#sw', el).addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-checked') !== 'true'; setSound(on); e.currentTarget.setAttribute('aria-checked', String(on)); });
  const syncSw = () => $('#sw', el)?.setAttribute('aria-checked', String(soundEnabled()));
  document.addEventListener('soundchange', syncSw);
  $('#tst', el).addEventListener('click', () => { if (!previewSound('order')) fail('Este navegador no permite reproducir sonido.'); });
  renderBio();
  async function renderBio() {
    const box = $('#biocard', el); if (!box) return;
    const supported = await bioSupported();
    if (!$('#biocard', el)) return;   // se cambió de pantalla mientras se comprobaba
    if (!supported) {
      box.innerHTML = `<h3>${icon('fingerprint')} Acceso con huella o rostro</h3><p class="muted small">Este dispositivo o navegador no ofrece huella ni reconocimiento facial para aplicaciones web (hace falta una conexión segura https y un bloqueo de pantalla configurado en el teléfono o la computadora).</p>`;
      return;
    }
    const on = bioEnabled(p.id);
    box.innerHTML = `<h3>${icon('fingerprint')} Acceso con huella o rostro</h3>
      <p class="muted small">${on ? 'Activado en este dispositivo: al abrir la app se pide huella o rostro. También se pide al volver tras 2 minutos fuera.' : 'Entre más rápido y seguro: el teléfono verifica su huella o su rostro con el sensor o la cámara del dispositivo. La aplicación nunca recibe su cara ni su huella.'}</p>
      ${on ? `<div class="row"><button type="button" class="btn grow" id="bt">Probar ahora</button><button type="button" class="btn danger grow" id="bd">Desactivar</button></div>`
           : `<button type="button" class="btn primary block" id="be">${icon('fingerprint')} Activar en este dispositivo</button>`}
      <p class="muted small">Al tocar «Cerrar sesión», la cuenta queda bloqueada y en la pantalla de ingreso aparece «Ingresar con huella o rostro». Allí también puede elegir «Usar otra cuenta o contraseña» para cerrar la sesión por completo. Cada dispositivo se activa por separado.</p>`;
    $('#be', box)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await bioEnable({ id: p.id, email: p.email, full_name: p.full_name }); ok('Acceso biométrico activado'); }
      catch (x) { fail(x?.name === 'NotAllowedError' ? 'Se canceló la verificación. No se activó.' : (x?.message || 'No se pudo activar el acceso biométrico.')); }
      renderBio();
    }));
    $('#bt', box)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try { await bioVerify(p.id); ok('Verificación correcta'); } catch (x) { fail(x?.name === 'NotAllowedError' ? 'Se canceló la verificación.' : 'No se pudo verificar la identidad.'); }
    }));
    $('#bd', box)?.addEventListener('click', () => { bioDisable(p.id); ok('Acceso biométrico desactivado'); renderBio(); });
  }
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
    if (reg.waiting) { ok('Instalando la versión nueva…'); reg.waiting.postMessage('SKIP_WAITING'); } else ok('Ya tiene la última versión');
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
