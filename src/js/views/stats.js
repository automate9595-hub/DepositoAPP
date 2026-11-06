import { rpc, friendly } from '../api.js';
import { esc, money, compact, percent, statusLabel, dateTime } from '../format.js';
import { $, $$, spinner, errorBox, icon } from '../ui.js';
import { PERIODS, periodRange, previousRange, daysBetween, granularityFor, bucketSeries, bucketLabel, bucketTitle, delta, parseISO } from '../stats-utils.js';
import { mountChart, donut, hbars, sparkline, PALETTE } from '../charts.js';

const STATUS_COLOR = {
  PENDIENTE_APROBACION: 'var(--ch2)', APROBADO: 'var(--ch1)', EN_PREPARACION: 'var(--ch6)', PREPARADO_PARCIALMENTE: 'var(--ch4)',
  LISTO_PARA_ENTREGAR: 'var(--ch3)', ENTREGADO: 'var(--ok)', RECHAZADO: 'var(--bad)', CANCELADO: 'var(--idle)',
};
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const fmtDay = (iso) => parseISO(iso).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function countUp(node, to, fmt) {
  if (reduced() || !Number.isFinite(to) || to === 0) { node.textContent = fmt(to); return; }
  const t0 = performance.now(); const dur = 800;
  const tick = (t) => { const k = Math.min(1, (t - t0) / dur); const e = 1 - (1 - k) ** 3; node.textContent = fmt(to * e); if (k < 1 && node.isConnected) requestAnimationFrame(tick); else node.textContent = fmt(to); };
  requestAnimationFrame(tick);
}
const deltaBadge = (d, goodUp = true) => (d == null ? '' : `<span class="dlt ${d === 0 ? '' : (d > 0) === goodUp ? 'up' : 'down'}">${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d).toLocaleString(undefined, { maximumFractionDigits: 0 })}%</span>`);

export async function statsView(el) {
  let key = '30d'; let custom = periodRange('30d'); let prodMetric = 'revenue'; let data = null;
  el.innerHTML = `<div class="stack">
    <div class="chips" id="per">${PERIODS.map((p) => `<button class="chip ${p.key === key ? 'on' : ''}" data-p="${p.key}">${p.label}</button>`).join('')}</div>
    <div id="cust" class="card row wrap hidden"><label class="field grow"><span>Desde</span><input type="date" id="df" value="${custom.from}"></label>
      <label class="field grow"><span>Hasta</span><input type="date" id="dt" value="${custom.to}"></label><button class="btn primary" id="ap" style="align-self:flex-end">Aplicar</button></div>
    <div id="b" class="stack"></div></div>`;
  const box = $('#b', el);

  const range = () => (key === 'custom' ? custom : periodRange(key));
  const call = (r) => rpc('admin_stats_range', { p_from: r.from, p_to: r.to, p_tz: tz() }, { retries: 1 });

  async function load() {
    const r = range(); box.innerHTML = spinner();
    try {
      const [cur, prev] = await Promise.all([call(r), call(previousRange(r)).catch(() => null)]);
      data = { cur, prev, r }; render();
    } catch (e) {
      const msg = String(e?.message || '') + String(e?.code || '');
      box.innerHTML = /admin_stats_range|PGRST202|schema cache/i.test(msg)
        ? `<div class="notice">Falta actualizar la base de datos: ejecute <b>06_clientes_costos.sql</b> en Supabase (SQL Editor) y recargue.</div>`
        : errorBox(friendly(e));
      $('[data-retry]', box)?.addEventListener('click', load);
    }
  }

  function render() {
    const { cur, prev, r } = data; const t = cur.totals; const pt = prev?.totals;
    const days = daysBetween(r.from, r.to); const gran = granularityFor(days);
    const b = bucketSeries(cur.series, gran);
    const profit = Number(t.revenue) - Number(t.cost); const margin = Number(t.revenue) > 0 ? (profit / Number(t.revenue)) * 100 : 0;
    const pProfit = pt ? Number(pt.revenue) - Number(pt.cost) : 0;
    const avg = Number(t.delivered_orders) ? Number(t.revenue) / Number(t.delivered_orders) : 0;
    const kpis = [
      { k: 'rev', label: 'Ventas entregadas', v: Number(t.revenue), fmt: money, d: delta(t.revenue, pt?.revenue), spark: b.map((x) => x.revenue), color: 'var(--ch1)' },
      { k: 'pro', label: 'Ganancia', v: profit, fmt: money, d: delta(profit, pProfit), spark: b.map((x) => x.profit), color: 'var(--ch3)', sub: `Margen ${percent(margin)}` },
      { k: 'ord', label: 'Pedidos recibidos', v: Number(t.orders_total), fmt: (n) => Math.round(n).toLocaleString(), d: delta(t.orders_total, pt?.orders_total), spark: b.map((x) => x.orders), color: 'var(--ch2)', sub: `${t.delivered_orders} entregados` },
      { k: 'avg', label: 'Ticket promedio', v: avg, fmt: money, d: pt && Number(pt.delivered_orders) ? delta(avg, Number(pt.revenue) / Number(pt.delivered_orders)) : null },
      { k: 'uni', label: 'Unidades entregadas', v: Number(t.units), fmt: (n) => Math.round(n).toLocaleString(), d: delta(t.units, pt?.units) },
      { k: 'rec', label: 'Por cobrar a clientes', v: Number(cur.receivables.total_debt), fmt: money, sub: `${cur.receivables.debtors} cliente${cur.receivables.debtors === 1 ? '' : 's'} con saldo`, bad: Number(cur.receivables.total_debt) > 0 },
    ];
    const sv = cur.stock_value;
    const prodSorted = [...cur.top_products].sort((a, c) => Number(c[prodMetric]) - Number(a[prodMetric])).slice(0, 8);
    const pm = { revenue: ['Ventas', money, 'var(--ch1)'], units: ['Unidades', (v) => `${Math.round(v)} u.`, 'var(--ch2)'], profit: ['Ganancia', money, 'var(--ch3)'] }[prodMetric];
    const stEntries = Object.entries(cur.by_status).map(([s, n]) => ({ label: statusLabel(s), value: Number(n), color: STATUS_COLOR[s] || 'var(--idle)' }));
    box.innerHTML = `
      <p class="muted small">Del <b>${fmtDay(r.from)}</b> al <b>${fmtDay(r.to)}</b> · ${days} día${days === 1 ? '' : 's'}${prev ? ' · variaciones contra el período anterior' : ''}</p>
      ${Number(t.items_without_cost) > 0 ? `<div class="notice">Hay ${t.items_without_cost} renglón(es) entregado(s) de productos sin precio de costo cargado: la ganancia puede estar sobreestimada. Cargue el costo en <b>Productos</b>.</div>` : ''}
      <div class="kpis">${kpis.map((k) => `<div class="card kpi"><div class="row between"><span class="muted small">${k.label}</span>${deltaBadge(k.d, !k.bad)}</div>
        <div class="kv-val ${k.bad ? 'bad' : ''}" data-kv="${k.k}">${k.fmt(0)}</div>
        ${k.sub ? `<div class="muted small" style="white-space:nowrap">${esc(k.sub)}</div>` : ''}
        ${k.spark ? `<div class="sp">${sparkline(k.spark, k.color)}</div>` : ''}</div>`).join('')}</div>
      <div class="card stack"><h3>Ventas, costo y ganancia</h3><div id="c1"></div></div>
      <div class="card stack"><h3>Pedidos recibidos</h3><div id="c2"></div></div>
      <div class="two">
        <div class="card stack"><h3>Pedidos por estado</h3>${donut(stEntries, { center: String(t.orders_total), sub: 'pedidos' })}</div>
        <div class="card stack"><h3>Mejores clientes</h3>${hbars(cur.by_customer.slice(0, 7).map((c) => ({ name: c.name, value: Number(c.revenue), sub: `${c.orders} pedido${c.orders === 1 ? '' : 's'}` })), { fmt: money, color: 'var(--ch4)' })}</div>
      </div>
      <div class="card stack"><div class="row between wrap"><h3>Productos más vendidos</h3>
        <div class="seg" id="pm" style="min-width:230px">${[['revenue', 'Ventas'], ['units', 'Unidades'], ['profit', 'Ganancia']].map(([k, l]) => `<button class="${k === prodMetric ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div></div>
        <div id="prod">${hbars(prodSorted.map((p) => ({ name: p.name, value: Number(p[prodMetric]) })), { fmt: pm[1], color: pm[2] })}</div></div>
      <div class="two">
        <div class="card stack"><h3>Proveedores</h3>${hbars(cur.by_supplier.slice(0, 7).map((s) => ({ name: s.name, value: Number(s.revenue), sub: `${s.orders} pedido${s.orders === 1 ? '' : 's'} · ganancia ${money(s.profit)}` })), { fmt: money, color: 'var(--ch6)' })}</div>
        <div class="card stack"><h3>Valor del inventario</h3>
          <div class="kv"><span class="muted">A precio de costo</span><b class="mono">${money(sv.cost)}</b><span class="muted">A precio de venta</span><b class="mono">${money(sv.sale)}</b>
          <span class="muted">Ganancia potencial</span><b class="mono" style="color:var(--ok)">${money(Number(sv.sale) - Number(sv.cost))}</b></div>
          <h3 style="margin-top:6px">Stock bajo (5 o menos)</h3>
          ${cur.low_stock.length ? cur.low_stock.slice(0, 8).map((x) => `<div class="row between small"><span class="ellipsis">${esc(x.name)}</span><b style="color:var(--bad)">${x.available}</b></div>`).join('') : '<p class="muted small">Todo en orden.</p>'}</div>
      </div>`;
    kpis.forEach((k) => countUp($(`[data-kv="${k.k}"]`, box), k.v, k.fmt));
    const labels = b.map((x) => bucketLabel(x.key, gran)); const titles = b.map((x) => bucketTitle(x.key, gran));
    mountChart($('#c1', box), { type: 'line', labels, titles, aria: 'Ventas, costo y ganancia en el tiempo', fmt: money, fmtAxis: compact, series: [
      { key: 'rev', name: 'Ventas', color: PALETTE[0], values: b.map((x) => x.revenue), area: true },
      { key: 'cost', name: 'Costo', color: PALETTE[1], values: b.map((x) => x.cost) },
      { key: 'pro', name: 'Ganancia', color: PALETTE[2], values: b.map((x) => x.profit), area: true }] });
    mountChart($('#c2', box), { type: 'bar', labels, titles, height: 190, aria: 'Pedidos recibidos', fmt: (v) => `${v} pedido${v === 1 ? '' : 's'}`, fmtAxis: (v) => String(Math.round(v)), series: [{ key: 'ord', name: 'Pedidos', color: PALETTE[1], values: b.map((x) => x.orders) }] });
  }

  el.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]');
    if (p) { key = p.dataset.p; $$('#per .chip', el).forEach((c) => c.classList.toggle('on', c === p)); $('#cust', el).classList.toggle('hidden', key !== 'custom'); if (key !== 'custom') load(); return; }
    if (e.target.closest('#ap')) {
      const f = $('#df', el).value; const t = $('#dt', el).value;
      if (!f || !t || t < f) { $('#df', el).focus(); return; }
      custom = { from: f, to: t }; load(); return;
    }
    const m = e.target.closest('[data-m]');
    if (m && data) { prodMetric = m.dataset.m; render(); }
  });
  await load();
  return { refresh: (k) => { if (k.includes('resync')) load(); } };
}
