import { supabase } from '../supa.js';
import { friendly } from '../api.js';
import { bus } from '../state.js';
import { esc } from '../format.js';
import { icon, logoSvg, $, busy, themeButton } from '../ui.js';
import { bioEnabled, bioSupported, bioVerify } from '../bio.js';

const ready = () => { window.__appReady = true; };
const brand = `<div class="brand"><div class="logo">${logoSvg}</div><div><b>Depósito</b><div class="muted small">Gestión de stock y pedidos</div></div></div>`;

export function renderLogin(app) {
  ready();
  app.innerHTML = `<div class="aurora"></div>${themeButton('iconbtn fab')}<div class="authwrap">${brand}
    <form class="card stack" id="f" novalidate>
      <label class="field"><span>Correo electrónico</span><input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" required></label>
      <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <button class="btn primary block" type="submit">Ingresar</button>
    </form>
    <p class="muted small" style="margin-top:14px">Si no tiene cuenta, solicítela al administrador del depósito.</p></div>`;
  showBioLogin(app);
  const f = $('#f', app);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err', app); err.classList.add('hidden');
    const email = f.email.value.trim(); const password = f.password.value;
    if (!email || !password) { err.textContent = 'Ingrese su correo y contraseña.'; err.classList.remove('hidden'); return; }
    await busy($('button', f), async () => {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data?.session) bus.emit('login', data.session); // arranca la sesión sin esperar el evento de la librería
      } catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
    });
  });
}

export function renderPending(app, profile, onLogout) {
  ready();
  const inactive = profile && profile.role && !profile.active;
  app.innerHTML = `<div class="aurora"></div>${themeButton('iconbtn fab')}<div class="authwrap">${brand}<div class="card stack">
    <h2>${inactive ? 'Cuenta desactivada' : 'Cuenta pendiente de activación'}</h2>
    <p class="muted">${inactive
      ? 'El administrador desactivó su cuenta. Comuníquese con el depósito.'
      : 'Su usuario fue creado pero todavía no tiene un rol asignado. Pida al administrador que lo active y vuelva a ingresar.'}</p>
    ${profile?.email ? `<p class="small muted">${esc(profile.email)}</p>` : ''}
    <button class="btn block" id="re">${icon('refresh')} Comprobar de nuevo</button>
    <button class="btn ghost block" id="out">${icon('logout')} Cerrar sesión</button></div></div>`;
  $('#re', app).addEventListener('click', () => location.reload());
  $('#out', app).addEventListener('click', onLogout);
}

export function renderOffline(app, msg, onRetry, onLogout) {
  ready();
  app.innerHTML = `<div class="aurora"></div>${themeButton('iconbtn fab')}<div class="authwrap">${brand}<div class="card stack">
    <h2>No se pudo conectar</h2><p class="notice bad">${esc(msg)}</p>
    <button class="btn primary block" id="re">Reintentar</button>
    <button class="btn ghost block" id="out">Cerrar sesión</button></div></div>`;
  $('#re', app).addEventListener('click', onRetry);
  $('#out', app).addEventListener('click', onLogout);
}

export function renderSetupError(app) {
  ready();
  app.innerHTML = `<div class="aurora"></div>${themeButton('iconbtn fab')}<div class="authwrap">${brand}<div class="card stack">
    <h2>Falta configurar Supabase</h2>
    <p class="notice bad">Esta publicación no tiene la URL y la clave pública de Supabase.</p>
    <p class="muted">Ejecute <b>publicar.bat</b> (o <code>npm run build</code> con las variables SUPABASE_URL y SUPABASE_ANON_KEY) y vuelva a publicar.</p></div></div>`;
}

// Si en este dispositivo hay una cuenta con huella o rostro activado y su sesión guardada, se ofrece entrar con eso.
async function showBioLogin(app) {
  try {
    if (!supabase || !(await bioSupported())) return;
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid || !bioEnabled(uid) || !$('#f', app)) return;
    const box = document.createElement('div');
    box.className = 'card stack biologin';
    box.innerHTML = `<button type="button" class="lockbtn" id="bl" aria-label="Ingresar con huella o rostro">${icon('fingerprint')}</button>
      <b>Ingresar con huella o rostro</b><p class="muted small ellipsis">${esc(data.session.user.email || '')}</p>
      <p class="notice bad hidden" id="ble" role="alert"></p>
      <button type="button" class="btn ghost block" id="bo">Usar otra cuenta o contraseña</button>`;
    $('#f', app).before(box);
    const err = $('#ble', box);
    $('#bl', box).addEventListener('click', async (e) => {
      const btn = e.currentTarget; if (btn.classList.contains('busy')) return;
      btn.classList.add('busy'); err.classList.add('hidden');
      try {
        await bioVerify(uid);
        const { data: d2 } = await supabase.auth.getSession();
        if (!d2?.session) throw Object.assign(new Error('La sesión venció. Ingrese con su contraseña.'), { plain: true });
        bus.emit('login', d2.session);
      } catch (x) {
        err.textContent = x?.plain ? x.message : (x?.name === 'NotAllowedError' ? 'Se canceló o no se pudo verificar. Vuelva a intentar.' : 'No se pudo verificar la identidad. Vuelva a intentar o use su contraseña.');
        err.classList.remove('hidden');
      } finally { btn.classList.remove('busy'); }
    });
    $('#bo', box).addEventListener('click', () => bus.emit('fullLogout'));
  } catch { /* sin biometría: queda el ingreso normal */ }
}
