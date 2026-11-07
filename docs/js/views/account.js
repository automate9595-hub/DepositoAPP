import { supabase } from '../supa.js';
import { state, bus } from '../state.js';
import { read, rpc, friendly } from '../api.js';
import { esc, dateTime, roleLabel } from '../format.js';
import { icon, $, $$, busy, ok, fail, emptyBox, errorBox, spinner, modal } from '../ui.js';
import { themePref, setTheme } from '../theme.js';
import { soundEnabled, setSound, previewSound } from '../sound.js';
import { bioSupported, bioEnabled, bioEnable, bioDisable, bioVerify, bioLockMinutes, setBioLockMinutes, bioServerRegistered, bioCredId, passkeyLogin, errDetail, explainError, LOCK_CHOICES } from '../bio.js';
import { config } from '../supa.js';

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
  // Asistente visual: activa y prueba la huella paso a paso, mostrando qué anda bien y qué no
  function wizard(mode) {
    const base = String(config.SUPABASE_URL).replace(/\/+$/, '');
    const steps = mode === 'enable'
      ? ['Registrar su huella en este dispositivo', 'Guardar la clave en el sistema', 'Probar el ingreso completo']
      : ['Verificar su huella en este dispositivo', 'Probar el ingreso completo con el servidor'];
    const device = /Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone/iPad' : /Windows/i.test(navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.userAgent) ? 'Mac' : 'Dispositivo';
    return modal(`<h2>${mode === 'enable' ? 'Activar la huella' : 'Probar la huella'}</h2>
      <p class="muted small">Siga las indicaciones del teléfono cuando se lo pida. Cada paso se marca cuando termina.</p>
      <ol class="wiz">${steps.map((t, i) => `<li data-i="${i}"><span class="wz-ico"></span><div class="grow"><b>${t}</b><p class="small muted"></p></div></li>`).join('')}</ol>
      <div id="wz-end"></div><button type="button" class="btn block" data-close style="margin-top:14px">Cerrar</button>`, {
      onMount: async (ov) => {
        let cur = 0;
        const mark = (i, st, msg = '') => {
          const li = ov.querySelector(`[data-i="${i}"]`); if (!li) return; li.dataset.s = st; cur = i;
          li.querySelector('.wz-ico').innerHTML = st === 'ok' ? icon('check') : st === 'bad' ? icon('x') : st === 'run' ? '<i class="wz-spin"></i>' : '';
          li.querySelector('p').textContent = msg;
        };
        const end = (html) => { ov.querySelector('#wz-end').innerHTML = html; };
        try {
          if (mode === 'enable') {
            mark(0, 'run', 'Le pedirá la huella o el rostro…');
            await bioEnable({ id: p.id, email: p.email, full_name: p.full_name }, {
              label: device,
              register: (k) => rpc('register_passkey', { p_id: k.id, p_public_key: k.public_key, p_alg: k.alg, p_label: k.label }),
              onStage: (st) => { if (st === 'verified') { mark(0, 'ok', 'Huella verificada'); mark(1, 'run', 'Guardando…'); } },
            });
            mark(1, 'ok', 'Registrada en el sistema');
            mark(2, 'run', 'Vuelva a apoyar la huella para probar el ingreso…');
          } else {
            mark(0, 'run', 'Apoye la huella…'); await bioVerify(p.id); mark(0, 'ok', 'Huella verificada');
            mark(1, 'run', 'Apoye la huella otra vez…');
          }
          await passkeyLogin({ baseUrl: base, anonKey: config.SUPABASE_ANON_KEY });   // solo prueba: no abre otra sesión
          mark(mode === 'enable' ? 2 : 1, 'ok', 'Funciona');
          end('<p class="notice ok">Todo funciona. En la pantalla de ingreso toque «Ingresar con huella o rostro».</p>');
          renderBio();
        } catch (x) {
          mark(cur, 'bad', explainError(x));
          end(`<p class="notice bad small">${esc(explainError(x))}<br><small class="muted">${esc(errDetail(x))}</small></p>`);
          renderBio();
        }
      },
    });
  }

  renderBio();
  async function renderBio() {
    const box = $('#biocard', el); if (!box) return;
    const supported = await bioSupported();
    if (!$('#biocard', el)) return;   // se cambió de pantalla mientras se comprobaba
    if (!supported) {
      box.innerHTML = `<h3>${icon('fingerprint')} Acceso con huella o rostro</h3><p class="muted small">Este dispositivo o navegador no ofrece huella ni reconocimiento facial para aplicaciones web (hace falta una conexión segura https y un bloqueo de pantalla configurado en el teléfono o la computadora).</p>`;
      return;
    }
    const on = bioEnabled(p.id); const server = bioServerRegistered(p.id);
    const device = /Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone/iPad' : /Windows/i.test(navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.userAgent) ? 'Mac' : 'Dispositivo';
    box.innerHTML = `<h3>${icon('fingerprint')} Acceso con huella o rostro</h3>
      <p class="muted small">${on && server ? 'Activado y registrado en el sistema: en la pantalla de ingreso aparece «Ingresar con huella o rostro» y entra sin escribir correo ni contraseña. Además se pide la huella si estuvo fuera de la aplicación más del tiempo elegido.' : on ? 'Esta activación es antigua: solo bloquea la aplicación. Reactívela para poder ingresar con la huella sin correo ni contraseña.' : 'Ingrese más rápido y seguro: el teléfono verifica su huella o su rostro con el sensor o la cámara. La aplicación nunca recibe su cara ni su huella.'}</p>
      ${on ? `<label class="field"><span>Volver a pedir la huella después de</span><select id="bm">${LOCK_CHOICES.map((m) => `<option value="${m}" ${m === bioLockMinutes() ? 'selected' : ''}>${m} minutos fuera de la aplicación</option>`).join('')}</select></label>
        <div class="row"><button type="button" class="btn grow" id="bt">Probar ahora</button>${server ? '' : '<button type="button" class="btn primary grow" id="be">Reactivar</button>'}<button type="button" class="btn danger grow" id="bd">Desactivar</button></div>`
           : `<button type="button" class="btn primary block" id="be">${icon('fingerprint')} Activar en este dispositivo</button>`}
      <p class="muted small">Cada dispositivo se activa por separado. Si pierde el teléfono, desactive la huella desde otro dispositivo en esta misma pantalla.</p>`;
    $('#be', box)?.addEventListener('click', () => wizard('enable'));
    $('#bt', box)?.addEventListener('click', () => wizard('test'));
    $('#bm', box)?.addEventListener('change', (e) => { setBioLockMinutes(Number(e.target.value)); ok(`Se pedirá la huella tras ${e.target.value} minutos fuera de la aplicación`); });
    $('#bd', box)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const id = bioCredId(p.id);
      if (id) await rpc('delete_passkey', { p_id: id }).catch(() => {});   // se borra también del sistema
      bioDisable(p.id); ok('Acceso biométrico desactivado'); renderBio();
    }));
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
