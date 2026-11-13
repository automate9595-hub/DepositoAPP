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


// ---------- Sonido de bienvenida del login (sintetizado, sin archivos) ----------
// Suena si el usuario no silenció los sonidos a propósito (ajuste «Sonido de avisos» en apagado).
const loginSoundOn = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };

function tone(c, dest, f, t, d, { type = 'sine', gain = 0.2, attack = 0.012 } = {}) {
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(dest); o.start(t); o.stop(t + d + 0.05);
}
// Campana: la nota más tres parciales que decaen más rápido (timbre metálico, elegante)
function bell(c, dest, f, t, d, gain) {
  [[1, 1], [2.01, 0.42], [3.02, 0.2], [4.19, 0.09]].forEach(([m, a], i) => tone(c, dest, f * m, t, d / (1 + i * 0.45), { gain: gain * a }));
}
function whoosh(c, dest, t, d, f0, f1, gain) {
  const len = Math.floor(c.sampleRate * d); const buf = c.createBuffer(1, len, c.sampleRate); const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + d);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + d * 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(bp).connect(g).connect(dest); src.start(t); src.stop(t + d);
}
const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];
const chord = (c, d, t) => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(c, d, f, t + i * 0.04, 2.4, 0.075)); tone(c, d, 130.81, t, 2.6, { gain: 0.09, attack: 0.08 }); };

// Programa los sonidos de la intro (≈5 s) en un contexto de audio. Los tiempos coinciden con la animación del login.
export function scheduleIntro(c, dest, t0, { full = true } = {}) {
  if (!full) { chord(c, dest, t0); return; }
  const rise = c.createOscillator(); const rg = c.createGain();
  rise.type = 'sine'; rise.frequency.setValueAtTime(196, t0 + 0.15); rise.frequency.exponentialRampToValueAtTime(392, t0 + 1.8);
  rg.gain.setValueAtTime(0.0001, t0 + 0.15); rg.gain.exponentialRampToValueAtTime(0.06, t0 + 1.0); rg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.0);
  rise.connect(rg).connect(dest); rise.start(t0 + 0.15); rise.stop(t0 + 2.1);
  whoosh(c, dest, t0 + 0.2, 1.7, 400, 3200, 0.05);
  bell(c, dest, 783.99, t0 + 0.9, 1.2, 0.05);                                   // el logo se dibuja
  PENTA.forEach((f, i) => bell(c, dest, f, t0 + 1.9 + i * 0.07, 0.6, 0.055));    // las letras aparecen
  chord(c, dest, t0 + 2.9);                                                     // línea dorada + eslogan
  whoosh(c, dest, t0 + 3.0, 1.5, 1500, 6500, 0.045);                           // destello que cruza
}

let introMaster = null;
// Inicia el sonido de la intro. Devuelve { started, stop(), late() }:
//  · started=false si el navegador bloquea el audio hasta el primer toque (late() reproduce entonces solo el acorde final).
export function playIntro() {
  const handle = { started: false, stop() {}, late() {} };
  if (!loginSoundOn()) return handle;
  const c = ensure(); if (!c) return handle;
  const run = (full) => {
    const master = c.createGain(); master.gain.value = 0.9; master.connect(c.destination); introMaster = master;
    scheduleIntro(c, master, c.currentTime + 0.05, { full });
    handle.stop = () => { try { master.gain.cancelScheduledValues(c.currentTime); master.gain.setTargetAtTime(0, c.currentTime, 0.06); } catch { /* nada */ } };
  };
  if (c.state === 'running') { run(true); handle.started = true; }
  else handle.late = () => { c.resume().then(() => { if (c.state === 'running') run(false); }).catch(() => {}); };
  return handle;
}

// Campanita de «ingreso correcto» (se llama tras iniciar sesión: ahí el navegador siempre permite el audio)
export function playWelcome() {
  if (!loginSoundOn()) return;
  const c = ensure(); if (!c) return;
  const t = c.currentTime + 0.03;
  bell(c, c.destination, 659.25, t, 0.9, 0.08); bell(c, c.destination, 987.77, t + 0.14, 1.1, 0.08); bell(c, c.destination, 1318.51, t + 0.3, 1.6, 0.07);
}
