// Prueba la Edge Function deposito-backup "de verdad" (su código real) contra un Supabase simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const KEY = 'service-key-de-prueba';
const SNAP = JSON.stringify({ format: 'depositoapp-backup', format_version: 2, generated_at: '2026-11-08T12:00:00Z',
  database_tables: { orders: [{ id: 'o1' }], order_commissions: [{ order_id: 'o1', amount: 50 }] },
  notes: { auth_passwords_included: false, storage_product_photos_included: false } });

// Carga el módulo una vez; cada prueba reemplaza el "Supabase" simulado.
let handler; let world;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY })[k] }, serve: (h) => { handler = h; } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = init.method || 'GET'; world.calls.push({ url: u, method, body: init.body, headers: init.headers });
  const ok = (b, s = 200) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: s });
  if (u.includes('/rest/v1/backup_settings') && method === 'GET') return ok([world.settings]);
  if (u.includes('/rest/v1/backup_settings') && method === 'PATCH') return ok('');
  if (u.includes('/rest/v1/rpc/backup_snapshot')) return world.snapshot ? ok(world.snapshot) : ok({ message: 'boom' }, 500);
  if (u.includes('/storage/v1/object/list/product-photos')) return ok([]);
  if (u.includes('/storage/v1/object/database-backups/') && method === 'POST') { world.uploaded = { path: u.split('/database-backups/')[1], body: init.body, type: init.headers['content-type'] }; return ok({ Key: 'ok' }); }
  if (u.includes('/rest/v1/backup_runs') && method === 'POST') { world.runs.push(JSON.parse(init.body)); return ok(''); }
  if (u.includes('/rest/v1/backup_runs') && method === 'GET') return ok([]);
  return realFetch(url, init);
};
await import(pathToFileURL(resolve('supabase/functions/deposito-backup/index.ts')).href);

const reset = (over = {}) => { world = { calls: [], runs: [], uploaded: null, snapshot: SNAP,
  settings: { id: 1, interval_minutes: 1440, run_time: '03:00', next_run_at: new Date(Date.now() + 3600e3).toISOString(), retention_days: 30 }, ...over }; };
const call = (body, auth = `Bearer ${KEY}`, method = 'POST') => handler(new Request('https://f/', { method, headers: { authorization: auth }, body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body) }));

test('rechaza llamadas sin la clave interna (incluida una casi igual)', async () => {
  reset();
  assert.equal((await call({}, 'Bearer otra')).status, 401);
  assert.equal((await call({}, `Bearer ${KEY}x`)).status, 401);
  assert.equal((await call({}, '')).status, 401);
  assert.equal((await call({}, undefined, 'GET')).status, 405);
  assert.equal(world.calls.length, 0, 'no debe tocar nada sin autorización');
});

test('programado: si todavía no toca, no respalda', async () => {
  reset();
  const r = await call({}); const b = await r.json();
  assert.equal(b.skipped, true); assert.equal(world.uploaded, null);
});

test('cierre de caja: respalda aunque no toque, no mueve la próxima ejecución, guarda comprimido y lo registra con el día', async () => {
  reset();
  const r = await call({ reason: 'cierre_caja', day: '2026-11-08' }); const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.reason, 'cierre_caja');
  assert.ok(!world.calls.some((c) => c.method === 'PATCH'), 'no debe adelantar el calendario de respaldos programados');
  assert.match(world.uploaded.path, /deposito-cierre-2026-11-08-.*\.json\.gz$/);
  assert.equal(world.uploaded.type, 'application/gzip');
  const text = gunzipSync(Buffer.from(world.uploaded.body)).toString('utf8');
  const parsed = JSON.parse(text);   // debe ser JSON válido (sin claves duplicadas ni cortes)
  assert.equal(parsed.database_tables.order_commissions[0].amount, 50);
  assert.deepEqual(parsed.storage, { bucket: 'product-photos', files: [] });
  assert.equal(parsed.notes.storage_product_photos_included, true);
  assert.equal(text.match(/"notes":/g).length, 1);
  assert.equal(world.runs.length, 1);
  assert.deepEqual({ ...world.runs[0], size_bytes: undefined, storage_path: undefined }, { status: 'ok', triggered_by: 'cierre_caja', reason: 'cierre_caja', closing_day: '2026-11-08', size_bytes: undefined, storage_path: undefined });
  assert.equal(world.runs[0].size_bytes, world.uploaded.body.length);
});

test('programado vencido: respalda y adelanta el calendario', async () => {
  reset({ settings: { id: 1, interval_minutes: 1440, run_time: '03:00', next_run_at: new Date(Date.now() - 1000).toISOString(), retention_days: 30 } });
  const b = await (await call({})).json();
  assert.equal(b.ok, true);
  assert.ok(world.calls.some((c) => c.method === 'PATCH'));
  assert.equal(world.runs[0].triggered_by, 'scheduler'); assert.equal(world.runs[0].closing_day, null);
});

test('un día con formato raro no se toma como cierre (se trata como programado)', async () => {
  reset();
  const b = await (await call({ reason: 'cierre_caja', day: "2026-11-08'; drop table x;--" })).json();
  assert.equal(b.skipped, true);
});

test('si la base falla, queda registrado el fallo con el día del cierre y se responde error', async () => {
  reset({ snapshot: null });
  const r = await call({ reason: 'cierre_caja', day: '2026-11-08' });
  assert.equal(r.status, 500);
  assert.equal(world.runs.length, 1);
  assert.equal(world.runs[0].status, 'failed'); assert.equal(world.runs[0].closing_day, '2026-11-08');
  assert.match(world.runs[0].error_message, /Snapshot 500/);
  assert.equal(world.uploaded, null);
});

test('si la base es demasiado grande para la función, lo dice claro (no se cae sin avisar)', async () => {
  reset({ snapshot: JSON.stringify({ x: 'a'.repeat(151 * 1024 * 1024) }) });
  const r = await call({ reason: 'cierre_caja', day: '2026-11-08' });
  assert.equal(r.status, 500);
  assert.match(world.runs[0].error_message, /demasiado grande/);
  assert.equal(world.uploaded, null);
});
