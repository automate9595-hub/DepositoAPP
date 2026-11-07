import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRow, decodeGray, ean13Check, ean8Check, encodeEan13Modules, encodeEan8Modules } from '../src/js/barcode-decode.js';

// Dibuja módulos como píxeles con zona de silencio, escala y desenfoque
function render(bits, { scale = 3, quiet = 12, blur = 0, noise = 0, slope = 0, seed = 7 } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const px = [];
  for (let i = 0; i < quiet * scale; i++) px.push(255);
  for (const b of bits) for (let k = 0; k < scale; k++) px.push(b === '1' ? 20 : 235);
  for (let i = 0; i < quiet * scale; i++) px.push(255);
  let out = px.map((v, i) => v - slope * (i / px.length) + (rnd() - 0.5) * noise);
  for (let r = 0; r < blur; r++) out = out.map((v, i) => (out[Math.max(0, i - 1)] + v * 2 + out[Math.min(out.length - 1, i + 1)]) / 4);
  return Uint8Array.from(out.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
}
const make13 = (body12) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(body12[i]) * (i % 2 ? 3 : 1); return body12 + ((10 - (s % 10)) % 10); };

test('dígitos de control', () => {
  assert.equal(ean13Check('7790895000010'), true);
  assert.equal(ean13Check('7790895000011'), false);
  assert.equal(ean8Check('96385074'), true);
  assert.equal(ean8Check('96385075'), false);
});

test('decodifica EAN-13 limpio a distintas escalas', () => {
  for (const code of ['7790895000010', '4006381333931', '5901234123457', '9780201379624', make13('779000123456')]) {
    for (const scale of [2, 3, 5]) assert.equal(decodeRow(render(encodeEan13Modules(code), { scale })), code, `${code} x${scale}`);
  }
});

test('decodifica con desenfoque, ruido y degradé de luz', () => {
  const code = make13('790123456789');
  assert.equal(decodeRow(render(encodeEan13Modules(code), { scale: 3, blur: 1, noise: 30, slope: 80 })), code);
});

test('decodifica un código dado vuelta', () => {
  const code = make13('780000111222');
  assert.equal(decodeRow(render(encodeEan13Modules(code), { scale: 3 }).reverse()), code);
});

test('UPC-A (EAN-13 que empieza en 0) se devuelve con 12 dígitos', () => {
  const code13 = make13('001234567890');
  assert.equal(decodeRow(render(encodeEan13Modules(code13), { scale: 3 })), code13.slice(1));
});

test('decodifica EAN-8', () => {
  assert.equal(decodeRow(render(encodeEan8Modules('96385074'), { scale: 3 })), '96385074');
});

test('no inventa códigos: ruido y líneas vacías devuelven null', () => {
  assert.equal(decodeRow(new Uint8Array(400).fill(200)), null);
  let s = 3; const noise = Uint8Array.from({ length: 600 }, () => { s = (s * 1103515245 + 12345) % 2147483648; return s % 256; });
  assert.equal(decodeRow(noise), null);
});

test('un dígito alterado se rechaza por el control', () => {
  const bits = encodeEan13Modules('7790895000010');
  const tampered = encodeEan13Modules('7790895000020');   // control inválido a propósito
  assert.equal(decodeRow(render(bits)), '7790895000010');
  assert.equal(decodeRow(render(tampered)), null);
});

test('decodeGray encuentra el código en una imagen con filas y también girado', () => {
  const code = make13('770123456789'); const line = render(encodeEan13Modules(code), { scale: 3 });
  const w = line.length; const h = 60;
  const img = new Uint8Array(w * h).fill(255);
  for (let y = 12; y < 48; y++) img.set(line, y * w);
  assert.equal(decodeGray(img, w, h), code);
  // vertical: transponer
  const vert = new Uint8Array(h * w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) vert[x * h + y] = img[y * w + x];
  assert.equal(decodeGray(vert, h, w), code);
});
