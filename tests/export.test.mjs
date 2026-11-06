import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, orderText, remitoHtml, finalQty, finalTotal, parseLow } from '../src/js/export-utils.js';

test('csvCell escapa separadores, comillas y saltos de línea', () => {
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('di "hola"'), '"di ""hola"""');
  assert.equal(csvCell('x\ny'), '"x\ny"');
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(null), '');
});
test('csvCell neutraliza fórmulas pero respeta números negativos', () => {
  assert.equal(csvCell('=SUMA(A1)'), "'=SUMA(A1)");
  assert.equal(csvCell('+54 11'), "'+54 11");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell('-3'), '-3');
});
test('toCsv lleva BOM y separador ;', () => {
  const t = toCsv(['a', 'b'], [[1, 'x;y']]);
  assert.ok(t.startsWith('\ufeffa;b\r\n'));
  assert.ok(t.endsWith('1;"x;y"'));
});
const o = { order_number: 7, status: 'ENTREGADO', created_at: '2026-01-05T12:30:00Z', customer_name: 'Ana <b>', supplier: 'Prov', total_requested: 100, total_delivered: 60,
  items: [{ product_name: 'Yerba', product_code: 'Y1', unit_price: 20, qty_requested: 5, qty_approved: 4, qty_delivered: 3 }] };
test('cantidades y totales finales', () => {
  assert.equal(finalQty(o.items[0]), 3);
  assert.equal(finalQty({ qty_requested: 5 }), 5);
  assert.equal(finalTotal(o), 60);
  assert.equal(finalTotal({ total_requested: 9 }), 9);
});
test('texto y remito incluyen datos y escapan HTML', () => {
  const t = orderText(o); assert.match(t, /Pedido número 7/); assert.match(t, /Yerba \(Y1\) × 3/);
  const h = remitoHtml(o); assert.match(h, /Ana &lt;b&gt;/); assert.ok(!h.includes('Ana <b>'));
});
test('parseLow valida el umbral', () => {
  assert.equal(parseLow('12'), 12); assert.equal(parseLow('-1'), 5); assert.equal(parseLow('abc'), 5); assert.equal(parseLow('0'), 0);
});
