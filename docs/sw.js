/* Service worker: shell de la app en caché; los datos de Supabase NUNCA se cachean. */
const VERSION = 'cf55677670';
const SHELL = 'shell-' + VERSION;
const RUNTIME = 'runtime-v1';
const ASSETS = [
 "./",
 "./index.html",
 "./manifest.webmanifest",
 "./css/app.css?v=cf55677670",
 "./icons/icon-192.png",
 "./icons/icon-512.png",
 "./icons/icon-maskable-512.png",
 "./js/api.js",
 "./js/cart.js",
 "./js/charts.js",
 "./js/export-utils.js",
 "./js/format.js",
 "./js/main.js?v=cf55677670",
 "./js/sound.js",
 "./js/state.js",
 "./js/stats-utils.js",
 "./js/supa.js",
 "./js/theme.js",
 "./js/tools.js",
 "./js/ui.js",
 "./js/views/account.js",
 "./js/views/admin-catalog.js",
 "./js/views/admin-orders.js",
 "./js/views/admin-users.js",
 "./js/views/auth.js",
 "./js/views/backups.js",
 "./js/views/customers.js",
 "./js/views/order-common.js",
 "./js/views/product-picker.js",
 "./js/views/stats.js",
 "./js/views/supplier.js",
 "./js/views/warehouse.js"
];

self.addEventListener('install', (e) => {
  // cache:'reload' evita copiar archivos viejos desde la caché HTTP del navegador al instalar una versión nueva
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(ASSETS.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => { if (!r.ok) throw new Error(u); return c.put(u, r); })))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return;
  // API, auth y realtime de Supabase: siempre red (sin caché) para no mostrar datos viejos como actuales
  if (url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/v1/object/public/')) return;
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/config.js')) { // configuración: red primero, caché solo sin conexión
      e.respondWith(fetch(req, { cache: 'no-cache' }).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(SHELL).then((c) => c.put(req, cp)); } return r; }).catch(() => caches.match(req)));
      return;
    }
    if (req.mode === 'navigate') {
      e.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => caches.match('./index.html', { ignoreSearch: true })));
      return;
    }
    // Red primero (con tiempo límite) y caché solo si no hay red: así nunca se mezclan módulos JS de versiones distintas
    // (un main.js nuevo con un supa.js viejo dejaba la app colgada en "cargando").
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(req, { signal: ctrl.signal }); clearTimeout(t);
        if (r.ok) cache.put(req, r.clone());
        return r;
      } catch {
        return (await cache.match(req)) || (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }
  // Librería de Supabase (CDN) y fotos públicas: caché con actualización en segundo plano
  if (['cdn.jsdelivr.net', 'esm.sh', 'unpkg.com'].includes(url.hostname) || url.pathname.startsWith('/storage/v1/object/public/')) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const order = e.notification.data?.order;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = all[0];
    if (target) { await target.focus(); if (order) target.postMessage({ goto: '#/pedidos/' + order }); }
    else await self.clients.openWindow('./' + (order ? '#/pedidos/' + order : ''));
  })());
});
