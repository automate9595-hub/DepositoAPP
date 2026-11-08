import { rpc, friendly } from '../api.js';
import { can, state } from '../state.js';
import { $, $$, spinner, errorBox, icon, busy, ok, fail, confirmBox, modal } from '../ui.js';
import { esc, money, compact, timeOnly, dateTime } from '../format.js';
import { donut, mountChart } from '../charts.js';
import { METHODS, todayAR, shiftDay, isDay, fmtDayLong, fmtDayShort, parseMoney, methodSegments, calcArqueo, calcMp, ARQUEO_LABEL, receiptText, receiptHtml } from '../cash-utils.js';
import { printHtml, shareText, downloadCsv } from '../tools.js';

const METHOD = Object.fromEntries(METHODS.map((m) => [m.key, m]));
const VERDICT_ICON = { pending: 'clock', ok: 'check', over: 'plus', short: 'alert' };

export async function cashView(el) {
  if (!can('cash')) { el.innerHTML = '<div class="notice">No tiene permiso para ver la caja. Pídaselo al administrador principal (Usuarios › Permisos › Caja y arqueo).</div>'; return; }
  const today = todayAR();
  let day = today; let rep = null; let form = { opening: '', withdrawals: '', counted: '', countedMp: '', notes: '' };

  el.innerHTML = `<div class="cj">
    <div class="cj-bar">
      <button type="button" class="cj-nb" id="pv" aria-label="Día anterior">${icon('chevL')}</button>
      <label class="cj-date"><span class="sr">Elegir el día</span>${icon('calendar')}<input type="date" id="dt" max="${today}" value="${day}"></label>
      <button type="button" class="cj-nb" id="nx" aria-label="Día siguiente">${icon('chevR')}</button>
      <button type="button" class="btn sm" id="hy">Hoy</button>
    </div>
    <div id="cb" class="stack"></div></div>`;
  const body = $('#cb', el);
  const go = (d) => { if (isDay(d) && d <= today) load(d); };
  $('#pv', el).addEventListener('click', () => go(shiftDay(day, -1)));
  $('#nx', el).addEventListener('click', () => go(shiftDay(day, 1)));
  $('#hy', el).addEventListener('click', () => go(today));
  $('#dt', el).addEventListener('change', (e) => go(e.target.value));

  async function load(d) {
    day = d; $('#dt', el).value = d; $('#nx', el).disabled = d >= today; $('#hy', el).classList.toggle('on', d === today);
    body.innerHTML = spinner('Cargando la caja…');
    try {
      rep = await rpc('cash_report', { p_day: d }, { retries: 1 });
      const c = rep.closing;
      form = c ? { opening: String(c.opening_cash), withdrawals: String(c.withdrawals), counted: String(c.counted_cash), countedMp: c.counted_mp === null || c.counted_mp === undefined ? '' : String(c.counted_mp), notes: c.notes || '' }
               : { opening: '', withdrawals: '', counted: '', countedMp: '', notes: '' };
      render();
      // Primera vez del día en la caja: se ofrece iniciarla (una sola vez por sesión si elige «Ahora no»)
      if (d === today && !rep.opening && !rep.closing && !sessionStorage.getItem(`cj-skip-${d}`)) askStart();
    } catch (e) { body.innerHTML = errorBox(friendly(e)); $('[data-retry]', body)?.addEventListener('click', () => load(d)); }
  }

  async function askStart() {
    const yes = await modal(`<h2>¿Iniciar la caja de hoy?</h2><p class="muted">Es la primera vez que entra a la caja hoy. Si la inicia, anota con cuánto efectivo y cuánto saldo de Mercado Pago empieza el día, y al final el arqueo le dice si cuadra.</p>
      <div class="row" style="margin-top:16px"><button class="btn grow" data-close type="button">Ahora no</button><button class="btn primary grow" data-ok type="button">${icon('wallet')} Sí, iniciar caja</button></div>`,
      { onMount: (ov, close) => ov.querySelector('[data-ok]').addEventListener('click', () => close(true)) });
    if (yes === true) await openForm(); else sessionStorage.setItem(`cj-skip-${today}`, '1');
  }
  // Formulario de inicio de caja: efectivo, Mercado Pago y % de retención
  async function openForm() {
    const o = rep.opening; const pctDefault = o ? o.mp_retention_pct : rep.last_pct;
    const saved = await modal(`<h2>${o ? 'Editar el inicio de caja' : 'Iniciar caja'}</h2>
      <p class="muted small">${esc(fmtDayLong(day))}</p>
      <form id="of" class="stack" novalidate>
        <label class="field"><span>Efectivo en caja</span><input name="cash" inputmode="decimal" placeholder="0" value="${o ? esc(String(o.opening_cash)) : ''}" autocomplete="off" required></label>
        <label class="field"><span>Saldo en Mercado Pago</span><input name="mp" inputmode="decimal" placeholder="0" value="${o ? esc(String(o.opening_mp)) : ''}" autocomplete="off"></label>
        <label class="field"><span>Retención de Mercado Pago (%)</span><input name="pct" inputmode="decimal" placeholder="0" value="${pctDefault ? esc(String(pctDefault).replace('.', ',')) : ''}" autocomplete="off"><small class="muted">Porcentaje que Mercado Pago se queda de lo que se cobra por ahí. Se descuenta del saldo esperado.</small></label>
        <p class="notice bad small hidden" id="oe" role="alert"></p>
        <div class="row"><button class="btn grow" type="button" data-close>Cancelar</button><button class="btn primary grow">${o ? 'Guardar' : 'Iniciar caja'}</button></div>
      </form>`, { onMount: (ov, close) => {
        const f = ov.querySelector('#of'); const err = ov.querySelector('#oe');
        f.addEventListener('submit', async (e) => {
          e.preventDefault(); err.classList.add('hidden');
          const cash = parseMoney(f.cash.value) ?? 0; const mp = parseMoney(f.mp.value) ?? 0; const pct = parseMoney(f.pct.value) ?? 0;
          if (cash < 0 || mp < 0) { err.textContent = 'Los montos no pueden ser negativos.'; err.classList.remove('hidden'); return; }
          if (pct < 0 || pct > 100) { err.textContent = 'La retención debe estar entre 0 y 100.'; err.classList.remove('hidden'); return; }
          await busy(f.querySelector('button:not([type=button])'), async () => {
            try { close(await rpc('cash_open', { p_day: day, p_cash: cash, p_mp: mp, p_pct: pct })); }
            catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
          });
        });
      } });
    if (saved && typeof saved === 'object') {
      rep = saved; ok('Caja iniciada'); render();
    }
  }

  const nums = () => ({ opening: rep.opening ? Number(rep.opening.opening_cash) : (parseMoney(form.opening) ?? 0), withdrawals: parseMoney(form.withdrawals) ?? 0, counted: parseMoney(form.counted), countedMp: parseMoney(form.countedMp) });
  const calc = () => { const n = nums(); return calcArqueo({ opening: n.opening, withdrawals: n.withdrawals, cashIncome: Number(rep.by_method?.Efectivo || 0), counted: n.counted }); };
  const mpCalc = () => calcMp({ opening: rep.mp?.opening, gross: rep.mp?.gross, pct: rep.mp?.pct, counted: nums().countedMp });
  const receiptOpts = () => { const n = nums(); const c = rep.closing; return { opening: n.opening, withdrawals: n.withdrawals, counted: n.counted, countedMp: n.countedMp, notes: form.notes, who: c?.closed_by_name || state.profile?.full_name || '', closedAt: c?.closed_at || null }; };

  function render() {
    const c = rep.closing; const by = rep.by_method || {}; const arq = calc();
    const maxWeek = Math.max(1, ...rep.week.map((w) => Number(w.total)));
    const stale = c && Math.abs(Number(c.total_income) - Number(rep.total)) > 0.004;
    body.innerHTML = `
      <section class="cj-hero">
        <small>${esc(fmtDayLong(day))}</small>
        <div class="cj-total">${esc(money(rep.total))}</div>
        <p>Total cobrado · ${rep.count} cobro${rep.count === 1 ? '' : 's'}${Number(rep.delivered_count) > 0 ? ` · ${rep.delivered_count} pedido${rep.delivered_count === 1 ? '' : 's'} entregado${rep.delivered_count === 1 ? '' : 's'} por ${esc(money(rep.delivered_total))}` : ''}</p>
        <div class="cj-pills">${METHODS.filter((m) => Number(by[m.key] || 0) > 0).map((m) => `<span class="cj-pill" style="--c:${m.color}">${icon(m.icon)}<b>${esc(m.key)}</b> ${esc(money(by[m.key]))}</span>`).join('') || '<span class="cj-pill">Sin cobros este día</span>'}</div>
        <div class="cj-state ${c ? 'closed' : ''}">${c ? `${icon('lock')} Caja cerrada · ${esc(dateTime(c.closed_at))}${c.closed_by_name ? ' · ' + esc(c.closed_by_name) : ''}` : `${icon('clock')} ${rep.opening ? 'Caja iniciada · ' + esc(timeOnly(rep.opening.opened_at)) : day === today ? 'Caja sin iniciar' : 'Sin cierre de caja'}`}</div>
        ${!rep.opening && !c && day === today ? `<button type="button" class="btn accent" id="st">${icon('wallet')} Iniciar caja</button>` : ''}
        ${rep.opening ? `<div class="cj-open"><span>Efectivo inicial <b>${esc(money(rep.opening.opening_cash))}</b></span><span>Mercado Pago inicial <b>${esc(money(rep.opening.opening_mp))}</b></span><span>Retención MP <b>${esc(String(rep.opening.mp_retention_pct).replace('.', ','))}%</b></span>${c ? '' : '<button type="button" class="cj-edit" id="oe2">Editar</button>'}</div>` : ''}
      </section>

      <section class="card stack"><h3>¿Cómo se cobró?</h3><div id="dn">${donut(methodSegments(by), { center: compact(rep.total), sub: 'cobrado', fmt: money })}</div></section>

      <section class="card stack"><h3>Últimos 7 días</h3><p class="muted small">Toque un día para verlo.</p>
        <div class="cj-days">${rep.week.map((w) => `<button type="button" class="cj-day ${w.day === day ? 'on' : ''}" data-day="${w.day}" aria-label="${esc(fmtDayShort(w.day))}: ${esc(money(w.total))}">
          <span class="cj-col"><i style="height:${Math.max(3, (Number(w.total) / maxWeek) * 100)}%"></i></span><b>${esc(compact(w.total))}</b><small>${esc(fmtDayShort(w.day))}</small></button>`).join('')}</div></section>

      ${rep.hours.length ? '<section class="card stack"><h3>Cobros por hora</h3><div id="hc"></div></section>' : ''}

      <section class="card stack cj-arq"><h3>Arqueo de efectivo</h3>
        <p class="muted small">Siga los pasos: compare el efectivo que tendría que haber con el que realmente hay en la caja.</p>
        ${rep.opening ? `<div class="cj-step"><span class="cj-n">1</span><div class="grow"><b>Fondo inicial</b><small>Efectivo con el que se inició la caja</small></div><b class="mono">${esc(money(rep.opening.opening_cash))}</b></div>`
          : `<div class="cj-step"><span class="cj-n">1</span><div class="grow"><b>Fondo inicial</b><small>Dinero con el que se abrió la caja</small></div><input id="op" inputmode="decimal" placeholder="0" value="${esc(form.opening)}" aria-label="Fondo inicial"></div>`}
        <div class="cj-step"><span class="cj-n">2</span><div class="grow"><b>Retiros o gastos</b><small>Dinero que salió de la caja</small></div><input id="wd" inputmode="decimal" placeholder="0" value="${esc(form.withdrawals)}" aria-label="Retiros o gastos"></div>
        <div class="cj-calc" id="cc"></div>
        <div class="cj-step"><span class="cj-n">3</span><div class="grow"><b>Efectivo contado</b><small>Cuente los billetes y monedas de la caja</small></div><input id="ct" inputmode="decimal" placeholder="0" value="${esc(form.counted)}" aria-label="Efectivo contado"></div>
        <div class="cj-verdict" id="vd"></div>
        ${Number(rep.mp?.gross) > 0 || Number(rep.mp?.opening) > 0 ? `<h4 class="cj-sub">${icon('wallet')} Mercado Pago</h4><div class="cj-calc" id="mc"></div>
        <div class="cj-step"><span class="cj-n mp">MP</span><div class="grow"><b>Saldo real en Mercado Pago</b><small>Opcional: el saldo que ve en la aplicación</small></div><input id="cm" inputmode="decimal" placeholder="0" value="${esc(form.countedMp)}" aria-label="Saldo real en Mercado Pago"></div>
        <div class="cj-verdict" id="mv"></div>` : ''}
        <label class="field"><span>Nota (opcional)</span><textarea id="nt" maxlength="500" placeholder="Ej.: se retiraron $5.000 para pagar flete">${esc(form.notes)}</textarea></label>
        ${stale ? '<p class="notice small">Se registraron cobros después del último cierre. Actualice el cierre para que incluya todo.</p>' : ''}
        <button type="button" class="btn primary block" id="close">${icon('lock')} ${c ? 'Actualizar el cierre de caja' : 'Cerrar caja del día'}</button>
      </section>

      <section class="card stack"><h3>Comprobante</h3><p class="muted small">Envíe o guarde el resumen del día.</p>
        <button type="button" class="btn accent block" id="sh">${icon('share')} Enviar comprobante</button>
        <div class="row"><button type="button" class="btn grow" id="pr">${icon('print')} Imprimir o guardar PDF</button><button type="button" class="btn grow" id="cs">${icon('download')} Descargar Excel</button></div>
      </section>

      <section class="card stack"><h3>Cobros del día</h3>
        ${rep.payments.length ? `<div class="cj-list">${[...rep.payments].reverse().map((p) => `<div class="cj-pay"><span class="cj-pi" style="--c:${(METHOD[p.method] || METHOD.Otro).color}">${icon((METHOD[p.method] || METHOD.Otro).icon)}</span>
          <div class="grow"><b class="ellipsis">${p.order_number ? `Pedido ${esc(p.order_number)} · ` : 'Pago a cuenta · '}${esc(p.customer || '')}</b>
          <div class="muted small ellipsis">${esc(timeOnly(p.at))} · ${esc(p.method)}${p.preventista ? ' · Preventista: ' + esc(p.preventista) : ''}${p.by ? ' · Cobró: ' + esc(p.by) : ''}</div></div><b class="mono">${esc(money(p.amount))}</b></div>`).join('')}</div>` : '<div class="empty">No hay cobros registrados este día.</div>'}
      </section>`;

    if (rep.hours.length) {
      mountChart($('#hc', body), { type: 'bar', labels: rep.hours.map((h) => `${String(h.hour).padStart(2, '0')}h`), titles: rep.hours.map((h) => `${String(h.hour).padStart(2, '0')}:00 a ${String(h.hour).padStart(2, '0')}:59`),
        height: 170, aria: 'Cobros por hora', fmt: money, fmtAxis: compact, series: [{ key: 'h', name: 'Cobrado', color: '#2b7bb9', values: rep.hours.map((h) => Number(h.total)) }] });
    }
    $$('[data-day]', body).forEach((b) => b.addEventListener('click', () => go(b.dataset.day)));
    $('#st', body)?.addEventListener('click', openForm); $('#oe2', body)?.addEventListener('click', openForm);
    bindArqueo(); updateCalc(arq);
  }

  function updateCalc(arq = calc()) {
    const n = nums(); const cash = Number(rep.by_method?.Efectivo || 0);
    $('#cc', body).innerHTML = `<div><span>Fondo inicial</span><b>${esc(money(n.opening))}</b></div><div><span>+ Cobros en efectivo</span><b>${esc(money(cash))}</b></div>
      <div><span>− Retiros o gastos</span><b>${esc(money(n.withdrawals))}</b></div><div class="tot"><span>= Efectivo que debería haber</span><b>${esc(money(arq.expected))}</b></div>`;
    const v = $('#vd', body); v.dataset.s = arq.state;
    const mc = $('#mc', body);
    if (mc) {
      const mp = mpCalc(); const r = rep.mp;
      mc.innerHTML = `<div><span>Saldo inicial</span><b>${esc(money(r.opening))}</b></div><div><span>+ Cobrado por Mercado Pago</span><b>${esc(money(r.gross))}</b></div>
        <div><span>− Retención (${esc(String(r.pct).replace('.', ','))}%)</span><b>${esc(money(mp.retention))}</b></div><div class="tot"><span>= Saldo que debería haber</span><b>${esc(money(mp.expected))}</b></div>`;
      const mv = $('#mv', body); mv.dataset.s = mp.state;
      mv.innerHTML = `<span class="cj-vi">${icon(VERDICT_ICON[mp.state])}</span><div><b>${esc(ARQUEO_LABEL[mp.state].replace('La caja', 'Mercado Pago'))}</b>${mp.state === 'pending' ? '<small>Escriba el saldo real de Mercado Pago (opcional).</small>' : mp.difference ? `<small>${esc(money(Math.abs(mp.difference)))} ${mp.difference > 0 ? 'de más' : 'de menos'} respecto de lo esperado</small>` : '<small>El saldo coincide con lo esperado.</small>'}</div>`;
    }
    v.innerHTML = `<span class="cj-vi">${icon(VERDICT_ICON[arq.state])}</span><div><b>${esc(ARQUEO_LABEL[arq.state])}</b>${arq.state === 'pending' ? '<small>Escriba cuánto efectivo hay en la caja.</small>' : arq.difference ? `<small>${esc(money(Math.abs(arq.difference)))} ${arq.difference > 0 ? 'de más' : 'de menos'} respecto de lo esperado</small>` : '<small>El efectivo contado coincide con lo esperado.</small>'}</div>`;
  }
  function bindArqueo() {
    const sync = () => { form = { opening: $('#op', body)?.value ?? form.opening, withdrawals: $('#wd', body).value, counted: $('#ct', body).value, countedMp: $('#cm', body)?.value ?? form.countedMp, notes: $('#nt', body).value }; updateCalc(); };
    ['#op', '#wd', '#ct', '#cm', '#nt'].forEach((s) => $(s, body)?.addEventListener('input', sync));
    $('#close', body).addEventListener('click', (e) => closeCash(e.currentTarget));
    $('#sh', body).addEventListener('click', () => { const o = receiptOpts(); shareText(`Arqueo de caja ${rep.day}`, receiptText(rep, calc(), o)); });
    $('#pr', body).addEventListener('click', () => printHtml(receiptHtml(rep, calc(), receiptOpts())));
    $('#cs', body).addEventListener('click', () => downloadCsv(`caja-${rep.day}.csv`, ['Hora', 'Concepto', 'Cliente', 'Preventista', 'Medio', 'Importe', 'Registró'],
      rep.payments.map((p) => [timeOnly(p.at), p.order_number ? `Pedido ${p.order_number}` : 'Pago a cuenta', p.customer || '', p.preventista || '', p.method, Number(p.amount), p.by || ''])));
  }

  async function closeCash(btn) {
    const n = nums(); const arq = calc();
    if (n.counted === null) { fail('Primero escriba el efectivo contado (paso 3).'); $('#ct', body).focus(); return; }
    const msg = `Esperado en caja: ${money(arq.expected)}. Contado: ${money(n.counted)}. ${arq.state === 'ok' ? 'La caja cuadra.' : `${ARQUEO_LABEL[arq.state]}: ${money(Math.abs(arq.difference))}.`}`;
    if (!(await confirmBox(rep.closing ? 'Actualizar el cierre' : 'Cerrar la caja', msg, { okText: rep.closing ? 'Actualizar' : 'Cerrar caja' }))) return;
    await busy(btn, async () => {
      try {
        rep = await rpc('cash_close', { p_day: day, p_opening: n.opening, p_withdrawals: n.withdrawals, p_counted: n.counted, p_notes: form.notes.trim() || null, p_counted_mp: n.countedMp });
        ok('Caja cerrada. Ya puede enviar el comprobante.'); render();
        $('#sh', body)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { fail(friendly(e)); }
    });
  }

  await load(day);
}
