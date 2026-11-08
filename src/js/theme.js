// Apariencia: modo (claro / oscuro / automático por horario) + paleta de colores.
// <html data-mode="light|dark" data-pref="light|dark|auto" data-palette="oceano|esmeralda|rubi">
// «Automático»: claro de 6:00 a 18:00 y oscuro el resto del día (se revisa cada minuto).
const KEY = 'deposito-theme'; const PKEY = 'deposito-palette';
export const AUTO_LIGHT_FROM = 6; export const AUTO_LIGHT_TO = 18;

export const PALETTES = [
  { id: 'oceano', name: 'Océano', note: 'Azul petróleo y dorado', sw: ['#17475a', '#f0a900'], meta: ['#0f2f3b', '#0a1a21'] },
  { id: 'esmeralda', name: 'Esmeralda', note: 'Verde y naranja', sw: ['#14543f', '#ff8a3d'], meta: ['#0d3b2e', '#08201a'] },
  { id: 'rubi', name: 'Rubí', note: 'Bordó y ámbar', sw: ['#7a1735', '#f5a623'], meta: ['#3a0f1e', '#1d0a11'] },
];
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const modeForHour = (h) => (h >= AUTO_LIGHT_FROM && h < AUTO_LIGHT_TO ? 'light' : 'dark');
export const nextPref = (p) => (p === 'light' ? 'dark' : p === 'dark' ? 'auto' : 'light');   // claro → oscuro → automático
export const PREF_LABEL = { light: 'Tema claro', dark: 'Tema oscuro', auto: `Automático (claro de ${AUTO_LIGHT_FROM} a ${AUTO_LIGHT_TO} h, oscuro de noche)` };

export function themePref() { const v = safeGet(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; }
export function paletteId() { const v = safeGet(PKEY); return PALETTES.some((p) => p.id === v) ? v : 'oceano'; }
export const resolvedMode = (now = new Date()) => { const p = themePref(); return p === 'auto' ? modeForHour(now.getHours()) : p; };

export function applyTheme(animate = false) {
  const root = document.documentElement; const mode = resolvedMode(); const pal = PALETTES.find((p) => p.id === paletteId());
  if (animate) {
    root.classList.add('theme-anim'); clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.mode = mode; root.dataset.pref = themePref(); root.dataset.palette = pal.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', pal.meta[mode === 'dark' ? 1 : 0]);
}
export function setTheme(pref) {
  safeSet(KEY, pref === 'auto' ? null : pref);
  applyTheme(true);
  document.dispatchEvent(new CustomEvent('themechange'));
}
export function setPalette(id) {
  safeSet(PKEY, PALETTES.some((p) => p.id === id) && id !== 'oceano' ? id : null);
  applyTheme(true);
  document.dispatchEvent(new CustomEvent('themechange'));
}

export function initTheme(notify) {
  applyTheme();
  const tick = () => { if (themePref() === 'auto' && document.documentElement.dataset.mode !== resolvedMode()) applyTheme(true); };
  setInterval(tick, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = nextPref(themePref()); setTheme(next); notify?.(PREF_LABEL[next]);
  });
}
