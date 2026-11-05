import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCart, setQty, getQty, removeItem, cartTotal, cartCount, toPayload, loadCart, saveCart, resetCart, newRequestId } from '../src/js/cart.js';
import { cleanSearch, esc, toInt, clamp, statusLabel, one } from '../src/js/format.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
const P1 = { id: 'a', code: 'A1', name: 'Uno', price: 10.5, available: 9 };
const P2 = { id: 'b', code: 'B1', name: 'Dos', price: 3, available: 4 };

test('agregar, cambiar y quitar productos', () => {
  const c = emptyCart();
  setQty(c, P1, 2); setQty(c, P2, 3);
  assert.equal(getQty(c, 'a'), 2);
  assert.equal(cartCount(c), 5);
  assert.equal(cartTotal(c), 30);
  setQty(c, P1, 0);
  assert.equal(getQty(c, 'a'), 0);
  removeItem(c, 'b');
  assert.deepEqual(toPayload(c), []);
});
test('cantidades inválidas se normalizan (nunca negativas)', () => {
  const c = emptyCart();
  setQty(c, P1, -5); assert.equal(getQty(c, 'a'), 0);
  setQty(c, P1, 'abc'); assert.equal(getQty(c, 'a'), 0);
  setQty(c, P1, 7.9); assert.equal(getQty(c, 'a'), 7);
});
test('el payload solo envía id y cantidad (el servidor calcula precios)', () => {
  const c = emptyCart(); setQty(c, P1, 2);
  assert.deepEqual(toPayload(c), [{ product_id: 'a', qty: 2 }]);
});
test('el carrito persiste y se recupera; el identificador de solicitud se conserva', () => {
  const st = mem(); const c = emptyCart(); setQty(c, P1, 4); c.notes = 'nota';
  saveCart(st, 'k', c);
  const r = loadCart(st, 'k');
  assert.equal(getQty(r, 'a'), 4); assert.equal(r.notes, 'nota'); assert.equal(r.requestId, c.requestId);
});
test('un reintento reutiliza el mismo requestId; tras confirmar se genera uno nuevo', () => {
  const c = emptyCart(); const id = c.requestId;
  assert.equal(c.requestId, id);
  const n = resetCart();
  assert.notEqual(n.requestId, id);
  assert.match(newRequestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('datos corruptos en el almacenamiento no rompen la app', () => {
  const st = mem(); st.setItem('k', '{no es json'); assert.equal(cartCount(loadCart(st, 'k')), 0);
  st.setItem('k', JSON.stringify({ items: { x: { qty: 0 } }, requestId: 'r' })); assert.equal(cartCount(loadCart(st, 'k')), 0);
});
test('utilidades de formato y seguridad', () => {
  assert.equal(esc('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.equal(cleanSearch('a,b)(%*"'), 'a b');
  assert.equal(toInt('12px'), 12); assert.equal(toInt('x', 5), 5);
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(statusLabel('ENTREGADO'), 'Entregado');
  assert.equal(one([1, 2]), 1); assert.equal(one(null), null);
});
