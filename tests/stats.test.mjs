import test from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, previousRange, daysBetween, granularityFor, bucketSeries, niceScale, delta } from '../src/js/stats-utils.js';
import { orderFullTitle, orderClient, accountBadge } from '../src/js/format.js';

const T = new Date(2026, 10, 6); // 6 nov 2026 (viernes)
test('períodos', () => {
  assert.deepEqual(periodRange('hoy', T), { from: '2026-11-06', to: '2026-11-06' });
  assert.deepEqual(periodRange('7d', T), { from: '2026-10-31', to: '2026-11-06' });
  assert.deepEqual(periodRange('30d', T), { from: '2026-10-08', to: '2026-11-06' });
  assert.deepEqual(periodRange('mes', T), { from: '2026-11-01', to: '2026-11-06' });
  assert.deepEqual(periodRange('mes_ant', T), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(periodRange('anio', T), { from: '2026-01-01', to: '2026-11-06' });
});
test('período anterior y días', () => {
  assert.equal(daysBetween('2026-11-01', '2026-11-06'), 6);
  assert.deepEqual(previousRange({ from: '2026-11-01', to: '2026-11-06' }), { from: '2026-10-26', to: '2026-10-31' });
  assert.equal(granularityFor(30), 'day'); assert.equal(granularityFor(90), 'week'); assert.equal(granularityFor(365), 'month');
});
test('agrupar serie por semana y mes', () => {
  const s = [{ d: '2026-11-02', orders: 1, revenue: 100, cost: 60 }, { d: '2026-11-05', orders: 2, revenue: 50, cost: 20 }, { d: '2026-11-09', orders: 1, revenue: 10, cost: 5 }];
  const w = bucketSeries(s, 'week');
  assert.equal(w.length, 2); assert.equal(w[0].key, '2026-11-02'); assert.equal(w[0].revenue, 150); assert.equal(w[0].profit, 70);
  const m = bucketSeries(s, 'month'); assert.equal(m.length, 1); assert.equal(m[0].orders, 4);
});
test('escala y variación', () => {
  const sc = niceScale(870); assert.equal(sc.max, 1000); assert.deepEqual(sc.ticks, [0, 250, 500, 750, 1000]);
  assert.equal(niceScale(0).max, 1);
  assert.equal(delta(150, 100), 50); assert.equal(delta(5, 0), null);
});
test('título del pedido con cliente', () => {
  assert.equal(orderFullTitle({ order_number: 12, customer_name: 'Juan Pérez' }), 'Pedido número 12 del cliente Juan Pérez');
  assert.equal(orderClient({}), 'Cliente público general');
  assert.match(accountBadge('VENCIDO'), /Vencido/); assert.match(accountBadge(null), /Contado/);
});
