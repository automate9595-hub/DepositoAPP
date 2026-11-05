import { supabase, configured, config } from './supa.js';
import { state, bus, initCart, cacheProfile, cachedProfile, clearProfileCache, role, can } from './state.js';
import { setLocale, esc } from './format.js';
import { icon, $, $$, toast, errorBox, spinner } from './ui.js';
import { friendly, read } from './api.js';
import { renderLogin, renderPending, renderSetupError, renderOffline } from './views/auth.js';
import { accountView, noticesView } from './views/account.js';
import { catalogView, cartView, supplierOrdersView } from './views/supplier.js';
import { adminOrdersView } from './views/admin-orders.js';
import { productsView, inventoryView } from './views/admin-catalog.js';
import { usersView, statsView, auditView } from './views/admin-users.js';
import { warehouseOrdersView } from './views/warehouse.js';
import { cartLines } from './cart.js';

const app = document.getElementById('app');
let current = null; let navSeq = 0; let channel = null; let wasDown = false; let started = null; let hiddenAt = 0;
const pendingKinds = new Set();

// ---------- Rutas por rol ----------
const NAV = {
  proveedor: [
    { path: 'catalogo', label: 'Catálogo', icon: 'grid', render: catalogView },
    { path: 'carrito', label: 'Carrito', icon: 'cart', render: cartView, badge: () => cartLines(state.cart) },
    { path: 'pedidos', label: 'Mis pedidos', icon: 'list', render: supplierOrdersView },
    { path: 'cuenta', label: 'Cuenta', icon: 'user', render: accountView },
  ],
  deposito: [
    { path: 'pedidos', label: 'Pedidos', icon: 'clip', render: warehouseOrdersView },
    { path: 'cuenta', label: 'Cuenta', icon: 'user', render: accountView },
  ],
  admin: [
    { path: 'pedidos', label: 'Pedidos', icon: 'list', render: adminOrdersView, perm: 'orders' },
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
      <button class="iconbtn" id="bell" aria-label="Avisos">${icon('bell')}<span class="badge-dot hidden" id="bellN"></span></button>
    </header><div id="banner"></div>
    <main id="view" tabindex="-1"></main><nav class="bottomnav" id="nav" aria-label="Principal"></nav>`;
  $('#bell').addEventListener('click', () => { location.hash = '#/avisos'; });
  renderNav();
  setConn(navigator.onLine ? (wasDown ? 'warn' : 'online') : 'off');
  updateBell();
}
function renderNav() {
  const nav = $('#nav'); if (!nav) return;
  const cur = location.hash.replace(/^#\/?/, '').split('/')[0];
  nav.innerHTML = navFor().map((n) => {
    const b = n.badge?.();
    return `<a href="#/${n.path}" class="${n.path === cur ? 'active' : ''}" ${n.path === cur ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${esc(n.label)}</span>${b ? `<i class="nav-count">${b}</i>` : ''}</a>`;
  }).join('');
}
function updateBell() {
  const n = $('#bellN'); if (!n) return;
  n.textContent = state.unread > 99 ? '99+' : String(state.unread);
  n.classList.toggle('hidden', state.unread <= 0);
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
  $('#title').textContent = def.label;
  renderNav();
  const v = $('#view');
  v.innerHTML = spinner();
  const ctx = {
    profile: state.profile, args, can, navigate: (h) => { location.hash = h; },
    setTitle: (t) => { $('#title').textContent = t; },
    seq: () => seq === navSeq,
  };
  try {
    const inst = await def.render(v, ctx);
    if (seq !== navSeq) { inst?.dispose?.(); return; }
    current = inst || null;
    window.scrollTo(0, 0);
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
  if (!location.hash || location.hash === '#') location.replace('#/' + navFor()[0].path);
  route();
}
async function logout() {
  stopRealtime(); started = null; current?.dispose?.(); current = null;
  try { await supabase.auth.signOut(); } catch { /* sesión local se limpia igual */ }
  state.user = null; state.profile = null; state.unread = 0; clearProfileCache();
  location.hash = '';
  renderLogin(app);
}

// ---------- Service worker y actualizaciones ----------
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.goto && state.profile) location.hash = e.data.goto; });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = () => {
      if ($('#upd')) return;
      const d = document.createElement('div'); d.id = 'upd'; d.className = 'toasts';
      d.innerHTML = `<div class="toast row between" style="pointer-events:auto"><span>Hay una versión nueva.</span><button class="btn accent sm">Actualizar</button></div>`;
      d.querySelector('button').addEventListener('click', () => reg.waiting?.postMessage('SKIP_WAITING'));
      document.body.append(d);
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
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
