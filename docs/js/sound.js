// Sonidos de aviso generados con Web Audio (sin archivos de audio). Se activan/desactivan desde la barra superior o la cuenta.
const KEY = 'deposito-sound';
let ctx = null;
let enabled = false;
try { enabled = localStorage.getItem(KEY) === '1'; } catch { /* nada */ }

export const soundEnabled = () => enabled;
export const soundChoiceMade = () => { try { return localStorage.getItem(KEY) !== null; } catch { return true; } };

function ensure() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// Los navegadores solo permiten audio tras un toque del usuario: se "despierta" el audio en cada toque mientras esté activado.
document.addEventListener('pointerdown', () => { if (enabled) ensure(); }, { passive: true });
document.addEventListener('keydown', () => { if (enabled) ensure(); }, { passive: true });

// [frecuencia Hz, inicio s, duración s]
const MELODIES = {
  order: [[784, 0, 0.16], [1047, 0.17, 0.16], [1319, 0.34, 0.38]],
  ready: [[659, 0, 0.14], [880, 0.15, 0.14], [1175, 0.30, 0.34]],
  alert: [[523, 0, 0.18], [392, 0.2, 0.34]],
  soft: [[880, 0, 0.22]],
};
function play(kind) {
  const c = ensure(); if (!c) return false;
  const notes = MELODIES[kind] || MELODIES.order; const t0 = c.currentTime + 0.02;
  for (const [f, s, d] of notes) {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + s);
    g.gain.exponentialRampToValueAtTime(0.28, t0 + s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + d);
    o.connect(g).connect(c.destination); o.start(t0 + s); o.stop(t0 + s + d + 0.05);
  }
  return c.state === 'running' || c.state === 'suspended';
}
export function playSound(kind = 'order') {
  if (!enabled) return false;
  try { navigator.vibrate?.(kind === 'alert' ? [200, 80, 200] : [90, 50, 90]); } catch { /* sin vibración */ }
  return play(kind);
}
export const previewSound = (kind = 'order') => play(kind);
export function setSound(on) {
  enabled = !!on;
  try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { /* nada */ }
  if (enabled) play('order');
  document.dispatchEvent(new CustomEvent('soundchange'));
}
export function kindFor(title = '') {
  const t = String(title).toLowerCase();
  if (t.includes('nuevo pedido')) return 'order';
  if (t.includes('faltante') || t.includes('cancel') || t.includes('rechaz')) return 'alert';
  if (t.includes('listo') || t.includes('para preparar') || t.includes('aprobado') || t.includes('entregado') || t.includes('modificado')) return 'ready';
  return 'soft';
}
