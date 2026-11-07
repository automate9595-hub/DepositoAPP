import { supabase, config } from '../supa.js';
import { role } from '../state.js';
import { friendly } from '../api.js';
import { $, $$, busy, ok, fail, icon, modal, confirmBox } from '../ui.js';
import { esc, dateTime } from '../format.js';
import { GROUPS, parseBackup, summarize, fmtBytes, base64ToBytes, TABLE_LABELS } from '../backup-utils.js';

const PAGE = 1000;
const INTERVALS = [[60,'Cada 1 hora'],[180,'Cada 3 horas'],[360,'Cada 6 horas'],[720,'Cada 12 horas'],[1440,'Cada 24 horas'],[2880,'Cada 2 días'],[4320,'Cada 3 días'],[10080,'Cada 7 días']];
const RETENTIONS = [[7,'7 días'],[15,'15 días'],[30,'30 días'],[60,'60 días'],[90,'90 días'],[0,'No borrar automáticamente']];

// ---------- Lectura de datos ----------
function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer una fotografía del almacenamiento.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

async function listPhotoFiles(path = '') {
  const found = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from('product-photos').list(path, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`No se pudieron listar las fotografías: ${error.message}`);
    for (const item of data || []) {
      const full = path ? `${path}/${item.name}` : item.name;
      if (item.id === null) found.push(...await listPhotoFiles(full));
      else if (item.name !== '.emptyFolderPlaceholder') found.push(full);
    }
    if (!data || data.length < PAGE) break;
  }
  return found;
}

async function buildBackup(selected, includePhotos, progress) {
  const names = GROUPS.filter((g) => selected.includes(g.id)).flatMap((g) => g.tables);
  let tables = {};
  if (names.length) {
    progress('Leyendo los datos de forma segura desde Supabase…', null);
    const snapshot = await supabase.rpc('backup_selected_snapshot', { p_tables: names });
    if (snapshot.error) throw new Error(`No se pudo leer la base completa: ${snapshot.error.message}`);
    tables = snapshot.data?.database_tables || {};
  }
  const photos = [];
  if (includePhotos) {
    progress('Buscando fotografías de productos…', null);
    const paths = await listPhotoFiles();
    for (let i = 0; i < paths.length; i++) {
      progress(`Guardando fotografía ${i + 1} de ${paths.length}…`, 0.15 + 0.8 * (i / paths.length));
      const { data, error } = await supabase.storage.from('product-photos').download(paths[i]);
      if (error) throw new Error(`No se pudo descargar la fotografía ${paths[i]}: ${error.message}`);
      photos.push({ path: paths[i], content_type: data.type || 'image/jpeg', base64: await fileToBase64(data) });
    }
  }
  return {
    format: 'depositoapp-backup', format_version: 2,
    created_at: new Date().toISOString(),
    app: 'DepositoAPP',
    selection: { groups: selected, product_photos: includePhotos },
    tables, storage: { bucket: 'product-photos', files: photos },
    limitations: ['No incluye contraseñas ni identidades de Supabase Auth. Los usuarios y sus perfiles sí están incluidos.'],
  };
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function downloadJson(data, prefix = 'DepositoAPP-respaldo') {
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  saveBlob(blob, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  return blob.size;
}

// La restauración puede enviar varios MB: se usa una petición propia con tiempo límite largo
// (el cliente común corta a los 20 segundos).
async function longRpc(name, args, ms = 10 * 60 * 1000) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw Object.assign(new Error('La sesión venció. Volvé a iniciar sesión e intentá de nuevo.'), { display: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let res;
  try {
    res = await fetch(`${String(config.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(args),
    });
  } catch {
    throw Object.assign(new Error('Se perdió la conexión mientras se restauraba. Es posible que la operación se haya completado: revisá los datos o repetí la importación con «Agregar lo que falta».'), { display: true });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
  if (!res.ok) throw { message: body?.message || text.slice(0, 200) || `Error ${res.status}`, code: body?.code };
  return body;
}

// ---------- Pequeñas ayudas de interfaz ----------
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return dateTime(iso);
  if (s < 90) return 'hace instantes';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 14) return `hace ${Math.round(s / 86400)} días`;
  return dateTime(iso);
};
const label = (list, v) => (list.find(([k]) => k === v) || [])[1] || '—';

function setProgress(root, pct, msg) {
  root.classList.remove('hidden');
  const bar = $('.bk-bar', root);
  bar.classList.toggle('ind', pct == null);
  $('i', bar).style.width = pct == null ? '' : `${Math.max(4, Math.min(100, Math.round(pct * 100)))}%`;
  $('.bk-prog-msg', root).textContent = msg;
}

function typedConfirm(title, message, word) {
  return modal(`<h2>${esc(title)}</h2><p class="muted">${esc(message)}</p>
    <label class="field" style="margin-top:12px"><span>Para continuar, escribí <b>${esc(word)}</b></span><input data-t autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
    <div class="row" style="margin-top:16px"><button class="btn grow" data-close>Volver</button><button class="btn danger grow" data-ok disabled>Restaurar</button></div>`,
  { onMount: (ov, close) => {
    const input = ov.querySelector('[data-t]'); const go = ov.querySelector('[data-ok]');
    input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== word; });
    go.addEventListener('click', () => close(true));
  } }).then((v) => v === true);
}

// ---------- Pantalla ----------
export async function backupsView(el) {
  if (role() !== 'admin_principal') {
    el.innerHTML = '<div class="notice">Solo el administrador principal puede generar o restaurar respaldos.</div>';
    return;
  }
  const [{ data: cfg }, { data: runs }] = await Promise.all([
    supabase.from('backup_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('backup_runs').select('*').order('created_at', { ascending: false }).limit(10),
  ]);
  const lastOk = (runs || []).find((r) => r.status === 'ok');
  const sel = { groups: new Set(GROUPS.map((g) => g.id)), photos: true };
  let loaded = null; // { parsed, name, size }

  el.innerHTML = `<div class="bk">
    <section class="bk-hero">
      <div class="bk-hero-ico">${icon('shield')}</div>
      <div class="grow"><h2>Respaldos y restauración</h2><p>Guardá una copia completa de tus datos. Si algún día se pierde algo, volvé a cargarla desde acá.</p></div>
    </section>
    <div class="bk-stats">
      <div class="bk-stat"><small>Último automático</small><b>${lastOk ? esc(ago(lastOk.created_at)) : 'Sin ejecuciones'}</b></div>
      <div class="bk-stat"><small>Frecuencia</small><b>${esc(label(INTERVALS, Number(cfg?.interval_minutes || 1440)))}</b></div>
      <div class="bk-stat"><small>Se conservan</small><b>${esc(label(RETENTIONS, Number(cfg?.retention_days ?? 30)))}</b></div>
    </div>
    <div class="seg" role="tablist" aria-label="Secciones de respaldos">
      <button type="button" class="seg-btn" role="tab" data-tab="export">${icon('download')}<span>Exportar</span></button>
      <button type="button" class="seg-btn" role="tab" data-tab="import">${icon('upload')}<span>Importar</span></button>
      <button type="button" class="seg-btn" role="tab" data-tab="auto">${icon('clock')}<span>Automático</span></button>
    </div>
    <div id="bk-pane"></div>
  </div>`;
  const pane = $('#bk-pane', el);

  const show = (name) => {
    $$('.seg-btn', el).forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    pane.innerHTML = ''; pane.classList.remove('pane-in'); void pane.offsetWidth; pane.classList.add('pane-in');
    ({ export: paneExport, import: paneImport, auto: paneAuto })[name]();
  };
  $$('.seg-btn', el).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  // ===== EXPORTAR =====
  function paneExport() {
    pane.innerHTML = `<section class="bk-card">
      <div class="bk-card-h"><span class="bk-step">${icon('database')}</span><div><h3>Qué querés guardar</h3><p class="muted small">El archivo se descarga en este dispositivo. Guardalo también en Drive, en un pendrive o enviátelo por correo.</p></div></div>
      <label class="bk-master"><input id="all" type="checkbox"><span>Respaldo completo</span><small class="muted">todo lo disponible</small></label>
      <div class="bk-tiles">${GROUPS.map((g) => `<label class="bk-tile"><input type="checkbox" data-group="${g.id}" ${sel.groups.has(g.id) ? 'checked' : ''}>
        <span class="bk-tile-ico">${icon(g.icon)}</span><span class="grow"><b>${esc(g.label)}</b></span><span class="bk-check">${icon('check')}</span></label>`).join('')}
        <label class="bk-tile"><input id="photos" type="checkbox" ${sel.photos ? 'checked' : ''}><span class="bk-tile-ico">${icon('image')}</span>
        <span class="grow"><b>Fotografías originales de los productos</b><small>Van dentro del mismo archivo; con muchas fotos pesa más y tarda más.</small></span><span class="bk-check">${icon('check')}</span></label>
      </div>
      <p class="notice small">Las contraseñas no se pueden exportar: viven en Supabase Auth. Sí se guardan las cuentas, los roles y los permisos del negocio.</p>
      <div class="bk-prog hidden" aria-live="polite"><div class="bk-bar"><i></i></div><p class="bk-prog-msg small muted"></p></div>
      <button class="btn primary block" id="make">${icon('download')} Generar y descargar respaldo</button>
      <div id="bk-out"></div>
    </section>`;
    const all = $('#all', pane); const boxes = $$('[data-group]', pane); const photos = $('#photos', pane);
    const sync = () => {
      sel.groups = new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.group)); sel.photos = photos.checked;
      const on = sel.groups.size === GROUPS.length && sel.photos;
      all.checked = on; all.indeterminate = !on && (sel.groups.size > 0 || sel.photos);
    };
    sync();
    all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); photos.checked = all.checked; all.indeterminate = false; sync(); });
    [...boxes, photos].forEach((b) => b.addEventListener('change', sync));
    $('#make', pane).addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const selected = [...sel.groups];
      if (!selected.length && !sel.photos) { fail('Seleccioná al menos una parte para respaldar.'); return; }
      const prog = $('.bk-prog', pane); const out = $('#bk-out', pane);
      busy(btn, async () => {
        out.innerHTML = '';
        try {
          setProgress(prog, null, 'Preparando…');
          const data = await buildBackup(selected, sel.photos, (m, f) => setProgress(prog, f, m));
          setProgress(prog, 0.97, 'Preparando el archivo…');
          const bytes = downloadJson(data);
          const total = Object.values(data.tables).reduce((n, rows) => n + rows.length, 0);
          prog.classList.add('hidden');
          out.innerHTML = `<div class="bk-result ok"><span class="bk-result-ico">${icon('check')}</span><div class="grow"><b>Respaldo generado</b>
            <p class="small">${total.toLocaleString()} registros · ${data.storage.files.length} fotografías · ${esc(fmtBytes(bytes))}</p>
            <p class="small muted">Verificá que el archivo se haya descargado y guardalo en un lugar seguro. Para volver a cargarlo, usá la pestaña «Importar».</p></div></div>`;
          ok('Respaldo generado.');
        } catch (err) { prog.classList.add('hidden'); fail(err.message || 'No se pudo generar el respaldo.'); }
      });
    });
  }

  // ===== IMPORTAR =====
  function paneImport() {
    pane.innerHTML = `<section class="bk-card">
      <div class="bk-card-h"><span class="bk-step">1</span><div><h3>Elegí el archivo de respaldo</h3><p class="muted small">Sirve tanto el respaldo que descargás desde «Exportar» como los automáticos.</p></div></div>
      <label class="bk-drop" id="bk-drop" for="bk-file">${icon('upload')}<b>Tocá para elegir el archivo</b><small>Archivo .json de DepositoAPP · o arrastralo hasta acá</small></label>
      <input id="bk-file" class="sr" type="file" accept=".json,application/json">
      <div id="bk-loaded"></div>
    </section>
    <section class="bk-card hidden" id="bk-opts">
      <div class="bk-card-h"><span class="bk-step">2</span><div><h3>Cómo querés restaurar</h3></div></div>
      <div class="bk-modes">
        <label class="bk-mode"><input type="radio" name="bk-mode" value="merge" checked><span class="bk-radio"></span><span class="grow"><b>Agregar lo que falta</b><small>Suma los registros que no existan. No modifica ni borra nada de lo actual. Es la opción segura.</small></span></label>
        <label class="bk-mode"><input type="radio" name="bk-mode" value="replace"><span class="bk-radio"></span><span class="grow"><b>Restaurar todo <em class="bk-tag">reemplaza</em></b><small>Borra los datos actuales de lo que trae el respaldo y los reemplaza por los del archivo. Ideal si la base se perdió o se dañó.</small></span></label>
      </div>
      <label class="check"><input id="bk-safe" type="checkbox" checked> Descargar antes una copia de seguridad de los datos actuales</label>
      <label class="check" id="bk-photo-row"><input id="bk-photos" type="checkbox" checked> <span id="bk-photo-label">Restaurar también las fotografías</span></label>
      <p class="notice small">Las contraseñas no están en el respaldo. Cada usuario se vincula con su cuenta de Supabase por correo: si falta alguna cuenta de preventista o de depósito, creala primero en Administración › Usuarios y volvé a importar.</p>
      <div class="bk-prog hidden" aria-live="polite"><div class="bk-bar"><i></i></div><p class="bk-prog-msg small muted"></p></div>
      <button class="btn primary block" id="bk-run">${icon('refresh')} Restaurar respaldo</button>
      <div id="bk-report"></div>
    </section>`;
    const drop = $('#bk-drop', pane); const input = $('#bk-file', pane);
    input.addEventListener('change', () => { if (input.files?.[0]) handleFile(input.files[0]); });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); });
    $('#bk-run', pane).addEventListener('click', (e) => runRestore(e.currentTarget));
    if (loaded) renderLoaded();
  }

  async function handleFile(file) {
    const box = $('#bk-loaded', pane);
    box.innerHTML = '<p class="muted small">Leyendo el archivo…</p>';
    let text;
    try { text = await file.text(); } catch { box.innerHTML = ''; fail('No se pudo leer el archivo seleccionado.'); return; }
    const parsed = parseBackup(text);
    if (!parsed.ok) { loaded = null; $('#bk-opts', pane).classList.add('hidden'); box.innerHTML = `<div class="notice bad">${esc(parsed.error)}</div>`; return; }
    loaded = { parsed, name: file.name, size: file.size };
    renderLoaded();
  }

  function renderLoaded() {
    const { parsed, name, size } = loaded;
    const groups = summarize(parsed.tables);
    $('#bk-loaded', pane).innerHTML = `<div class="bk-file">
        <span class="bk-file-ico">${icon('file')}</span>
        <div class="grow"><b class="ellipsis">${esc(name)}</b><small class="muted">${esc(fmtBytes(size))} · ${parsed.meta.createdAt ? 'creado ' + esc(dateTime(parsed.meta.createdAt)) : 'fecha desconocida'} · ${parsed.meta.kind === 'automatic' ? 'automático' : 'manual'}</small></div>
        <button type="button" class="bk-x" id="bk-clear" aria-label="Quitar archivo">${icon('x')}</button>
      </div>
      <div class="bk-sum">${groups.map((g) => `<div class="bk-sum-row"><span class="bk-mini">${icon(g.icon)}</span><span class="grow">${esc(g.label)}</span><b>${g.rows.toLocaleString()}</b></div>`).join('')}
        ${parsed.photos.length ? `<div class="bk-sum-row"><span class="bk-mini">${icon('image')}</span><span class="grow">Fotografías de productos</span><b>${parsed.photos.length.toLocaleString()}</b></div>` : ''}</div>
      ${parsed.ignored.length ? `<p class="notice small">Se ignorarán datos que esta versión no reconoce: ${esc(parsed.ignored.join(', '))}.</p>` : ''}`;
    $('#bk-clear', pane).addEventListener('click', () => { loaded = null; $('#bk-loaded', pane).innerHTML = ''; $('#bk-opts', pane).classList.add('hidden'); const f = $('#bk-file', pane); if (f) f.value = ''; });
    $('#bk-opts', pane).classList.remove('hidden');
    $('#bk-report', pane).innerHTML = '';
    const hasPhotos = parsed.photos.length > 0;
    $('#bk-photo-row', pane).classList.toggle('hidden', !hasPhotos);
    if (hasPhotos) $('#bk-photo-label', pane).textContent = `Restaurar también las ${parsed.photos.length.toLocaleString()} fotografías`;
  }

  async function runRestore(btn) {
    if (!loaded) { fail('Primero elegí un archivo de respaldo.'); return; }
    const { parsed } = loaded;
    const mode = $('input[name="bk-mode"]:checked', pane).value;
    const safe = $('#bk-safe', pane).checked;
    const withPhotos = parsed.photos.length > 0 && $('#bk-photos', pane).checked;
    const prog = $('#bk-opts .bk-prog', pane); const report = $('#bk-report', pane);
    const proceed = mode === 'replace'
      ? await typedConfirm('Restaurar y reemplazar datos', `Se reemplazarán los datos actuales por los del respaldo (${parsed.totalRows.toLocaleString()} registros). Esta acción no se puede deshacer${safe ? ', pero antes se descargará una copia de lo actual' : ''}.`, 'RESTAURAR')
      : await confirmBox('Agregar lo que falta', `Se agregarán los registros del respaldo que todavía no existan (${parsed.totalRows.toLocaleString()} en el archivo). Lo que ya existe no se modifica.`, { okText: 'Restaurar' });
    if (!proceed) return;

    await busy(btn, async () => {
      report.innerHTML = '';
      try {
        if (safe) {
          setProgress(prog, null, 'Guardando una copia de seguridad de los datos actuales…');
          try {
            const cur = await buildBackup(GROUPS.map((g) => g.id), false, (m) => setProgress(prog, null, m));
            downloadJson(cur, 'DepositoAPP-antes-de-restaurar');
          } catch (err) {
            const go = await confirmBox('No se pudo guardar la copia de seguridad', `${err.message || 'Error desconocido'}. ¿Querés continuar de todos modos sin esa copia?`, { okText: 'Continuar', danger: true });
            if (!go) { prog.classList.add('hidden'); return; }
          }
        }
        setProgress(prog, null, 'Restaurando los datos… no cierres esta pantalla.');
        const base = `${String(config.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1/object/public/product-photos/`;
        const res = await longRpc('restore_backup', { p_tables: parsed.tables, p_mode: mode, p_dry_run: false, p_photo_base: base });

        const photoStat = { done: 0, failed: 0 };
        if (withPhotos) {
          for (let i = 0; i < parsed.photos.length; i++) {
            const ph = parsed.photos[i];
            setProgress(prog, 0.1 + 0.88 * (i / parsed.photos.length), `Restaurando fotografía ${i + 1} de ${parsed.photos.length}…`);
            try {
              const blob = new Blob([base64ToBytes(ph.base64)], { type: ph.content_type });
              const up = await supabase.storage.from('product-photos').upload(ph.path, blob, { contentType: ph.content_type, upsert: true, cacheControl: '31536000' });
              if (up.error) photoStat.failed++; else photoStat.done++;
            } catch { photoStat.failed++; }
          }
        }
        prog.classList.add('hidden');
        renderReport(report, res, photoStat, withPhotos);
        ok('Restauración completada.');
      } catch (err) {
        prog.classList.add('hidden');
        const msg = err?.display ? err.message : friendly(err);
        report.innerHTML = `<div class="bk-result bad"><span class="bk-result-ico">${icon('alert')}</span><div class="grow"><b>No se restauró</b><p class="small">${esc(msg)}</p></div></div>`;
        fail(msg);
      }
    });
  }

  function renderReport(root, res, photoStat, withPhotos) {
    const ins = res.inserted || {}; const skip = res.skipped || {};
    const rows = Object.entries(ins).filter(([, n]) => n > 0);
    const skippedTotal = Object.values(skip).reduce((n, v) => n + v, 0);
    const missing = res.missing_users || [];
    root.innerHTML = `<div class="bk-result ok"><span class="bk-result-ico">${icon('check')}</span><div class="grow"><b>Restauración completada</b>
        <p class="small muted">${res.mode === 'replace' ? 'Se reemplazaron los datos por los del respaldo.' : 'Se agregaron los registros que faltaban.'}${skippedTotal ? ` ${skippedTotal.toLocaleString()} registros ya existían y no se modificaron.` : ''}</p></div></div>
      ${rows.length ? `<div class="bk-sum">${rows.map(([t, n]) => `<div class="bk-sum-row"><span class="grow">${esc(TABLE_LABELS[t] || t)}</span><b>${Number(n).toLocaleString()}</b></div>`).join('')}</div>` : ''}
      ${withPhotos ? `<p class="small ${photoStat.failed ? 'notice' : 'muted'}">Fotografías restauradas: ${photoStat.done}${photoStat.failed ? ` · ${photoStat.failed} no se pudieron subir (podés repetir la importación)` : ''}.</p>` : ''}
      ${(res.warnings || []).map((w) => `<p class="notice small">${esc(w)}</p>`).join('')}
      ${missing.length ? `<p class="notice small">Estos usuarios no tienen cuenta en Supabase y se omitieron: ${esc(missing.map((u) => u.email || u.name || 'sin correo').join(', '))}. Creá sus cuentas en Administración › Usuarios y volvé a importar con «Agregar lo que falta» para completar sus datos.</p>` : ''}
      <button class="btn accent block" id="bk-reload">${icon('refresh')} Recargar la aplicación</button>`;
    $('#bk-reload', root).addEventListener('click', () => location.reload());
  }

  // ===== AUTOMÁTICO =====
  function paneAuto() {
    pane.innerHTML = `<section class="bk-card">
      <div class="bk-card-h"><span class="bk-step">${icon('clock')}</span><div><h3>Respaldo automático</h3><p class="muted small">El servidor lo genera aunque la aplicación esté cerrada. Requiere haber instalado 07_respaldos.sql y 08_programar_respaldos.sql, y desplegado la función.</p></div></div>
      <div class="bk-grid">
        <label class="field"><span>Frecuencia</span><select id="bk-interval">${INTERVALS.map(([v, l]) => `<option value="${v}" ${Number(cfg?.interval_minutes || 1440) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Hora (frecuencia diaria o por días)</span><input id="bk-time" type="time" value="${esc((cfg?.run_time || '03:00:00').slice(0, 5))}"></label>
        <label class="field"><span>Conservar respaldos</span><select id="bk-retention">${RETENTIONS.map(([v, l]) => `<option value="${v}" ${Number(cfg?.retention_days ?? 30) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Al volver a entrar al dispositivo</span><select id="bk-download"><option value="ask" ${(!cfg?.download_mode || cfg.download_mode === 'ask') ? 'selected' : ''}>Preguntar si desea descargar</option><option value="auto" ${cfg?.download_mode === 'auto' ? 'selected' : ''}>Intentar descargar automáticamente</option><option value="off" ${cfg?.download_mode === 'off' ? 'selected' : ''}>No descargar automáticamente</option></select></label>
      </div>
      <button class="btn primary block" id="bk-save">Guardar configuración</button>
      ${cfg?.next_run_at ? `<p class="small muted">Próxima ejecución prevista: ${esc(dateTime(cfg.next_run_at))}</p>` : ''}
    </section>
    <section class="bk-card">
      <div class="bk-card-h"><span class="bk-step">${icon('database')}</span><div><h3>Respaldos guardados en el servidor</h3><p class="muted small">Podés descargarlos o restaurar cualquiera de ellos.</p></div></div>
      ${(runs || []).length ? (runs || []).map((r, i) => `<div class="bk-run">
        <span class="status ${r.status === 'ok' ? 's-ok' : 's-bad'}">${r.status === 'ok' ? 'Correcto' : 'Fallido'}</span>
        <div class="grow"><b class="small">${esc(dateTime(r.created_at))}</b>
          <div class="muted small">${r.size_bytes ? esc(fmtBytes(r.size_bytes)) : ''}${r.error_message ? esc(r.error_message) : ''}</div></div>
        ${r.status === 'ok' && r.storage_path ? `<button class="btn sm" data-dl="${i}" title="Descargar">${icon('download')}</button><button class="btn sm primary" data-rs="${i}" title="Restaurar este respaldo">${icon('refresh')}</button>` : ''}
      </div>`).join('') : '<div class="empty">Todavía no hay ejecuciones registradas.</div>'}
    </section>`;
    $('#bk-save', pane)?.addEventListener('click', async (e) => {
      await busy(e.currentTarget, async () => {
        const payload = { interval_minutes: Number($('#bk-interval', pane).value), run_time: $('#bk-time', pane).value || null,
          retention_days: Number($('#bk-retention', pane).value), download_mode: $('#bk-download', pane).value,
          next_run_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        const { error } = await supabase.from('backup_settings').update(payload).eq('id', 1);
        if (error) { fail(`No se pudo guardar la configuración: ${error.message}`); return; }
        ok('Configuración guardada. El programador la tomará en su próxima revisión.');
      });
    });
    const fetchRun = async (i) => {
      const run = runs[i];
      const { data, error } = await supabase.storage.from('database-backups').download(run.storage_path);
      if (error) throw new Error(`No se pudo descargar el respaldo: ${error.message}`);
      return { run, blob: data };
    };
    $$('[data-dl]', pane).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      try { const { run, blob } = await fetchRun(Number(b.dataset.dl)); saveBlob(blob, run.storage_path.split('/').pop() || 'respaldo.json'); }
      catch (err) { fail(err.message); }
    })));
    $$('[data-rs]', pane).forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      try {
        const { run, blob } = await fetchRun(Number(b.dataset.rs));
        const parsed = parseBackup(await blob.text());
        if (!parsed.ok) { fail(parsed.error); return; }
        loaded = { parsed, name: run.storage_path.split('/').pop() || 'respaldo.json', size: blob.size };
        show('import');
        ok('Respaldo cargado. Elegí cómo restaurarlo.');
      } catch (err) { fail(err.message); }
    })));
  }

  show('export');
}
