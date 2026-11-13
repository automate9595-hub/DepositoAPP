import { rpc, friendly } from '../api.js';
import { can, state } from '../state.js';
import { $, $$, spinner, errorBox, icon, busy, ok, fail, confirmBox, modal } from '../ui.js';
import { esc, money, compact, timeOnly, dateTime } from '../format.js';
import { donut, mountChart } from '../charts.js';
import { METHODS, todayAR, shiftDay, isDay, fmtDayLong, fmtDayShort, parseMoney, methodSegments, calcArqueo, calcMp, ARQUEO_LABEL, receiptText, receiptHtml, MOVE_METHODS, MOVE_IDEAS, movSums, partsText } from '../cash-utils.js';
import { mountPaySplit } from '../pay-split.js';
import { printHtml, shareText, downloadCsv } from '../tools.js';
import { downloadQuickBackup, uploadClosingBackup } from './backups.js';

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
  const calc = () => { const n = nums(); const mv = movSums(rep); return calcArqueo({ opening: n.opening, withdrawals: n.withdrawals, cashIncome: Number(rep.by_method?.Efectivo || 0), movIn: mv.inCash, movOut: mv.outCash, counted: n.counted }); };
  const mpCalc = () => { const mv = movSums(rep); return calcMp({ opening: rep.mp?.opening, gross: rep.mp?.gross, pct: rep.mp?.pct, movIn: mv.inMp, movOut: mv.outMp, counted: nums().countedMp }); };
  const receiptOpts = () => { const n = nums(); const c = rep.closing; return { opening: n.opening, withdrawals: n.withdrawals, counted: n.counted, countedMp: n.countedMp, notes: form.notes, who: c?.closed_by_name || state.profile?.full_name || '', closedAt: c?.closed_at || null }; };

  const principal = state.profile?.role === 'admin_principal';
  // Respaldo del cierre: primero se intenta guardarlo en el servidor desde la app (no necesita Vault); si no se puede, se descarga en este equipo.
  async function saveBackup(btn, auto) {
    const run = async () => {
      try { rep = await uploadClosingBackup(day); ok('Respaldo del cierre guardado en el servidor.'); render(); return; }
      catch (e) { console.warn('Respaldo en el servidor:', e); }
      try { const sz = await downloadQuickBackup(); ok(`El servidor no lo aceptó: el respaldo se guardó en este dispositivo (${(sz / 1048576).toFixed(1).replace('.', ',')} MB).`); }
      catch (e) { fail('No se pudo generar el respaldo: ' + friendly(e)); }
    };
    if (btn) await busy(btn, run); else await run();
  }
  const backupLine = (b) => {
    if (!b || b.status === 'ninguno') return '';
    const bad = b.status === 'failed' || b.status === 'sin_confirmar';
    const map = { ok: ['ok', `Respaldo del cierre guardado${b.size_bytes ? ' (' + (Number(b.size_bytes) / 1048576).toFixed(1).replace('.', ',') + ' MB)' : ''}.`],
      pendiente: ['', 'Generando el respaldo del cierre… actualice en unos segundos.'],
      failed: ['warn', 'El respaldo automático del servidor no está configurado, por eso no se guardó solo.'],
      sin_confirmar: ['warn', 'El servidor no confirmó el respaldo del cierre.'] };
    const m = map[b.status]; if (!m) return '';
    const action = bad ? (principal ? '<div style="margin-top:8px"><button type="button" class="btn sm" id="bkl">Guardar el respaldo ahora</button><small style="display:block;margin-top:6px">Se sube al servidor desde esta pantalla; si no se puede, se descarga en este dispositivo.</small></div>' : '<small style="display:block;margin-top:6px">Avise al administrador principal para que lo guarde.</small>') : '';
    return `<div class="notice small ${m[0]}" role="status">${icon('database')} ${m[1]}${action}</div>`;
  };

  const moveRow = (m) => {
    const inc = m.kind === 'INGRESO';
    return `<div class="cj-mv ${m.voided ? 'void' : ''}"><span class="cj-pi" style="--c:${inc ? '#2f9e6b' : '#c0483a'}">${icon(inc ? 'plus' : 'coins')}</span>
      <div class="grow cj-mv-t"><b>${esc(m.concept)}</b>
        <div class="muted small">${esc(timeOnly(m.at))} · ${esc(partsText(m.parts))}${m.by ? ' · ' + esc(m.by) : ''}</div>
        ${m.note ? `<div class="muted small">${esc(m.note)}</div>` : ''}
        ${m.voided ? `<div class="small" style="color:var(--bad)">Anulado${m.void_reason ? ': ' + esc(m.void_reason) : ''}</div>` : ''}</div>
      <div class="cj-mv-r"><b class="mono ${inc ? 'in' : 'out'}">${inc ? '+' : '−'}${esc(money(m.amount))}</b>${m.voided ? '' : `<button type="button" class="cj-edit" data-void="${esc(m.id)}">Anular</button>`}</div></div>`;
  };

  // Formulario de un ingreso o egreso: de qué es, cuánto y con qué (se puede mezclar efectivo, Mercado Pago y cuenta)
  async function moveForm(kind) {
    const inc = kind === 'INGRESO';
    const saved = await modal(`<h2>${inc ? 'Anotar un ingreso' : 'Anotar un egreso'}</h2><p class="muted small">${esc(fmtDayLong(day))}</p>
      <form id="mf" class="stack" novalidate>
        <label class="field"><span>${inc ? '¿De qué es el ingreso?' : '¿En qué se gastó o para qué salió la plata?'}</span><input name="concept" maxlength="120" placeholder="${inc ? 'Ej.: aporte del dueño' : 'Ej.: flete, proveedor, sueldo'}" autocomplete="off" required></label>
        <div class="cj-chips">${MOVE_IDEAS[kind].map((t) => `<button type="button" class="chip" data-idea="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div><span class="fl">${inc ? 'Cómo entró' : 'Cómo se pagó'}</span><p class="muted small" style="margin:0 0 6px">Puede dividirlo en hasta 3 medios (mitad efectivo, mitad Mercado Pago…).</p><div id="msplit"></div></div>
        <label class="field"><span>Nota (opcional)</span><input name="note" maxlength="300" autocomplete="off"></label>
        <p class="notice bad small hidden" id="me" role="alert"></p>
        <div class="row"><button class="btn grow" type="button" data-close>Cancelar</button><button class="btn ${inc ? 'accent' : 'primary'} grow">${inc ? 'Anotar ingreso' : 'Anotar egreso'}</button></div>
      </form>`, { onMount: (ov, close) => {
        const f = ov.querySelector('#mf'); const err = ov.querySelector('#me');
        const split = mountPaySplit(ov.querySelector('#msplit'), { methods: MOVE_METHODS, total: null, max: 3, onChange: () => err.classList.add('hidden') });
        ov.querySelectorAll('[data-idea]').forEach((b) => b.addEventListener('click', () => { f.concept.value = b.dataset.idea; f.concept.focus(); err.classList.add('hidden'); }));
        f.addEventListener('submit', async (e) => {
          e.preventDefault(); err.classList.add('hidden');
          const concept = f.concept.value.trim();
          const problem = concept.length < 2 ? 'Escriba de qué es el movimiento.' : split.problem();
          if (problem) { err.textContent = problem; err.classList.remove('hidden'); return; }
          await busy(f.querySelector('button:not([type=button])'), async () => {
            try { close(await rpc('cash_movement_add', { p_day: day, p_kind: kind, p_concept: concept, p_parts: split.parts(), p_note: f.note.value.trim() || null })); }
            catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
          });
        });
      } });
    if (saved && typeof saved === 'object') { rep = saved; ok(inc ? 'Ingreso anotado' : 'Egreso anotado'); render(); }
  }
  async function voidMove(id) {
    const m = rep.movements.find((x) => x.id === id); if (!m) return;
    const res = await modal(`<h2>Anular movimiento</h2><p class="muted small">${esc(m.concept)} · ${m.kind === 'INGRESO' ? '+' : '−'}${esc(money(m.amount))} (${esc(partsText(m.parts))})</p>
      <form id="vf" class="stack" novalidate>
        <label class="field"><span>Motivo de la anulación</span><input name="reason" maxlength="200" placeholder="Ej.: se cargó dos veces" autocomplete="off" required></label>
        <p class="muted small">El movimiento no se borra: queda marcado como anulado y deja de sumar en la caja.</p>
        <p class="notice bad small hidden" id="ve" role="alert"></p>
        <div class="row"><button class="btn grow" type="button" data-close>Volver</button><button class="btn danger grow">Anular</button></div>
      </form>`, { onMount: (ov, close) => {
        const f = ov.querySelector('#vf'); const err = ov.querySelector('#ve');
        f.addEventListener('submit', async (e) => {
          e.preventDefault(); err.classList.add('hidden');
          if (f.reason.value.trim().length < 3) { err.textContent = 'Escriba el motivo.'; err.classList.remove('hidden'); return; }
          await busy(f.querySelector('button:not([type=button])'), async () => {
            try { close(await rpc('cash_movement_void', { p_id: id, p_reason: f.reason.value.trim() })); }
            catch (x) { err.textContent = friendly(x); err.classList.remove('hidden'); }
          });
        });
      } });
    if (res && typeof res === 'object') { rep = res; ok('Movimiento anulado'); render(); }
  }

  function render() {
    rep.movements = rep.movements || [];
    const c = rep.closing; const by = rep.by_method || {}; const arq = calc();
    const maxWeek = Math.max(1, ...rep.week.map((w) => Number(w.total)));
    const stale = !!rep.stale; const mv = movSums(rep);
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

      <section class="card stack cj-mov-card"><div class="cj-mov-h"><h3>Movimientos de caja</h3>
        <div class="row"><button type="button" class="btn sm accent" id="mi">${icon('plus')} Ingreso</button><button type="button" class="btn sm" id="mo">− Egreso</button></div></div>
        <p class="muted small">Anote cada entrada o salida de dinero que no sea un cobro a clientes: flete, proveedor, retiro, aporte… con qué se pagó (efectivo, Mercado Pago o cuenta).</p>
        ${mv.count ? `<div class="cj-pills"><span class="cj-pill" style="--c:#2f9e6b"><b>Ingresos</b> ${esc(money(mv.inTotal))}</span><span class="cj-pill" style="--c:#c0483a"><b>Egresos</b> ${esc(money(mv.outTotal))}</span></div>` : ''}
        ${rep.movements.length ? `<div class="cj-list">${[...rep.movements].reverse().map(moveRow).join('')}</div>` : '<div class="empty">No hay movimientos anotados este día.</div>'}
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
        <div class="cj-step"><span class="cj-n">2</span><div class="grow"><b>Otros retiros sin anotar</b><small>Opcional: plata que salió y no cargó arriba como egreso</small></div><input id="wd" inputmode="decimal" placeholder="0" value="${esc(form.withdrawals)}" aria-label="Otros retiros sin anotar"></div>
        <div class="cj-calc" id="cc"></div>
        <div class="cj-step"><span class="cj-n">3</span><div class="grow"><b>Efectivo contado</b><small>Cuente los billetes y monedas de la caja</small></div><input id="ct" inputmode="decimal" placeholder="0" value="${esc(form.counted)}" aria-label="Efectivo contado"></div>
        <div class="cj-verdict" id="vd"></div>
        ${Number(rep.mp?.gross) > 0 || Number(rep.mp?.opening) > 0 || mv.inMp > 0 || mv.outMp > 0 ? `<h4 class="cj-sub">${icon('wallet')} Mercado Pago</h4><div class="cj-calc" id="mc"></div>
        <div class="cj-step"><span class="cj-n mp">MP</span><div class="grow"><b>Saldo real en Mercado Pago</b><small>Opcional: el saldo que ve en la aplicación</small></div><input id="cm" inputmode="decimal" placeholder="0" value="${esc(form.countedMp)}" aria-label="Saldo real en Mercado Pago"></div>
        <div class="cj-verdict" id="mv"></div>` : ''}
        <label class="field"><span>Nota (opcional)</span><textarea id="nt" maxlength="500" placeholder="Ej.: se retiraron $5.000 para pagar flete">${esc(form.notes)}</textarea></label>
        ${backupLine(rep.backup)}
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
    $('#bkl', body)?.addEventListener('click', (e) => saveBackup(e.currentTarget));
    $('#mi', body).addEventListener('click', () => moveForm('INGRESO')); $('#mo', body).addEventListener('click', () => moveForm('EGRESO'));
    $$('[data-void]', body).forEach((b) => b.addEventListener('click', () => voidMove(b.dataset.void)));
    $('#st', body)?.addEventListener('click', openForm); $('#oe2', body)?.addEventListener('click', openForm);
    bindArqueo(); updateCalc(arq);
  }

  function updateCalc(arq = calc()) {
    const n = nums(); const cash = Number(rep.by_method?.Efectivo || 0);
    const mv = movSums(rep);
    $('#cc', body).innerHTML = `<div><span>Fondo inicial</span><b>${esc(money(n.opening))}</b></div><div><span>+ Cobros en efectivo</span><b>${esc(money(cash))}</b></div>
      ${mv.inCash > 0 ? `<div><span>+ Ingresos anotados</span><b>${esc(money(mv.inCash))}</b></div>` : ''}${mv.outCash > 0 ? `<div><span>− Egresos anotados</span><b>${esc(money(mv.outCash))}</b></div>` : ''}
      ${n.withdrawals > 0 ? `<div><span>− Otros retiros sin anotar</span><b>${esc(money(n.withdrawals))}</b></div>` : ''}<div class="tot"><span>= Efectivo que debería haber</span><b>${esc(money(arq.expected))}</b></div>`;
    const v = $('#vd', body); v.dataset.s = arq.state;
    const mc = $('#mc', body);
    if (mc) {
      const mp = mpCalc(); const r = rep.mp;
      mc.innerHTML = `<div><span>Saldo inicial</span><b>${esc(money(r.opening))}</b></div><div><span>+ Cobrado por Mercado Pago</span><b>${esc(money(r.gross))}</b></div>
        <div><span>− Retención (${esc(String(r.pct).replace('.', ','))}%)</span><b>${esc(money(mp.retention))}</b></div>${mv.inMp > 0 ? `<div><span>+ Ingresos anotados</span><b>${esc(money(mv.inMp))}</b></div>` : ''}${mv.outMp > 0 ? `<div><span>− Egresos anotados</span><b>${esc(money(mv.outMp))}</b></div>` : ''}<div class="tot"><span>= Saldo que debería haber</span><b>${esc(money(mp.expected))}</b></div>`;
      const mvd = $('#mv', body); mvd.dataset.s = mp.state;
      mvd.innerHTML = `<span class="cj-vi">${icon(VERDICT_ICON[mp.state])}</span><div><b>${esc(ARQUEO_LABEL[mp.state].replace('La caja', 'Mercado Pago'))}</b>${mp.state === 'pending' ? '<small>Escriba el saldo real de Mercado Pago (opcional).</small>' : mp.difference ? `<small>${esc(money(Math.abs(mp.difference)))} ${mp.difference > 0 ? 'de más' : 'de menos'} respecto de lo esperado</small>` : '<small>El saldo coincide con lo esperado.</small>'}</div>`;
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
      [...rep.payments.map((p) => [timeOnly(p.at), p.order_number ? `Pedido ${p.order_number}` : 'Pago a cuenta', p.customer || '', p.preventista || '', p.method, Number(p.amount), p.by || '']),
       ...rep.movements.filter((m) => !m.voided).flatMap((m) => m.parts.map((x) => [timeOnly(m.at), `${m.kind === 'INGRESO' ? 'Ingreso' : 'Egreso'}: ${m.concept}`, '', '', x.method, (m.kind === 'INGRESO' ? 1 : -1) * Number(x.amount), m.by || '']))]));
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
        if (principal && rep.backup?.status === 'failed') saveBackup(null, true);   // sin respaldo del servidor: se sube desde la app (o se descarga una copia)
        $('#sh', body)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { fail(friendly(e)); }
    });
  }

  await load(day);
}
