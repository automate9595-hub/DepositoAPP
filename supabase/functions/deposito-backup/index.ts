// Supabase Edge Function: scheduled database backup.
// Deploy with: supabase functions deploy deposito-backup
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets.
const cors = { 'content-type': 'application/json' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const intervalChoices = [60, 180, 360, 720, 1440, 2880, 4320, 10080];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'Missing server secrets' }, 500);
  // La función solo acepta invocaciones internas firmadas con la service_role.
  // No publicar ni colocar esta clave en el frontend.
  const supplied = req.headers.get('authorization') || '';
  if (supplied !== `Bearer ${key}`) return json({ error: 'Unauthorized' }, 401);
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

  let settings: any;
  try {
    const rows = await rest('backup_settings?id=eq.1&select=*');
    settings = rows?.[0];
    if (!settings) return json({ skipped: true, reason: 'backup settings not installed' });
    if (!intervalChoices.includes(settings.interval_minutes)) return json({ error: 'Invalid backup interval' }, 400);
    const now = new Date();
    if (settings.next_run_at && new Date(settings.next_run_at).getTime() > now.getTime()) return json({ skipped: true, next_run_at: settings.next_run_at });

    // Advance schedule first to prevent overlapping invocations from duplicating the same backup.
    const next_run_at = nextTime(now, settings.interval_minutes, settings.run_time);
    await rest('backup_settings?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ next_run_at, updated_at: now.toISOString() }) });

    const snapRes = await fetch(`${url}/rest/v1/rpc/backup_snapshot`, { method: 'POST', headers, body: '{}' });
    const snapText = await snapRes.text();
    if (!snapRes.ok) throw new Error(`Snapshot ${snapRes.status}: ${snapText.slice(0, 500)}`);
    const snapshot = JSON.parse(snapText);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}/deposito-${stamp}.json`;
    await storage(`object/database-backups/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-upsert': 'false' }, body: bytes });
    await rest('backup_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ storage_path: path, status: 'ok', size_bytes: bytes.length, triggered_by: 'scheduler' }) });

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
    return json({ ok: true, path, size_bytes: bytes.length, next_run_at });
  } catch (e) {
    const message = String((e as Error)?.message || e).slice(0, 1000);
    try { await rest('backup_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', error_message: message, triggered_by: 'scheduler' }) }); } catch { /* preserve original failure */ }
    return json({ ok: false, error: message }, 500);
  }
});
