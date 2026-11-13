// Selector de «cómo se paga» con varios medios a la vez (mixto): efectivo + Mercado Pago + cuenta, etc.
// Se monta dentro de cualquier formulario. Con `total` muestra cuánto falta o sobra; sin `total` solo suma.
import { esc, money } from './format.js';
import { splitSummary } from './cash-utils.js';

export const SPLIT_METHODS = ['Efectivo', 'Mercado Pago', 'Transferencia', 'Tarjeta', 'Cheque', 'Otro'].map((key) => ({ key, label: key === 'Transferencia' ? 'Cuenta (transferencia)' : key }));

/**
 * @param {HTMLElement} box     contenedor donde se dibuja
 * @param {object} o
 *   methods: [{ key, label? }]   medios disponibles (el primero es el inicial)
 *   total:   número | null       importe a cubrir (null = libre)
 *   max:     máximo de medios en la misma operación (por defecto 3)
 *   initial: texto del monto inicial (por defecto el total)
 *   onChange: () => void
 */
export function mountPaySplit(box, { methods, total = null, max = 3, initial = null, onChange = () => {} } = {}) {
  const limit = Math.max(1, Math.min(max, methods.length));
  const label = (k) => methods.find((m) => m.key === k)?.label || k;
  const fmtIn = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
  let due = total === null || total === undefined ? null : Number(total);
  const rows = [{ method: methods[0].key, amount: initial !== null ? String(initial) : (due && due > 0 ? fmtIn(due) : '') }];

  const sum = () => splitSummary(rows, due ?? 0);
  const unused = () => methods.find((m) => !rows.some((r) => r.method === m.key))?.key;

  function drawRows() {
    box.innerHTML = `<div class="ps-rows">${rows.map((r, i) => `
      <div class="ps-row" data-i="${i}">
        <select aria-label="Medio de pago ${i + 1}" data-m>${methods.map((m) => `<option value="${esc(m.key)}" ${m.key === r.method ? 'selected' : ''} ${rows.some((x, j) => j !== i && x.method === m.key) ? 'disabled' : ''}>${esc(m.label || m.key)}</option>`).join('')}</select>
        <input data-a inputmode="decimal" placeholder="0" autocomplete="off" value="${esc(r.amount)}" aria-label="Monto en ${esc(label(r.method))}">
        ${due !== null ? '<button type="button" class="ps-btn" data-rest title="Completar con lo que falta">Resto</button>' : ''}
        ${rows.length > 1 ? `<button type="button" class="ps-btn ps-x" data-del aria-label="Quitar este medio">×</button>` : ''}
      </div>`).join('')}</div>
      ${rows.length < limit ? '<button type="button" class="btn sm ps-add" data-add>+ Pagar también con otro medio</button>' : ''}
      <div class="ps-sum" id="ps-sum" role="status" aria-live="polite"></div>`;
    drawSum();
  }
  function drawSum() {
    const s = sum(); const el = box.querySelector('#ps-sum'); if (!el) return;
    let html; let cls = '';
    if (due === null) html = `<span>Total</span><b>${esc(money(s.paid))}</b>`;
    else if (s.over > 0) { cls = 'bad'; html = `<span>Se pasa por</span><b>${esc(money(s.over))}</b>`; }
    else if (s.missing > 0) { cls = s.paid > 0 ? 'warn' : ''; html = `<span>Cobrado ${esc(money(s.paid))} de ${esc(money(s.total))} · falta</span><b>${esc(money(s.missing))}</b>`; }
    else { cls = 'ok'; html = `<span>Cobrado completo</span><b>${esc(money(s.paid))}</b>`; }
    el.className = `ps-sum ${cls}`; el.innerHTML = html;
  }

  box.addEventListener('input', (e) => {
    const row = e.target.closest('.ps-row'); if (!row || !e.target.matches('[data-a]')) return;
    rows[Number(row.dataset.i)].amount = e.target.value; drawSum(); onChange();
  });
  box.addEventListener('change', (e) => {
    const row = e.target.closest('.ps-row'); if (!row || !e.target.matches('[data-m]')) return;
    rows[Number(row.dataset.i)].method = e.target.value; drawRows(); onChange();
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-add]')) {
      const m = unused(); if (!m) return;
      rows.push({ method: m, amount: due !== null && sum().missing > 0 ? fmtIn(sum().missing) : '' });
      drawRows(); box.querySelector(`.ps-row[data-i="${rows.length - 1}"] [data-a]`)?.focus(); onChange();
    } else if (b.matches('[data-del]')) {
      rows.splice(Number(b.closest('.ps-row').dataset.i), 1); drawRows(); onChange();
    } else if (b.matches('[data-rest]')) {
      const i = Number(b.closest('.ps-row').dataset.i); const others = rows.reduce((a, r, j) => (j === i ? a : a + (splitSummary([r]).paid)), 0);
      rows[i].amount = fmtIn(Math.max(0, Math.round((due - others) * 100) / 100)); drawRows(); onChange();
    }
  });

  drawRows();
  return {
    parts: () => sum().parts,
    summary: sum,
    /** Deja un solo medio con este monto (botón «Cobrar saldo completo») */
    setAll(n) { rows.splice(1); rows[0].amount = fmtIn(n); drawRows(); onChange(); },
    setTotal(t) { due = t === null ? null : Number(t); drawSum(); },
    /** Mensaje de error si lo escrito no sirve (o null si está bien) */
    problem({ exact = false } = {}) {
      const s = sum();
      if (!s.parts.length) return 'Escriba cuánto se paga y con qué medio.';
      if (s.repeated) return 'No repita el mismo medio de pago.';
      if (rows.some((r) => String(r.amount).trim() && splitSummary([r]).paid === 0)) return 'Hay un monto que no es válido.';
      if (due !== null && s.over > 0) return `El cobro supera el total (${money(due)}).`;
      if (due !== null && exact && s.missing > 0) return `Falta cobrar ${money(s.missing)}.`;
      return null;
    },
  };
}
