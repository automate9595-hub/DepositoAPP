import test from 'node:test';
import assert from 'node:assert/strict';
import { todayAR, shiftDay, isDay, parseMoney, methodSegments, calcArqueo, receiptText, receiptHtml, fmtDayShort } from '../src/js/cash-utils.js';

test('todayAR usa la hora de Argentina (UTC-3)', () => {
  assert.equal(todayAR(new Date('2026-11-07T02:30:00Z')), '2026-11-06');   // aún es el 6 en Argentina
  assert.equal(todayAR(new Date('2026-11-07T03:00:00Z')), '2026-11-07');
});
test('shiftDay cruza meses y años', () => {
  assert.equal(shiftDay('2026-11-07', -1), '2026-11-06');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
});
test('isDay valida el formato', () => {
  assert.ok(isDay('2026-11-07')); assert.ok(!isDay('07/11/2026')); assert.ok(!isDay('2026-13-40')); assert.ok(!isDay(null));
});
test('parseMoney acepta formatos argentinos y simples', () => {
  assert.equal(parseMoney('1.234,50'), 1234.5);
  assert.equal(parseMoney('1234.5'), 1234.5);
  assert.equal(parseMoney('$ 12.500'), 12500);
  assert.equal(parseMoney('1.234.567'), 1234567);
  assert.equal(parseMoney('  '), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(''), null);
});
test('methodSegments ordena por medio y omite los vacíos', () => {
  const s = methodSegments({ Efectivo: 100, Transferencia: 0, Tarjeta: 50, Raro: 9 });
  assert.deepEqual(s.map((x) => x.label), ['Efectivo', 'Tarjeta']);
});
test('calcArqueo: cuadra, sobra, falta y pendiente', () => {
  assert.deepEqual(calcArqueo({ opening: 1000, withdrawals: 200, cashIncome: 5000, counted: 5800 }), { expected: 5800, difference: 0, state: 'ok' });
  assert.equal(calcArqueo({ opening: 0, withdrawals: 0, cashIncome: 100, counted: 150.5 }).state, 'over');
  assert.equal(calcArqueo({ opening: 0, withdrawals: 0, cashIncome: 100, counted: 90 }).difference, -10);
  assert.equal(calcArqueo({ opening: 0, withdrawals: 0, cashIncome: 100 }).state, 'pending');
  assert.equal(calcArqueo({ opening: 0.1, withdrawals: 0, cashIncome: 0.2, counted: 0.3 }).state, 'ok');   // sin errores de punto flotante
});
const rep = { day: '2026-11-07', total: 15000, count: 3, by_method: { Efectivo: 10000, Transferencia: 5000 }, delivered_total: 20000, delivered_count: 2,
  payments: [{ at: '2026-11-07T15:00:00Z', method: 'Efectivo', amount: 10000, order_number: 12, customer: 'Juan <b>', preventista: 'Ana' }] };
test('receiptText incluye medios, total y diferencia', () => {
  const arq = calcArqueo({ opening: 500, withdrawals: 0, cashIncome: 10000, counted: 10400 });
  const t = receiptText(rep, arq, { opening: 500, counted: 10400, who: 'Fran' });
  assert.match(t, /Efectivo/); assert.match(t, /Transferencia/); assert.match(t, /Total cobrado/); assert.match(t, /Falta dinero/); assert.match(t, /Fran/);
});
test('receiptHtml escapa el texto de los clientes', () => {
  const html = receiptHtml(rep, calcArqueo({ cashIncome: 10000, counted: 10000 }), { counted: 10000 });
  assert.ok(!html.includes('<b>>')); assert.ok(html.includes('Juan &lt;b&gt;')); assert.match(html, /La caja cuadra/);
});
test('fmtDayShort devuelve un texto corto', () => { assert.ok(fmtDayShort('2026-11-07').length > 3); });
