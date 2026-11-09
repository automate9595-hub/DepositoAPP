import test from 'node:test';
import assert from 'node:assert/strict';
import { modeForHour, nextPref, PREF_LABEL, META } from '../src/js/theme.js';

test('automático: claro de 6 a 18 h y oscuro el resto', () => {
  for (const h of [6, 7, 12, 17]) assert.equal(modeForHour(h), 'light', `hora ${h}`);
  for (const h of [0, 3, 5, 18, 19, 23]) assert.equal(modeForHour(h), 'dark', `hora ${h}`);
});
test('el botón rota claro → oscuro → automático → claro', () => {
  assert.equal(nextPref('light'), 'dark'); assert.equal(nextPref('dark'), 'auto'); assert.equal(nextPref('auto'), 'light');
});
test('textos y colores de barra válidos', () => {
  assert.deepEqual(Object.keys(PREF_LABEL).sort(), ['auto', 'dark', 'light']);
  assert.ok(PREF_LABEL.auto.includes('6') && PREF_LABEL.auto.includes('18'));
  for (const c of Object.values(META)) assert.match(c, /^#[0-9a-f]{6}$/i);
});
