import { supabase, configured, config } from './supa.js';
import { state, bus, initCart, cacheProfile, cachedProfile, clearProfileCache, role, can } from './state.js';
import { setLocale, esc } from './format.js';
import { icon, $, $$, toast, toastAction, errorBox, spinner, themeButton, soundButton, initEffects } from './ui.js';
import { initTheme } from './theme.js';
import { soundEnabled, soundChoiceMade, setSound, playSound, kindFor } from './sound.js';
import { friendly, read } from './api.js';
import { renderLogin, renderPending, renderSetupError, renderOffline } from './views/auth.js';
import { accountView, noticesView } from './views/account.js';
import { catalogView, cartView, supplierOrdersView } from './views/supplier.js';
import { adminOrdersView } from './views/admin-orders.js';
import { productsView, inventoryView } from './views/admin-catalog.js';
import { usersView, auditView } from './views/admin-users.js';
import { statsView } from './views/stats.js';
import { customersView } from './views/customers.js';
import { warehouseOrdersView } from './views/warehouse.js';
import { cartLines } from './cart.js';

const app = document.getElementById('app');
initTheme(); initEffects();
let current = null; let navSeq = 0; let channel = null; let wasDown = false; let started = null; let hiddenAt = 0;
const pendingKinds = new Set();

// ---------- Rutas por rol ----------
const NAV = {
  proveedor: [
    { path: 'catalogo', label: 'Catálogo', icon: 'grid', render: catalogView },
    { path: 'carrito', label: 'Carrito', icon: 'cart', render: cartView, badge: () => cartLines(state.cart) },
    { path: 'pedidos', label: 'Mis pedidos', icon: 'list', render: supplierOrdersView },
    { path: 'clientes', label: 'Clientes', icon: 'users', render: customersView },
    { path: 'cuenta', label: 'Cuenta', icon: 'user', render: accountView },
  ],
  deposito: [
    { path: 'pedidos', label: 'Pedidos', icon: 'clip', render: warehouseOrdersView },
    { path: 'cuenta', label: 'Cuenta', icon: 'user', render: accountView },
  ],
  admin: [
    { path: 'pedidos', label: 'Pedidos', icon: 'list', render: adminOrdersView, perm: 'orders' },
    { path: 'preparacion', label: 'Preparación', icon: 'clip', render: warehouseOrdersView, perm: 'orders' },
    { path: 'clientes', label: 'Clientes', icon: 'users', render: customersView, perm: 'customers' },
    { path: 'productos', label: 'Productos', icon: 'box', render: productsView, perm: 'products' },
    { path: 'inventario', label: 'Inventario', icon: 'layers', render: inventoryView, perm: 'inventory' },
    { path: 'usuarios', label: 'Usuarios', icon: 'users', render: usersView, perm: 'users' },
    { path: 'estadisticas', label: 'Estadísticas', icon: 'chart', render: statsView, perm: 'stats' },
    { path: 'auditoria', label: 'Auditoría', icon: 'shield', render: auditView, perm: 'audit' },
    { path: 'cuenta', label: 'Cuenta', icon: 'user', render: accountView },
  ],
};
const EXTRA = [{ path: 'avisos', label: 'Avisos', render: noticesView }];
const navFor = () => {
  const r = role();
  const list = r === 'proveedor' ? NAV.proveedor : r === 'deposito' ? NAV.deposito : NAV.admin;
  return list.filter((n) => !n.perm || can(n.perm));
};

// ---------- Conexión ----------
function setConn(kind) {
  const el = $('#conn'); const ban = $('#banner');
  if (!el) return;
  el.className = `conn ${kind === 'online' ? '' : kind === 'warn' ? 'warn' : 'off'}`;
  el.querySelector('b').textContent = kind === 'online' ? 'En línea' : kind === 'warn' ? 'Reconectando…' : 'Sin conexión';
  ban.innerHTML = kind === 'online' ? '' : `<div class="banner">${kind === 'off'
    ? 'Sin conexión: los datos pueden estar desactualizados y las operaciones no se guardan hasta reconectar.'
    : 'Reconectando con el servidor… los datos pueden estar desactualizados.'}</div>`;
}

// ---------- Estructura de pantalla ----------
function renderShell() {
  app.innerHTML = `
    <header class="topbar"><h1 id="title"></h1>
      <span class="conn" id="conn"><i></i><b>En línea</b></span>
      ${themeButton()}${soundButton()}
      <button class="iconbtn" id="bell" aria-label="Avisos">${icon('bell')}<span class="badge-dot hidden" id="bellN"></span></button>
    </header><div id="banner"></div>
    <main id="view" tabindex="-1"></main><nav class="bottomnav" id="nav" aria-label="Principal"></nav>`;
  $('#bell').addEventListener('click', () => { location.hash = '#/avisos'; });
  syncSoundBtn();
  renderNav();
  setConn(navigator.onLine ? (wasDown ? 'warn' : 'online') : 'off');
  updateBell();
}
function renderNav() {
  const nav = $('#nav'); if (!nav) return;
  const cur = location.hash.replace(/^#\/?/, '').split('/')[0];
  const items = navFor(); const sig = items.map((n) => n.path).join('|');
  if (nav.dataset.sig !== sig) { // se reconstruye solo si cambian las opciones; así las transiciones CSS se ven
    nav.dataset.sig = sig;
    nav.innerHTML = items.map((n) => `<a href="#/${n.path}" data-p="${n.path}">${icon(n.icon)}<span>${esc(n.label)}</span></a>`).join('');
  }
  items.forEach((n) => {
    const a = nav.querySelector(`[data-p="${n.path}"]`); if (!a) return;
    const on = n.path === cur; a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    const b = n.badge?.(); let c = a.querySelector('.nav-count');
    if (b) { if (!c) { c = document.createElement('i'); c.className = 'nav-count'; a.append(c); } if (c.textContent !== String(b)) { c.textContent = b; c.style.animation = 'none'; void c.offsetWidth; c.style.animation = ''; } }
    else c?.remove();
  });
}
function syncSoundBtn() { $('#snd')?.classList.toggle('muted-on', !soundEnabled()); }
document.addEventListener('soundchange', syncSoundBtn);
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-sound-toggle]')) return;
  const on = !soundEnabled(); setSound(on);
  toast(on ? 'Sonido de avisos activado' : 'Sonido de avisos silenciado', on ? 'ok' : '');
});
let lastUnread = 0;
function updateBell() {
  const n = $('#bellN'); if (!n) return;
  n.textContent = state.unread > 99 ? '99+' : String(state.unread);
  n.classList.toggle('hidden', state.unread <= 0);
  const b = $('#bell');
  if (state.unread > lastUnread && b) { b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring'); }
  lastUnread = state.unread;
  document.title = (state.unread > 0 ? `(${state.unread}) ` : '') + 'Depósito';
}
async function refreshUnread() {
  try {
    const { count } = await read((s) => s.from('notifications').select('id', { count: 'exact', head: true }).eq('read', false));
    state.unread = count || 0; updateBell();
  } catch { /* se reintenta al reconectar */ }
}
bus.on('unread', (n) => { state.unread = Math.max(0, n); updateBell(); });
bus.on('cart', renderNav);
bus.on('logout', () => logout());
bus.on('refresh-unread', () => refreshUnread());

// ---------- Enrutador ----------
async function route() {
  if (!state.profile) return;
  const seq = ++navSeq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const [path = '', ...args] = parts;
  const def = [...navFor(), ...EXTRA].find((n) => n.path === path);
  if (!def) { location.replace('#/' + navFor()[0].path); return; }
  current?.dispose?.(); current = null;
  const titleEl = $('#title'); titleEl.textContent = def.label;
  titleEl.classList.remove('swap'); void titleEl.offsetWidth; titleEl.classList.add('swap');
  renderNav();
  const v = $('#view');
  v.classList.remove('view-in');
  v.innerHTML = spinner();
  const ctx = {
    profile: state.profile, path, args, can, navigate: (h) => { location.hash = h; },
    setTitle: (t) => { $('#title').textContent = t; },
    seq: () => seq === navSeq,
  };
  try {
    const inst = await def.render(v, ctx);
    if (seq !== navSeq) { inst?.dispose?.(); return; }
    current = inst || null;
    window.scrollTo(0, 0);
    v.classList.remove('view-in'); void v.offsetWidth; v.classList.add('view-in');
    clearTimeout(route.t); route.t = setTimeout(() => v.classList.remove('view-in'), 950);
  } catch (e) {
    if (seq !== navSeq) return;
    v.innerHTML = errorBox(friendly(e));
    $('[data-retry]', v)?.addEventListener('click', route);
  }
}
window.addEventListener('hashchange', route);

// ---------- Tiempo real con reconexión y re-sincronización ----------
function flushRefresh() {
  const kinds = [...pendingKinds]; pendingKinds.clear();
  try { current?.refresh?.(kinds); } catch (e) { console.error(e); }
}
let flushT = null;
function queueRefresh(kind) { pendingKinds.add(kind); clearTimeout(flushT); flushT = setTimeout(flushRefresh, 1200); }

function systemNotify(n) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((r) => r.showNotification(n.title, { body: n.body || '', tag: n.id, icon: './icons/icon-192.png', data: { order: n.order_id } })).catch(() => {});
}
function onNotification(n) {
  state.unread += 1; updateBell();
  playSound(kindFor(n.title));
  toast(`${n.title}${n.body ? ' · ' + n.body : ''}`);
  systemNotify(n);
  bus.emit('notification', n);
  queueRefresh('orders');
}
function startRealtime(uid) {
  stopRealtime();
  channel = supabase.channel('app-' + uid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => queueRefresh('orders'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => queueRefresh('inventory'))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, (p) => onNotification(p.new))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setConn(navigator.onLine ? 'online' : 'off');
        if (wasDown) { wasDown = false; resync(); }
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        wasDown = true; setConn(navigator.onLine ? 'warn' : 'off');
      }
    });
}
function stopRealtime() { if (channel) { supabase.removeChannel(channel); channel = null; } }
function resync() { refreshUnread(); pendingKinds.add('resync'); flushRefresh(); }
window.addEventListener('online', () => { setConn('warn'); wasDown = true; resync(); });
window.addEventListener('offline', () => { wasDown = true; setConn('off'); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (state.profile && Date.now() - hiddenAt > 20000) resync();
});

// ---------- Sesión ----------
async function loadProfile(user) {
  try {
    const { data } = await read((s) => s.from('profiles').select('id,email,role,full_name,phone,active,permissions').eq('id', user.id).maybeSingle());
    if (data) cacheProfile(data);
    return data;
  } catch (e) {
    if (e.network) { const c = cachedProfile(user.id); if (c) return c; }
    throw e;
  }
}
async function startSession(session) {
  if (!session?.user) return;
  if (started === session.user.id && state.profile) return;
  started = session.user.id;
  state.user = session.user;
  let prof;
  try { prof = await loadProfile(session.user); }
  catch (e) { started = null; renderOffline(app, friendly(e), () => startSession(session), logout); return; }
  if (!prof || !prof.active || !prof.role) { state.profile = null; renderPending(app, prof, logout); return; }
  state.profile = prof;
  initCart(prof.id);
  renderShell();
  startRealtime(prof.id);
  refreshUnread();
  offerSound();
  if (!location.hash || location.hash === '#') location.replace('#/' + navFor()[0].path);
  route();
}
function offerSound() {
  if (soundChoiceMade() || role() === 'proveedor') return;
  setTimeout(() => toastAction('¿Quiere escuchar un sonido cuando lleguen pedidos?', 'Activar', () => setSound(true)), 1500);
}
async function logout() {
  stopRealtime(); started = null; current?.dispose?.(); current = null;
  try { await supabase.auth.signOut(); } catch { /* sesión local se limpia igual */ }
  state.user = null; state.profile = null; state.unread = 0; clearProfileCache();
  location.hash = '';
  renderLogin(app);
}

// ---------- Service worker y actualización automática ----------
// Cada vez que se publica una versión nueva en GitHub, la app la detecta sola (al abrir, al volver a primer plano,
// al recuperar Internet y cada 5 minutos) y se actualiza sin que el usuario haga nada.
const safeToReload = () => document.hidden || (!document.querySelector('.overlay') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName));
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.goto && state.profile) location.hash = e.data.goto; });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    let announced = false;
    const apply = () => {
      if (!reg.waiting) return;
      if (!safeToReload()) { setTimeout(apply, 4000); return; } // no interrumpe formularios ni ventanas abiertas
      if (!announced && !document.hidden) { announced = true; toast('Actualizando a la última versión…', 'ok', 1500); }
      setTimeout(() => reg.waiting?.postMessage('SKIP_WAITING'), announced && !document.hidden ? 900 : 0);
    };
    if (reg.waiting && navigator.serviceWorker.controller) apply();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) apply(); });
    });
    const check = () => reg.update().catch(() => {});
    setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);
    check();
  }).catch(() => {});
}

// ---------- Arranque ----------
async function boot() {
  setupSW();
  if (!configured) { renderSetupError(app); return; }
  setLocale(config.CURRENCY, config.LOCALE);
  supabase.auth.onAuthStateChange((evt, session) => {
    // No se llaman métodos de supabase dentro del callback (evita bloqueos): se difiere
    setTimeout(() => {
      if (evt === 'SIGNED_OUT' && state.user) { stopRealtime(); started = null; state.user = null; state.profile = null; renderLogin(app); }
      else if (evt === 'SIGNED_IN' && session) startSession(session);
    }, 0);
  });
  let session = null;
  try { ({ data: { session } } = await supabase.auth.getSession()); } catch { /* sin red al abrir */ }
  if (session) await startSession(session); else renderLogin(app);
}
boot();
