// Apariencia: solo dos modos, claro y oscuro (estilo vidrio, plata y dorado).
// <html data-mode="light|dark" data-pref="light|dark">. Sin preferencia guardada se usa el oscuro.
const KEY = 'deposito-theme';
export const META = { light: '#3a3f48', dark: '#0b0c0e' };
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const nextPref = (p) => (p === 'dark' ? 'light' : 'dark');   // alterna claro ↔ oscuro
export const PREF_LABEL = { light: 'Tema claro', dark: 'Tema oscuro' };

export function themePref() { return safeGet(KEY) === 'light' ? 'light' : 'dark'; }
export const resolvedMode = () => themePref();

export function applyTheme(animate = false) {
  const root = document.documentElement; const mode = resolvedMode();
  if (animate) {
    root.classList.add('theme-anim'); clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.mode = mode; root.dataset.pref = mode;
  delete root.dataset.palette;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[mode]);
}
export function setTheme(pref) {
  safeSet(KEY, pref === 'light' ? 'light' : 'dark');
  applyTheme(true);
  document.dispatchEvent(new CustomEvent('themechange'));
}

export function initTheme(notify) {
  applyTheme();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = nextPref(themePref()); setTheme(next); notify?.(PREF_LABEL[next]);
  });
}
