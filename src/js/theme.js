// Tema claro / oscuro / automático. El modo resuelto queda en <html data-mode="light|dark">.
const KEY = 'deposito-theme';
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function themePref() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; }
}
export const resolvedMode = () => { const p = themePref(); return p === 'auto' ? (mq?.matches ? 'dark' : 'light') : p; };

export function applyTheme(animate = false) {
  const root = document.documentElement; const mode = resolvedMode();
  if (animate) {
    root.classList.add('theme-anim'); clearTimeout(applyTheme.t);
    applyTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.mode = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mode === 'dark' ? '#0a1a21' : '#0f2f3b');
}
export function setTheme(pref) {
  try { if (pref === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* sin almacenamiento */ }
  applyTheme(true);
  document.dispatchEvent(new CustomEvent('themechange'));
}
export const toggleTheme = () => setTheme(resolvedMode() === 'dark' ? 'light' : 'dark');

export function initTheme() {
  applyTheme();
  mq?.addEventListener?.('change', () => { if (themePref() === 'auto') applyTheme(true); });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-theme-toggle]')) toggleTheme(); });
}
