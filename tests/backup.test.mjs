import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackup, summarize, safePhotoPath, fmtBytes, base64ToBytes, RESTORABLE, GROUPS } from '../src/js/backup-utils.js';

const manual = (extra = {}) => JSON.stringify({
  format: 'depositoapp-backup', format_version: 2, created_at: '2026-11-06T10:00:00Z',
  tables: { categories: [{ id: 'a', name: 'Bebidas' }], products: [{ id: 'p1' }, { id: 'p2' }], backup_runs: [{ id: 'x' }], tabla_rara: [{ id: 1 }] },
  storage: { bucket: 'product-photos', files: [{ path: 'a/b.jpg', content_type: 'image/jpeg', base64: 'AAAA' }, { path: '../x.jpg', base64: 'AAAA' }, { path: 'vacia.jpg', base64: '' }] },
  ...extra,
});

test('lee un respaldo manual: ignora backup_runs, informa tablas desconocidas y descarta fotos inseguras', () => {
  const r = parseBackup(manual());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.tables).sort(), ['categories', 'products']);
  assert.deepEqual(r.ignored, ['tabla_rara']);
  assert.equal(r.totalRows, 3);
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].path, 'a/b.jpg');
  assert.equal(r.meta.kind, 'manual');
  assert.equal(r.meta.version, 2);
});

test('lee un respaldo automático (database_tables / generated_at)', () => {
  const r = parseBackup(JSON.stringify({ format: 'depositoapp-backup', format_version: 1, generated_at: '2026-11-01T03:00:00Z', database_tables: { customers: [{ id: 'c' }] } }));
  assert.equal(r.ok, true);
  assert.equal(r.meta.kind, 'automatic');
  assert.equal(r.meta.createdAt, '2026-11-01T03:00:00Z');
  assert.equal(r.tables.customers.length, 1);
});

test('acepta un archivo con BOM', () => {
  assert.equal(parseBackup('\ufeff' + manual()).ok, true);
});

test('rechaza archivos que no son respaldos', () => {
  assert.equal(parseBackup('').ok, false);
  assert.equal(parseBackup('no es json').ok, false);
  assert.equal(parseBackup('[]').ok, false);
  assert.equal(parseBackup(JSON.stringify({ format: 'otra-cosa', tables: {} })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ format: 'depositoapp-backup' })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ format: 'depositoapp-backup', tables: { products: 'roto' } })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ format: 'depositoapp-backup', tables: { products: [] } })).ok, false);
});

test('un respaldo solo de fotografías es válido', () => {
  const r = parseBackup(JSON.stringify({ format: 'depositoapp-backup', created_at: 'x', tables: {}, storage: { files: [{ path: 'f.png', base64: 'AAAA' }] } }));
  assert.equal(r.ok, true);
  assert.equal(r.totalRows, 0);
  assert.equal(r.photos.length, 1);
});

test('summarize agrupa por sección y omite las que no vienen', () => {
  const s = summarize({ products: [1, 2, 3], categories: [1], customers: [1, 2] });
  assert.deepEqual(s.map((g) => [g.id, g.rows]), [['catalog', 4], ['customers', 2]]);
});

test('safePhotoPath bloquea rutas peligrosas', () => {
  assert.equal(safePhotoPath('a/b.jpg'), 'a/b.jpg');
  assert.equal(safePhotoPath('/a/b.jpg'), 'a/b.jpg');
  assert.equal(safePhotoPath('a\\b.jpg'), 'a/b.jpg');
  assert.equal(safePhotoPath('../b.jpg'), null);
  assert.equal(safePhotoPath('a/../b.jpg'), null);
  assert.equal(safePhotoPath('a//b.jpg'), null);
  assert.equal(safePhotoPath(''), null);
  assert.equal(safePhotoPath(5), null);
});

test('fmtBytes y base64ToBytes', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1048576), '5.0 MB');
  assert.deepEqual([...base64ToBytes('SGk=')], [72, 105]);
});

test('RESTORABLE cubre todas las tablas de los grupos salvo el historial de respaldos', () => {
  assert.ok(!RESTORABLE.includes('backup_runs'));
  assert.equal(RESTORABLE.length, GROUPS.flatMap((g) => g.tables).length - 1);
});
