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
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M11 8v8M15 8v8M18 8v8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  repeat: '<path d="m17 1 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  alert: '<path d="m10.3 3.9-8.2 14.2A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  fingerprint: '<path d="M2 12a10 10 0 0 1 18-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M8.65 22c.21-.66.45-1.32.57-2M22 12.4a10 10 0 0 1-.5 5M18 12a6 6 0 0 0-9.6-4.8"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>',
  send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
};
export const icon = (n, extra = '') => `<svg class="i${extra ? ' ' + extra : ''}" viewBox="0 0 24 24" aria-hidden="true">${P[n] ?? ''}</svg>`;
export const logoSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P.box + '</svg>';

export const themeButton = (cls = 'iconbtn') => `<button type="button" class="${cls}" data-theme-toggle aria-label="Cambiar entre tema claro y oscuro" title="Tema claro / oscuro">${icon('sun', 'ico-sun')}${icon('moon', 'ico-moon')}</button>`;
export const soundButton = (id = 'snd') => `<button type="button" class="iconbtn" id="${id}" data-sound-toggle aria-label="Activar o silenciar sonidos de aviso" title="Sonido de avisos">${icon('volume', 'on')}${icon('mute', 'off')}</button>`;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Toasts ----------
function toastBox() {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  return box;
}
function dismiss(t) { if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => t.remove(), 260); }
export function toast(msg, kind = '', ms = 6000) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toastBox().append(t);
  setTimeout(() => dismiss(t), kind === 'bad' ? Math.max(ms, 9000) : ms);
}
// Aviso con botón de acción (por ejemplo "Activar sonido")
export function toastAction(msg, label, onClick, ms = 12000) {
  const t = document.createElement('div');
  t.className = 'toast row between';
  t.innerHTML = `<span class="grow"></span><button class="btn accent sm" type="button"></button>`;
  t.firstChild.textContent = msg; t.lastChild.textContent = label;
  t.lastChild.addEventListener('click', () => { dismiss(t); onClick?.(); });
  toastBox().append(t);
  setTimeout(() => dismiss(t), ms);
  return t;
}
// Aviso grande y centrado para notificaciones importantes (pedidos nuevos, cambios de estado, etc.)
function noteBox() {
  let box = $('.notes');
  if (!box) { box = document.createElement('div'); box.className = 'notes'; box.setAttribute('role', 'alert'); box.setAttribute('aria-live', 'assertive'); document.body.append(box); }
  return box;
}
const NOTE_ICON = { order: 'clip', alert: 'alert', ready: 'check', soft: 'bell' };
export function notify(title, body = '', { kind = 'soft', ms = 14000, onClick } = {}) {
  const box = noteBox();
  while (box.children.length >= 3) box.firstChild.remove();           // como máximo 3 a la vez
  const n = document.createElement('div');
  n.className = `note k-${NOTE_ICON[kind] ? kind : 'soft'}`;
  n.style.setProperty('--ms', `${ms}ms`);
  n.innerHTML = `<span class="note-ico">${icon(NOTE_ICON[kind] || 'bell')}</span>
    <div class="note-body"><b class="note-title"></b><p class="note-text"></p></div>
    <button type="button" class="note-x" aria-label="Cerrar aviso">${icon('x')}</button><i class="note-bar"></i>`;
  $('.note-title', n).textContent = title;
  const text = $('.note-text', n); if (body) text.textContent = body; else text.remove();
  let timer = setTimeout(() => dismiss(n), ms);
  const pause = () => { clearTimeout(timer); n.classList.add('hold'); };
  const resume = () => { n.classList.remove('hold'); timer = setTimeout(() => dismiss(n), 4000); };
  n.addEventListener('mouseenter', pause); n.addEventListener('mouseleave', resume);
  $('.note-x', n).addEventListener('click', (e) => { e.stopPropagation(); clearTimeout(timer); dismiss(n); });
  n.addEventListener('click', () => { clearTimeout(timer); dismiss(n); onClick?.(); });
  box.append(n);
  return n;
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
    let closed = false;
    const close = (val) => { if (closed) return; closed = true; ov.classList.add('closing'); setTimeout(() => ov.remove(), 200); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape' && [...document.querySelectorAll('.overlay:not(.closing)')].pop() === ov) close(null); };
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
export const spinner = (t = 'Cargando…') => `<div class="skeleton-list" aria-busy="true"><span class="sr">${esc(t)}</span><div></div><div></div><div></div></div>`;
export const emptyBox = (t) => `<div class="empty">${esc(t)}</div>`;
export const errorBox = (msg, retry = true) =>
  `<div class="card stack"><p class="notice bad">${esc(msg)}</p>${retry ? '<button class="btn block" data-retry>Reintentar</button>' : ''}</div>`;

// Imagen con carga diferida y marcador
export const img = (url, alt = '') => url
  ? `<img data-pimg loading="lazy" decoding="async" alt="${esc(alt)}" src="${esc(url)}">`
  : '';
// Sin manejadores inline (compatible con la política de seguridad del navegador): load/error no burbujean, se escuchan en captura
document.addEventListener('load', (e) => { const t = e.target; if (t instanceof HTMLImageElement && t.hasAttribute('data-pimg')) t.classList.add('ok'); }, true);
document.addEventListener('error', (e) => { const t = e.target; if (t instanceof HTMLImageElement && t.hasAttribute('data-pimg')) t.remove(); }, true);
export const photoBox = (url, alt) => `<div class="pimg">${icon('image')}${img(url, alt)}</div>`;

// Cambio de pantalla seguro: ignora respuestas viejas si ya se navegó a otra
export function viewToken() { const t = { alive: true }; return t; }

// Compresión de imagen en el teléfono antes de subirla (máx. 900 px, JPEG)
export async function compressImage(file, maxSide = 900, quality = 0.82) {
  // Se decodifica con <img> (todos los navegadores aplican la orientación EXIF: fotos del celular derechas)
  // y, si no se puede, con createImageBitmap pidiendo la orientación del archivo.
  let src; let sw; let sh; let url;
  try {
    url = URL.createObjectURL(file);
    const im = new Image(); im.decoding = 'async'; im.src = url; await im.decode();
    src = im; sw = im.naturalWidth; sh = im.naturalHeight;
  } catch {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    src = bmp; sw = bmp.width; sh = bmp.height;
  } finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 5000); }
  if (!sw || !sh) throw new Error('No se pudo leer la imagen');
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);          // los PNG con fondo transparente no quedan negros al pasar a JPEG
  g.drawImage(src, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('No se pudo procesar la imagen');
  return blob;
}

// Efecto "onda" al tocar botones y chips
export function initEffects() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.btn, .chip, .seg button');
    if (!b || b.disabled || e.button > 0) return;
    const r = b.getBoundingClientRect(); const size = Math.max(r.width, r.height);
    const s = document.createElement('span'); s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.append(s); setTimeout(() => s.remove(), 650);
  }, { passive: true });
}
