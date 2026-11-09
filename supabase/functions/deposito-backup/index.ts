// Supabase Edge Function: respaldo de la base de datos (programado y al cerrar la caja).
// Deploy with: supabase functions deploy deposito-backup
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets.
//
// Dos formas de invocarla (siempre firmada con la service_role, nunca desde el navegador):
//   · Programada (pg_cron, ver 08_programar_respaldos.sql): cuerpo vacío. Respeta el intervalo configurado.
//   · Al cerrar la caja (la dispara cash_close desde la base): {"reason":"cierre_caja","day":"YYYY-MM-DD"}.
//     Siempre respalda (ignora el intervalo) y no mueve la próxima ejecución programada.
// El archivo se guarda comprimido (.json.gz): ocupa ~6 veces menos y entra en el límite de 50 MB por archivo de Storage.
const cors = { 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const intervalChoices = [60, 180, 360, 720, 1440, 2880, 4320, 10080];
// Tope de seguridad: la función tiene ~256 MB de memoria. Por encima de esto se informa con claridad en vez de caerse sin avisar.
const MAX_JSON_BYTES = 150 * 1024 * 1024;
const MAX_STORAGE_BYTES = 50 * 1024 * 1024;

// Comparación en tiempo constante (evita deducir la clave midiendo el tiempo de respuesta).
const safeEqual = (a: string, b: string) => {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
};

const gzip = async (text: string): Promise<Uint8Array> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'Missing server secrets' }, 500);
  // La función solo acepta invocaciones internas firmadas con la service_role.
  // No publicar ni colocar esta clave en el frontend.
  const supplied = req.headers.get('authorization') || '';
  if (!safeEqual(supplied, `Bearer ${key}`)) return json({ error: 'Unauthorized' }, 401);

  // Motivo de la invocación (solo se aceptan valores con forma válida)
  let reason = 'programado'; let closingDay: string | null = null;
  try {
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    if (body?.reason === 'cierre_caja' && typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day)) { reason = 'cierre_caja'; closingDay = body.day; }
  } catch { /* cuerpo vacío o inválido: se trata como programada */ }
  const isClosing = reason === 'cierre_caja';

  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const rest = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const body = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${body.slice(0, 500)}`);
    return body ? JSON.parse(body) : null;
  };
  const storage = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${url}/storage/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const body = await r.text();
    if (!r.ok) throw new Error(`Storage ${r.status}: ${body.slice(0, 500)}`);
    return body ? JSON.parse(body) : null;
  };
  const nextTime = (now: Date, minutes: number, runTime: string | null) => {
    if (minutes >= 1440 && runTime) {
      const [hh, mm] = runTime.slice(0, 5).split(':').map(Number);
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      const localDate = `${p.year}-${p.month}-${p.day}`;
      const candidate = new Date(`${localDate}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00-03:00`);
      if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + Math.round(minutes / 1440));
      return candidate.toISOString();
    }
    return new Date(now.getTime() + minutes * 60000).toISOString();
  };
  const runMeta = { triggered_by: isClosing ? 'cierre_caja' : 'scheduler', reason, closing_day: closingDay };

  let settings: any;
  try {
    const rows = await rest('backup_settings?id=eq.1&select=*');
    settings = rows?.[0];
    if (!settings) return json({ skipped: true, reason: 'backup settings not installed' });
    if (!intervalChoices.includes(settings.interval_minutes)) return json({ error: 'Invalid backup interval' }, 400);
    const now = new Date();
    let next_run_at: string | null = settings.next_run_at;
    if (!isClosing) {
      if (settings.next_run_at && new Date(settings.next_run_at).getTime() > now.getTime()) return json({ skipped: true, next_run_at: settings.next_run_at });
      // Advance schedule first to prevent overlapping invocations from duplicating the same backup.
      next_run_at = nextTime(now, settings.interval_minutes, settings.run_time);
      await rest('backup_settings?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ next_run_at, updated_at: now.toISOString() }) });
    }

    const snapRes = await fetch(`${url}/rest/v1/rpc/backup_snapshot`, { method: 'POST', headers, body: '{}' });
    const snapText = await snapRes.text();
    if (!snapRes.ok) throw new Error(`Snapshot ${snapRes.status}: ${snapText.slice(0, 500)}`);
    if (snapText.length > MAX_JSON_BYTES) {
      throw new Error(`La base de datos ya es demasiado grande para respaldarla desde esta función (${Math.round(snapText.length / 1048576)} MB de datos, máximo ${MAX_JSON_BYTES / 1048576} MB). Use los respaldos diarios de Supabase (Database > Backups) o pg_dump, y archive pedidos antiguos.`);
    }
    // Incluir todas las fotografías originales del bucket product-photos.
    const photoFiles: Array<{path:string;content_type:string;base64:string}> = [];
    const walkPhotos = async (prefix = ''): Promise<void> => {
      let offset = 0;
      for (;;) {
        const listed = await storage('object/list/product-photos', { method: 'POST', body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }) });
        if (!Array.isArray(listed) || listed.length === 0) break;
        for (const item of listed) {
          const path = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.id == null) { await walkPhotos(path); continue; }
          if (item.name === '.emptyFolderPlaceholder') continue;
          const r = await fetch(`${url}/storage/v1/object/product-photos/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
          if (!r.ok) throw new Error(`No se pudo respaldar fotografía ${path}: ${r.status}`);
          const buf = new Uint8Array(await r.arrayBuffer());
          let binary = ''; for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          photoFiles.push({ path, content_type: r.headers.get('content-type') || 'image/jpeg', base64: btoa(binary) });
        }
        if (listed.length < 100) break;
        offset += listed.length;
      }
    };
    await walkPhotos();
    // Se arma el archivo SIN volver a parsear el JSON de la base (ahorra memoria): se inserta "storage" antes de "notes".
    const cut = snapText.lastIndexOf(',"notes":');
    if (cut < 0) throw new Error('Formato de respaldo inesperado');
    const notes = snapText.slice(cut).replace('"storage_product_photos_included":false', '"storage_product_photos_included":true');
    const fullText = snapText.slice(0, cut) + ',"storage":' + JSON.stringify({ bucket: 'product-photos', files: photoFiles }) + notes;
    const bytes = await gzip(fullText);
    if (bytes.length > MAX_STORAGE_BYTES) {
      throw new Error(`El respaldo comprimido pesa ${Math.round(bytes.length / 1048576)} MB y supera el máximo de 50 MB por archivo de Storage (las fotografías son lo que más pesa). Reduzca el tamaño de las fotos o use los respaldos diarios de Supabase.`);
    }
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const tag = isClosing ? `cierre-${closingDay}-` : '';
    const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}/deposito-${tag}${stamp}.json.gz`;
    await storage(`object/database-backups/${path}`, { method: 'POST', headers: { 'content-type': 'application/gzip', 'x-upsert': 'false' }, body: bytes });
    await rest('backup_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ storage_path: path, status: 'ok', size_bytes: bytes.length, ...runMeta }) });

    // Retention: delete old objects and metadata only after the new backup uploaded successfully.
    const days = Number(settings.retention_days);
    if (days > 0) {
      const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
      const old = await rest(`backup_runs?status=eq.ok&created_at=lt.${encodeURIComponent(cutoff)}&select=id,storage_path&order=created_at.asc`);
      const removable = (old || []).filter((x: any) => x.storage_path && x.storage_path !== path);
      if (removable.length) {
        await storage('object/database-backups', { method: 'DELETE', body: JSON.stringify({ prefixes: removable.map((x: any) => x.storage_path) }) });
        await rest(`backup_runs?id=in.(${removable.map((x: any) => x.id).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      }
    }
    return json({ ok: true, path, size_bytes: bytes.length, next_run_at, reason });
  } catch (e) {
    const message = String((e as Error)?.message || e).slice(0, 1000);
    try { await rest('backup_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', error_message: message, ...runMeta }) }); } catch { /* preserve original failure */ }
    return json({ ok: false, error: message }, 500);
  }
});
