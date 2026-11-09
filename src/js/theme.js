// Apariencia: Claro, Oscuro o Automático (claro de 6:00 a 18:00 y oscuro el resto; se revisa cada minuto).
// <html data-mode="light|dark" data-pref="light|dark|auto">. Sin preferencia guardada se usa Automático.
const KEY = 'deposito-theme';
export const AUTO_LIGHT_FROM = 6; export const AUTO_LIGHT_TO = 18;
export const META = { light: '#3a3f48', dark: '#0b0c0e' };
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const modeForHour = (h) => (h >= AUTO_LIGHT_FROM && h < AUTO_LIGHT_TO ? 'light' : 'dark');
export const nextPref = (p) => (p === 'light' ? 'dark' : p === 'dark' ? 'auto' : 'light');   // claro → oscuro → automático
export const PREF_LABEL = { light: 'Tema claro', dark: 'Tema oscuro', auto: `Automático (claro de ${AUTO_LIGHT_FROM} a ${AUTO_LIGHT_TO} h, oscuro de noche)` };

export function themePref() { const v = safeGet(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; }
export const resolvedMode = (now = new Date()) => { const p = themePref(); return p === 'auto' ? modeForHour(now.getHours()) : p; };

export function applyTheme(animate = false) {
  const root = document.documentElement; const mode = resolvedMode();
  if (animate) {
    root.classList.add('theme-anim'); clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.mode = mode; root.dataset.pref = themePref();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[mode]);
}
export function setTheme(pref) {
  safeSet(KEY, pref === 'light' || pref === 'dark' ? pref : null);
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
