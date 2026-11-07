// Decodificador de códigos de barras de productos (EAN-13, UPC-A y EAN-8) para navegadores
// que no traen BarcodeDetector (por ejemplo Safari en iPhone). Sin dependencias ni red.
// Trabaja sobre una imagen en escala de grises: se prueban varias líneas horizontales y verticales.

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((c) => [...c].map((b) => (b === '1' ? '0' : '1')).join(''));
const G_FIXED = R.map((c) => [...c].reverse().join(''));   // definición estándar: G es R leído al revés
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

const runsOf = (bits) => { const out = []; let n = 1; for (let i = 1; i <= bits.length; i++) { if (bits[i] === bits[i - 1]) n++; else { out.push(n); n = 1; } } return out; };
const widthsL = L.map(runsOf);        // los 4 anchos de cada dígito (L y R comparten anchos)
const widthsG = G_FIXED.map(runsOf);

export function ean13Check(d) {
  if (!/^\d{13}$/.test(d)) return false;
  let s = 0; for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 ? 3 : 1);
  return (10 - (s % 10)) % 10 === Number(d[12]);
}
export function ean8Check(d) {
  if (!/^\d{8}$/.test(d)) return false;
  let s = 0; for (let i = 0; i < 7; i++) s += Number(d[i]) * (i % 2 ? 1 : 3);
  return (10 - (s % 10)) % 10 === Number(d[7]);
}

// Compara 4 anchos con las plantillas; devuelve { digit, error } del mejor
function matchDigit(w4, tables) {
  const total = w4[0] + w4[1] + w4[2] + w4[3];
  const unit = total / 7;
  let best = { digit: -1, error: Infinity, set: '' };
  for (const [name, t] of tables) {
    for (let d = 0; d < 10; d++) {
      let e = 0; for (let k = 0; k < 4; k++) e += Math.abs(w4[k] / unit - t[d][k]);
      if (e < best.error) best = { digit: d, error: e, set: name };
    }
  }
  return best;
}

// Convierte los anchos de las barras/espacios en dígitos. runs[start] debe ser una barra oscura.
function decodeRuns(runs, start, count, kind) {
  const need = kind === 13 ? 59 : 43;
  if (start + need > runs.length) return null;
  const unit = (runs[start] + runs[start + 1] + runs[start + 2]) / 3;
  if (unit < 1) return null;
  for (let k = 0; k < 3; k++) if (Math.abs(runs[start + k] / unit - 1) > 0.65) return null;      // guarda inicial 1-1-1
  const half = kind === 13 ? 6 : 4;
  let i = start + 3; let digits = ''; let parity = '';
  for (let n = 0; n < half; n++, i += 4) {
    const w = runs.slice(i, i + 4);
    const m = matchDigit(w, kind === 13 ? [['L', widthsL], ['G', widthsG]] : [['L', widthsL]]);
    if (m.error > 1.6) return null;
    digits += m.digit; parity += m.set;
  }
  for (let k = 0; k < 5; k++) if (Math.abs(runs[i + k] / unit - 1) > 0.7) return null;          // guarda central 1-1-1-1-1
  i += 5;
  for (let n = 0; n < half; n++, i += 4) {
    const m = matchDigit(runs.slice(i, i + 4), [['R', widthsL]]);
    if (m.error > 1.6) return null;
    digits += m.digit;
  }
  for (let k = 0; k < 3; k++) if (Math.abs(runs[i + k] / unit - 1) > 0.7) return null;          // guarda final
  if (kind === 8) return ean8Check(digits) ? digits : null;
  const first = PARITY.indexOf(parity);
  if (first < 0) return null;
  const code = String(first) + digits;
  if (!ean13Check(code)) return null;
  return code[0] === '0' ? code.slice(1) : code;     // UPC-A (12 dígitos) cuando el primer dígito es 0
}

// Una línea de píxeles (0 = negro … 255 = blanco) → texto del código o null
export function decodeRow(line) {
  const n = line.length;
  if (n < 60) return null;
  // suavizado leve + umbral adaptativo (media local) para tolerar sombras y brillos
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = ((line[Math.max(0, i - 1)] + line[i] * 2 + line[Math.min(n - 1, i + 1)]) / 4);
  // umbral local = punto medio entre el mínimo y el máximo de los bloques vecinos (tolera sombras y desenfoque)
  const B = Math.max(12, Math.floor(n / 24)); const nb = Math.ceil(n / B);
  const bmin = new Float32Array(nb).fill(255); const bmax = new Float32Array(nb).fill(0);
  for (let i = 0; i < n; i++) { const k = (i / B) | 0; if (sm[i] < bmin[k]) bmin[k] = sm[i]; if (sm[i] > bmax[k]) bmax[k] = sm[i]; }
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = (i / B) | 0; let lo = 255; let hi = 0;
    for (let j = Math.max(0, k - 2); j <= Math.min(nb - 1, k + 2); j++) { if (bmin[j] < lo) lo = bmin[j]; if (bmax[j] > hi) hi = bmax[j]; }
    bits[i] = hi - lo > 30 && sm[i] < (lo + hi) / 2 ? 1 : 0;
  }
  const runs = []; const kinds = []; let cur = bits[0]; let len = 1;
  for (let i = 1; i < n; i++) { if (bits[i] === cur) len++; else { runs.push(len); kinds.push(cur); cur = bits[i]; len = 1; } }
  runs.push(len); kinds.push(cur);
  for (const rr of [runs, [...runs].reverse()]) {
    const kk = rr === runs ? kinds : [...kinds].reverse();
    for (let s = 0; s < rr.length; s++) {
      if (kk[s] !== 1) continue;
      const r13 = decodeRuns(rr, s, 13, 13); if (r13) return r13;
      const r8 = decodeRuns(rr, s, 8, 8); if (r8) return r8;
    }
  }
  return null;
}

// Imagen en grises (Uint8Array w*h) → texto del código o null. Prueba filas y columnas.
export function decodeGray(gray, w, h) {
  const tryLine = (get, len, count, span) => {
    const line = new Uint8Array(len);
    for (let k = 0; k < count; k++) {
      const pos = Math.round(span[0] + ((span[1] - span[0]) * (k + 0.5)) / count);
      for (let i = 0; i < len; i++) line[i] = get(pos, i);
      const r = decodeRow(line); if (r) return r;
    }
    return null;
  };
  const rows = tryLine((y, x) => gray[y * w + x], w, 21, [h * 0.2, h * 0.8]);
  if (rows) return rows;
  return tryLine((x, y) => gray[y * w + x], h, 21, [w * 0.2, w * 0.8]);
}

// Imagen RGBA del navegador (ImageData.data) → texto del código o null
export function decodeRgba(data, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  return decodeGray(gray, w, h);
}

// Utilidad para pruebas: dibuja un EAN-13 como línea de píxeles
export function encodeEan13Modules(code13) {
  const first = Number(code13[0]); const par = PARITY[first];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (par[i] === 'L' ? L : G_FIXED)[Number(code13[1 + i])];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[Number(code13[7 + i])];
  return bits + '101';
}
export function encodeEan8Modules(code8) {
  let bits = '101';
  for (let i = 0; i < 4; i++) bits += L[Number(code8[i])];
  bits += '01010';
  for (let i = 0; i < 4; i++) bits += R[Number(code8[4 + i])];
  return bits + '101';
}
