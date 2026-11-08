import test from 'node:test';
import assert from 'node:assert/strict';
import { modeForHour, nextPref, PALETTES, PREF_LABEL } from '../src/js/theme.js';

test('automático: claro de 6 a 18 h y oscuro el resto', () => {
  const claro = [6, 7, 12, 17]; const oscuro = [0, 3, 5, 18, 19, 23];
  for (const h of claro) assert.equal(modeForHour(h), 'light', `hora ${h}`);
  for (const h of oscuro) assert.equal(modeForHour(h), 'dark', `hora ${h}`);
  assert.equal(modeForHour(5.99 | 0), 'dark'); assert.equal(modeForHour(17.99 | 0), 'light');
});
test('el botón rota claro → oscuro → automático → claro', () => {
  assert.equal(nextPref('light'), 'dark'); assert.equal(nextPref('dark'), 'auto'); assert.equal(nextPref('auto'), 'light');
});
test('hay 3 paletas con colores válidos y textos', () => {
  assert.equal(PALETTES.length, 3);
  for (const p of PALETTES) { assert.match(p.id, /^[a-z]+$/); assert.equal(p.sw.length, 2); assert.equal(p.meta.length, 2); assert.ok(p.sw.every((c) => /^#[0-9a-f]{6}$/i.test(c))); }
  assert.ok(PREF_LABEL.auto.includes('6') && PREF_LABEL.auto.includes('18'));
});
