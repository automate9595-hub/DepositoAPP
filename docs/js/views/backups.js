import { supabase } from '../supa.js';
import { role } from '../state.js';
import { $, busy, ok, fail, icon } from '../ui.js';
import { esc } from '../format.js';

const GROUPS = [
  { id: 'catalog', label: 'Productos, categorías, costos e inventario', tables: ['categories', 'products', 'product_costs', 'inventory'] },
  { id: 'orders', label: 'Pedidos, detalles e historial de estados', tables: ['orders', 'order_items', 'order_item_costs', 'order_transitions', 'order_status_history'] },
  { id: 'stock', label: 'Reservas y movimientos de stock', tables: ['stock_reservations', 'stock_movements'] },
  { id: 'customers', label: 'Clientes, cuentas corrientes, movimientos y pagos', tables: ['customers', 'customer_movements', 'order_payments'] },
  { id: 'people', label: 'Usuarios del negocio, proveedores, depósito y roles', tables: ['profiles', 'suppliers', 'warehouse_workers', 'roles'] },
  { id: 'system', label: 'Notificaciones y auditoría', tables: ['notifications', 'audit_logs', 'backup_settings', 'backup_runs'] },
];
const PAGE = 1000;
const INTERVALS = [[60,'Cada 1 hora'],[180,'Cada 3 horas'],[360,'Cada 6 horas'],[720,'Cada 12 horas'],[1440,'Cada 24 horas'],[2880,'Cada 2 días'],[4320,'Cada 3 días'],[10080,'Cada 7 días']];
const RETENTIONS = [[7,'7 días'],[15,'15 días'],[30,'30 días'],[60,'60 días'],[90,'90 días'],[0,'No borrar automáticamente']];

async function fetchTable(name) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(name).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`No se pudo respaldar «${name}»: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

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
    progress('Leyendo tablas protegidas de forma segura desde Supabase…');
    const snapshot = await supabase.rpc('backup_selected_snapshot', { p_tables: names });
    if (snapshot.error) throw new Error(`No se pudo leer la base completa: ${snapshot.error.message}`);
    tables = snapshot.data?.database_tables || {};
  }
  const photos = [];
  if (includePhotos) {
    progress('Buscando fotografías de productos…');
    const paths = await listPhotoFiles();
    for (let i = 0; i < paths.length; i++) {
      progress(`Guardando fotografía ${i + 1} de ${paths.length}…`);
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

function downloadJson(data) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `DepositoAPP-respaldo-${stamp}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function backupsView(el) {
  if (role() !== 'admin_principal') {
    el.innerHTML = '<div class="notice">Solo el administrador principal puede generar respaldos completos.</div>';
    return;
  }
  const { data: cfg } = await supabase.from('backup_settings').select('*').eq('id', 1).maybeSingle();
  const { data: runs } = await supabase.from('backup_runs').select('*').order('created_at', { ascending: false }).limit(8);
  el.innerHTML = `<div class="stack">
    <section class="card stack"><h2>Respaldo automático</h2>
      <p class="muted small">El servidor genera el respaldo aunque la aplicación esté cerrada. Requiere instalar 07_respaldos.sql, desplegar la función y configurar 08_programar_respaldos.sql.</p>
      <label class="field"><span>Frecuencia</span><select id="bk-interval">${INTERVALS.map(([v,l])=>`<option value="${v}" ${Number(cfg?.interval_minutes||1440)===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Hora (para frecuencia diaria o por días)</span><input id="bk-time" type="time" value="${esc((cfg?.run_time||'03:00:00').slice(0,5))}"></label>
      <label class="field"><span>Conservar respaldos</span><select id="bk-retention">${RETENTIONS.map(([v,l])=>`<option value="${v}" ${Number(cfg?.retention_days??30)===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Al volver a entrar al dispositivo</span><select id="bk-download"><option value="ask" ${(!cfg?.download_mode||cfg.download_mode==='ask')?'selected':''}>Preguntar si desea descargar</option><option value="auto" ${cfg?.download_mode==='auto'?'selected':''}>Intentar descargar automáticamente</option><option value="off" ${cfg?.download_mode==='off'?'selected':''}>No descargar automáticamente</option></select></label>
      <button class="btn primary block" id="bk-save">Guardar configuración</button>
      <div class="notice small">Último respaldo: ${runs?.[0]?.created_at ? esc(new Date(runs[0].created_at).toLocaleString())+' · '+esc(runs[0].status) : 'Todavía no hay ejecuciones registradas.'}</div>
      ${(runs||[]).map(r=>`<div class="line small"><span>${esc(new Date(r.created_at).toLocaleString())}</span><b>${r.status==='ok'?'Correcto':'Fallido'}</b>${r.error_message?`<div class="muted">${esc(r.error_message)}</div>`:''}</div>`).join('')}
    </section>
    <section class="card stack"><div><h2>Respaldo manual de datos</h2><p class="muted small">Elegí un respaldo completo o seleccioná solamente las partes que necesitás. El archivo se descarga en este dispositivo.</p></div>
      <label class="check"><input id="all" type="checkbox" checked> Respaldo completo (todo lo disponible)</label>
      <div id="groups" class="stack">${GROUPS.map((g) => `<label class="check"><input type="checkbox" data-group="${g.id}" checked> ${esc(g.label)}</label>`).join('')}</div>
      <div class="divider"></div>
      <label class="check"><input id="photos" type="checkbox" checked> Fotografías originales de los productos</label>
      <p class="muted small">Las fotografías se guardan dentro del mismo archivo. Si hay muchas, el respaldo puede ser pesado y tardar más.</p>
      <p class="notice">Las contraseñas y credenciales de acceso no se pueden exportar desde la base de datos. Se incluyen las cuentas y permisos del negocio, pero no las claves de Supabase Auth.</p>
      <div id="progress" class="muted small" aria-live="polite"></div>
      <button class="btn primary block" id="make">${icon('download')} Generar y descargar respaldo</button>
    </section>
    <section class="card stack"><h3>Qué contiene el respaldo</h3><p class="muted small">Conserva los identificadores y las relaciones de los registros seleccionados. El archivo JSON es una copia de seguridad exportable; esta pantalla todavía no restaura datos automáticamente.</p></section>
  </div>`;
  $('#bk-save', el)?.addEventListener('click', async (e) => {
    await busy(e.currentTarget, async () => {
      const payload = { interval_minutes: Number($('#bk-interval',el).value), run_time: $('#bk-time',el).value || null,
        retention_days: Number($('#bk-retention',el).value), download_mode: $('#bk-download',el).value,
        next_run_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const { error } = await supabase.from('backup_settings').update(payload).eq('id',1);
      if (error) { fail(`No se pudo guardar la configuración: ${error.message}`); return; }
      ok('Configuración de respaldos guardada. El programador la tomará en su próxima revisión.');
    });
  });
  const all = $('#all', el); const boxes = [...el.querySelectorAll('[data-group]')]; const photos = $('#photos', el);
  const syncAll = () => { const on = boxes.every((b) => b.checked) && photos.checked; all.checked = on; all.indeterminate = !on && (boxes.some((b) => b.checked) || photos.checked); };
  all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); photos.checked = all.checked; all.indeterminate = false; });
  [...boxes, photos].forEach((b) => b.addEventListener('change', syncAll));
  $('#make', el).addEventListener('click', async (e) => {
    const selected = boxes.filter((b) => b.checked).map((b) => b.dataset.group);
    if (!selected.length && !photos.checked) { fail('Seleccioná al menos una parte para respaldar.'); return; }
    const progress = $('#progress', el);
    await busy(e.currentTarget, async () => {
      e.currentTarget.disabled = true;
      try {
        const data = await buildBackup(selected, photos.checked, (m) => { progress.textContent = m; });
        progress.textContent = 'Preparando archivo…';
        downloadJson(data);
        const total = Object.values(data.tables).reduce((n, rows) => n + rows.length, 0);
        progress.textContent = `Respaldo listo: ${total} registros y ${data.storage.files.length} fotografías.`;
        ok('Respaldo generado. Verificá que el archivo se haya descargado.');
      } catch (err) { progress.textContent = ''; fail(err.message || 'No se pudo generar el respaldo.'); }
      finally { e.currentTarget.disabled = false; }
    });
  });
}
