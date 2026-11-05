/* Service worker: shell de la app en caché; los datos de Supabase NUNCA se cachean. */
const VERSION = '__VERSION__';
const SHELL = 'shell-' + VERSION;
const RUNTIME = 'runtime-v1';
const ASSETS = __ASSETS__;

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
    e.respondWith(caches.match(req, { ignoreSearch: false }).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(SHELL).then((c) => c.put(req, cp)); }
      return r;
    })));
    return;
  }
  // Librería de Supabase (CDN) y fotos públicas: caché con actualización en segundo plano
  if (url.hostname === 'cdn.jsdelivr.net' || url.pathname.startsWith('/storage/v1/object/public/')) {
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
