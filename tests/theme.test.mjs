import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPref, PREF_LABEL, META } from '../src/js/theme.js';

test('el botón alterna entre claro y oscuro (ya no hay automático)', () => {
  assert.equal(nextPref('light'), 'dark'); assert.equal(nextPref('dark'), 'light');
  assert.equal(nextPref('auto'), 'dark', 'una preferencia vieja «automático» pasa al oscuro');
});
test('solo existen dos modos con textos y colores de barra válidos', () => {
  assert.deepEqual(Object.keys(PREF_LABEL).sort(), ['dark', 'light']);
  for (const c of Object.values(META)) assert.match(c, /^#[0-9a-f]{6}$/i);
});
