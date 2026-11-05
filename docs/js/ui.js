import { esc } from './format.js';

const P = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  box: '<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clip: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
};
export const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] ?? ''}</svg>`;
export const logoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P.box + '</svg>';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Toasts ----------
export function toast(msg, kind = '', ms = 4200) {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? Math.max(ms, 6500) : ms);
}
export const ok = (m) => toast(m, 'ok');
export const fail = (m) => toast(m, 'bad');

// ---------- Botón ocupado: evita doble toque / envíos duplicados ----------
export async function busy(btn, fn) {
  if (!btn || btn.dataset.busy === '1') return undefined;
  btn.dataset.busy = '1';
  btn.classList.add('busy');
  try { return await fn(); }
  finally { btn.dataset.busy = ''; btn.classList.remove('busy'); }
}

// ---------- Modal (hoja inferior) ----------
export function modal(html, { onMount } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    const prevFocus = document.activeElement;
    const close = (val) => { ov.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.append(ov);
    ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    const first = ov.querySelector('input,select,textarea,button');
    first?.focus?.({ preventScroll: true });
    onMount?.(ov, close);
  });
}

export function confirmBox(title, message, { okText = 'Confirmar', danger = false } = {}) {
  return modal(`
    <h2>${esc(title)}</h2><p class="muted">${esc(message)}</p>
    <div class="row" style="margin-top:16px"><button class="btn grow" data-close>Volver</button>
    <button class="btn ${danger ? 'danger' : 'primary'} grow" data-ok>${esc(okText)}</button></div>`,
  { onMount: (ov, close) => ov.querySelector('[data-ok]').addEventListener('click', () => close(true)) }).then((v) => v === true);
}

export function askText(title, label, { required = true, okText = 'Aceptar', placeholder = '' } = {}) {
  return modal(`
    <h2>${esc(title)}</h2>
    <label class="field"><span>${esc(label)}</span><textarea data-t placeholder="${esc(placeholder)}" maxlength="500"></textarea></label>
    <p class="notice bad hidden" data-err style="margin-top:10px"></p>
    <div class="row" style="margin-top:16px"><button class="btn grow" data-close>Volver</button>
    <button class="btn primary grow" data-ok>${esc(okText)}</button></div>`,
  { onMount: (ov, close) => {
    ov.querySelector('[data-ok]').addEventListener('click', () => {
      const v = ov.querySelector('[data-t]').value.trim();
      if (required && !v) { const e = ov.querySelector('[data-err]'); e.textContent = 'Este dato es obligatorio.'; e.classList.remove('hidden'); return; }
      close(v);
    });
  } });
}

// ---------- Fragmentos ----------
export const spinner = (t = 'Cargando…') => `<div class="empty">${esc(t)}</div>`;
export const emptyBox = (t) => `<div class="empty">${esc(t)}</div>`;
export const errorBox = (msg, retry = true) =>
  `<div class="card stack"><p class="notice bad">${esc(msg)}</p>${retry ? '<button class="btn block" data-retry>Reintentar</button>' : ''}</div>`;

// Imagen con carga diferida y marcador
export const img = (url, alt = '') => url
  ? `<img loading="lazy" decoding="async" alt="${esc(alt)}" src="${esc(url)}" onload="this.classList.add('ok')" onerror="this.remove()">`
  : '';
export const photoBox = (url, alt) => `<div class="pimg">${icon('image')}${img(url, alt)}</div>`;

// Cambio de pantalla seguro: ignora respuestas viejas si ya se navegó a otra
export function viewToken() { const t = { alive: true }; return t; }

// Compresión de imagen en el teléfono antes de subirla (máx. 900 px, JPEG)
export async function compressImage(file, maxSide = 900, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('No se pudo procesar la imagen');
  return blob;
}
