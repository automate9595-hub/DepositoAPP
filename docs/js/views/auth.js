import { supabase, config } from '../supa.js';
import { friendly } from '../api.js';
import { bus } from '../state.js';
import { esc } from '../format.js';
import { icon, logoSvg, $, busy, themeButton } from '../ui.js';
import { bioEnabled, bioSupported, bioVerify, bioAccounts, bioServerRegistered, passkeyLogin, errDetail, explainError } from '../bio.js';

const ready = () => { window.__appReady = true; };
const brand = `<div class="brand"><div class="logo">${logoSvg}</div><div><b>Depósito</b><div class="muted small">Gestión de stock y pedidos</div></div></div>`;

let introShown = false;
const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
// Presentación de ~5 s al entrar al login (se puede saltar tocando la pantalla). Solo una vez por carga de la página.
const introHtml = `<div class="intro" id="intro" role="presentation"><div class="intro-sweep"></div><div class="intro-in">
  <div class="intro-mark"><div class="intro-glow"></div>
    <svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="ig" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6efd9"/><stop offset=".5" stop-color="#c9a24a"/><stop offset="1" stop-color="#9aa1ad"/></linearGradient></defs>
      <circle class="intro-ring" cx="60" cy="60" r="54"/><circle class="intro-ring r2" cx="60" cy="60" r="47"/>
      <g transform="translate(30 30) scale(2.5)"><path class="intro-cube" d="M21 16V8l-9-5-9 5v8l9 5 9-5z" pathLength="90"/><path class="intro-cube" d="M3.3 7 12 12l8.7-5M12 22V12" pathLength="90"/></g></svg></div>
  <div class="intro-name" aria-label="Depósito">${[...'DEPÓSITO'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
  <div class="intro-line"></div><div class="intro-tag">Gestión de stock y pedidos</div></div>
  <div class="intro-skip">Toque o haga clic para continuar</div></div>`;

export function renderLogin(app) {
  ready();
  const withIntro = !introShown && !reduced(); introShown = true;
  const wrapCls = withIntro ? ' has-intro' : '';
  app.innerHTML = `<div class="aurora"></div>${themeButton('iconbtn fab' + wrapCls)}<div class="authwrap${wrapCls}">${brand}
    <form class="card stack" id="f" novalidate>
      <label class="field"><span>Correo electrónico</span><input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" required></label>
      <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
      <p class="notice bad hidden" id="err" role="alert"></p>
      <button class="btn primary block" type="submit">Ingresar</button>
    </form>
    <p class="muted small" style="margin-top:14px">Si no tiene cuenta, solicítela al administrador del depósito.</p></div>`;
  if (withIntro) {
    app.insertAdjacentHTML('beforeend', introHtml);
    const intro = $('#intro', app); let done = false;
    const end = (fast) => {
      if (done) return; done = true; clearTimeout(timer);
      if (fast) { intro.classList.add('skip'); app.querySelectorAll('.has-intro').forEach((n) => n.classList.remove('has-intro')); }
      setTimeout(() => intro.remove(), fast ? 400 : 700);
    };
    const timer = setTimeout(() => end(false), 5100);
    intro.addEventListener('click', () => end(true));
  }
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

// Botón «Ingresar con huella o rostro»: aparece siempre que el dispositivo lo permita y entra SIN correo ni contraseña.
// El servidor valida la firma de la huella y entrega un token de un solo uso con el que se abre la sesión.
async function showBioLogin(app) {
  try {
    if (!supabase || !$('#f', app) || !(await bioSupported())) return;
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    const legacy = !!uid && bioEnabled(uid) && !bioServerRegistered(uid);   // activación antigua: solo con sesión guardada
    const label = bioAccounts()[0]?.email || data?.session?.user?.email || '';
    const box = document.createElement('div');
    box.className = 'card stack biologin';
    box.innerHTML = `<button type="button" class="lockbtn" id="bl" aria-label="Ingresar con huella o rostro">${icon('fingerprint')}</button>
      <b>Ingresar con huella o rostro</b><p class="muted small ellipsis">${label ? esc(label) : 'Sin escribir correo ni contraseña'}</p>
      <p class="notice bad hidden" id="ble" role="alert"></p>`;
    $('#f', app).before(box);
    const err = $('#ble', box);
    $('#bl', box).addEventListener('click', async (e) => {
      const btn = e.currentTarget; if (btn.classList.contains('busy')) return;
      btn.classList.add('busy'); err.classList.add('hidden');
      try {
        if (legacy) {
          await bioVerify(uid);
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2?.session) throw Object.assign(new Error('La sesión venció. Ingrese con su contraseña.'), { plain: true });
          bus.emit('login', d2.session); return;
        }
        const token_hash = await passkeyLogin({ baseUrl: String(config.SUPABASE_URL).replace(/\/+$/, ''), anonKey: config.SUPABASE_ANON_KEY });
        let r = await supabase.auth.verifyOtp({ token_hash, type: 'email' });
        if (r.error) r = await supabase.auth.verifyOtp({ token_hash, type: 'magiclink' });
        if (r.error || !r.data?.session) throw Object.assign(new Error('No se pudo abrir la sesión. Ingrese con su contraseña.'), { plain: true });
        bus.emit('login', r.data.session);
      } catch (x) {
        const m = explainError(x) + (x?.name === 'NotAllowedError' || x?.name === 'AbortError' ? ' Ingrese con su contraseña y actívela en Cuenta.' : '');
        err.innerHTML = `${esc(m)}<br><small class="muted">${esc(errDetail(x))}</small>`; err.classList.remove('hidden');
      } finally { btn.classList.remove('busy'); }
    });
  } catch { /* sin biometría: queda el ingreso normal */ }
}
