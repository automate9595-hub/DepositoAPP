// Comprobaciones previas a compilar/publicar. No requiere dependencias.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = []; const warn = [];
const fail = (m) => errors.push(m);
const rd = (p) => readFileSync(join(root, p), 'utf8');
const walk = (d) => readdirSync(join(root, d)).flatMap((n) => {
  const rel = join(d, n); return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
});

// 1. Estructura
const required = ['package.json', 'README.md', '.env.example', '.gitignore', 'publicar.bat',
  'src/index.html', 'src/manifest.webmanifest', 'src/sw.js', 'src/config.example.js', 'src/css/app.css',
  'src/js/main.js', 'src/js/backup-utils.js', 'src/js/barcode-decode.js', 'src/js/cash-utils.js', 'src/js/views/cash.js', 'src/js/bio.js', 'src/js/supa.js', 'src/js/api.js', 'src/js/cart.js', 'src/js/state.js',
  'src/icons/icon-192.png', 'src/icons/icon-512.png', 'src/icons/icon-maskable-512.png',
  'supabase/01_esquema.sql', 'supabase/02_funciones.sql', 'supabase/03_seguridad.sql', 'supabase/04_crear_administrador.sql', 'supabase/06_clientes_costos.sql', 'supabase/07_respaldos.sql', 'supabase/08_programar_respaldos.sql', 'supabase/09_respaldos_y_cobros.sql', 'supabase/10_restaurar_respaldos.sql', 'supabase/11_eliminar_productos_clientes.sql', 'supabase/12_seguridad_respaldos.sql', 'supabase/13_borrar_productos_y_huella.sql', 'supabase/14_caja_y_preventista.sql', 'supabase/15_inicio_de_caja_y_mercado_pago.sql', 'supabase/functions/deposito-passkey/index.ts', 'supabase/functions/deposito-passkey/verify.js', 'supabase/instalar_todo.sql',
  'supabase/tests/escenarios.sql', 'scripts/build.mjs', 'tests/cart.test.mjs'];
for (const f of required) if (!existsSync(join(root, f))) fail(`Falta el archivo obligatorio: ${f}`);
if (errors.length) done();

// 2. Sintaxis de todos los .js/.mjs
const jsFiles = [...walk('src'), ...walk('scripts'), ...walk('tests')].filter((f) => /\.m?js$/.test(f));
for (const f of jsFiles) {
  if (f.endsWith('sw.js') || f.endsWith('config.example.js')) continue; // contienen marcadores de plantilla
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) fail(`Error de sintaxis en ${f}:\n${r.stderr.split('\n').slice(0, 4).join('\n')}`);
}
{ // sw.js con marcadores sustituidos
  const tmp = join(root, '.sw-check.tmp.mjs');
  writeFileSync(tmp, rd('src/sw.js').replace(/__VERSION__/g, 'x').replace('__ASSETS__', '[]'));
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  unlinkSync(tmp);
  if (r.status !== 0) fail('Error de sintaxis en src/sw.js');
}

// 3. Imports relativos: el archivo existe y exporta lo que se importa
const exportsOf = (src) => {
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((x) => set.add(x.trim().split(/\s+as\s+/).pop()));
  return set;
};
for (const f of jsFiles.filter((x) => x.startsWith('src/js') || x.startsWith('tests'))) {
  const src = rd(f);
  for (const m of src.matchAll(/import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(root, dirname(f), m[2]);
    if (!existsSync(target)) { fail(`${f}: no existe el módulo importado ${m[2]}`); continue; }
    if (m[1]) {
      const ex = exportsOf(readFileSync(target, 'utf8'));
      for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!ex.has(name)) fail(`${f}: '${name}' no es exportado por ${m[2]}`);
      }
    }
  }
}

// 4. SQL: RLS en todas las tablas, funciones llamadas por la app existen
const s1 = rd('supabase/01_esquema.sql') + rd('supabase/09_respaldos_y_cobros.sql'); const s2 = rd('supabase/02_funciones.sql') + rd('supabase/06_clientes_costos.sql') + rd('supabase/09_respaldos_y_cobros.sql') + rd('supabase/10_restaurar_respaldos.sql') + rd('supabase/11_eliminar_productos_clientes.sql') + rd('supabase/12_seguridad_respaldos.sql') + rd('supabase/13_borrar_productos_y_huella.sql') + rd('supabase/14_caja_y_preventista.sql') + rd('supabase/15_inicio_de_caja_y_mercado_pago.sql'); const s3 = rd('supabase/03_seguridad.sql') + rd('supabase/06_clientes_costos.sql') + rd('supabase/09_respaldos_y_cobros.sql');
const tables = [...(s1 + rd('supabase/06_clientes_costos.sql')).matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
for (const t of tables) if (!new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(s3)) fail(`La tabla ${t} no tiene RLS habilitado en 03_seguridad.sql`);
const fns = new Set([...s2.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]));
for (const f of jsFiles.filter((x) => x.startsWith('src/js'))) {
  for (const m of rd(f).matchAll(/rpc\('(\w+)'/g)) if (!fns.has(m[1])) fail(`${f}: llama a la función SQL inexistente ${m[1]}`);
}

// 5. Secretos: nada de service_role ni claves privadas en el repositorio
const jwt = /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/;
for (const f of [...walk('src'), ...walk('scripts'), ...walk('supabase'), ...walk('tests'), 'README.md', '.env.example', 'publicar.bat']) {
  if (!existsSync(join(root, f)) || f.endsWith('check.mjs')) continue;
  const t = rd(f);
  if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(t)) fail(`${f}: contiene una clave secreta de Supabase`);
  const m = t.match(jwt);
  if (m) { try { const role = JSON.parse(Buffer.from(m[1], 'base64url').toString()).role; if (role === 'service_role') fail(`${f}: contiene una clave service_role`); else fail(`${f}: contiene un token JWT; no incluya claves en el código fuente`); } catch { /* no es JWT */ } }
}
if (/service_role/.test(walk('src').map((f) => rd(f)).join('\n').replace(/NUNCA service_role/g, ''))) fail('El código de la app menciona service_role');
if (!/\.env\b/.test(rd('.gitignore'))) fail('.gitignore debe excluir .env');

// 5b. Seguridad: reglas que no deben romperse nunca
{
  // Toda función SECURITY DEFINER debe fijar search_path (evita el secuestro de funciones por esquema)
  for (const f of walk('supabase').filter((x) => x.endsWith('.sql') && !x.includes('instalar_todo'))) {
    const t = rd(f);
    for (const m of t.matchAll(/create or replace function\s+([\w.]+)\s*\([\s\S]*?\$(\w*)\$/gi)) {
      if (/security definer/i.test(m[0]) && !/set search_path/i.test(m[0])) fail(`${f}: la función ${m[1]} es SECURITY DEFINER sin «set search_path»`);
    }
  }
  // La política de seguridad del navegador (CSP) no admite manejadores inline: onclick=, onload=, onerror=…
  for (const f of walk('src').filter((x) => /\.(js|html)$/.test(x))) {
    const t = rd(f).replace(/\/\/.*$/gm, '');
    const m = t.match(/\son(click|load|error|change|submit|input|mouseover|focus|blur)\s*=\s*["']/i);
    if (m) fail(`${f}: manejador inline «on${m[1]}=» (la política de seguridad lo bloquea; use addEventListener)`);
    if (/javascript:/i.test(t)) fail(`${f}: contiene un enlace javascript:`);
    if (/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(t)) fail(`${f}: usa eval / new Function / document.write`);
  }
  if (!rd('src/index.html').includes('__CSP__')) fail('src/index.html: falta el marcador __CSP__ de la política de seguridad');
}

// 5d. Cada pantalla recibe un contenedor NUEVO (si se reutiliza, los escuchadores de clic se acumulan: «+» suma de a 3, saltos a Clientes…)
if (!/cloneNode\(false\)/.test(rd('src/js/main.js'))) fail('src/js/main.js: route() debe crear un contenedor nuevo para cada pantalla (cloneNode(false))');

// 5c. El verificador de huella del servidor (verify.js y el index.ts de un solo archivo) debe ser idéntico al de la app
{
  const cut = (t) => t.slice(t.indexOf('// ---------- Utilidades puras'), t.indexOf('// ---------- Registro local')).replace(/^\/\/ -+ Utilidades puras.*\n/, '').trim();
  const app = cut(rd('src/js/bio.js'));
  const v = rd('supabase/functions/deposito-passkey/verify.js');
  const idx = rd('supabase/functions/deposito-passkey/index.ts').replace(/export /g, '');
  if (!v.includes(app)) fail('supabase/functions/deposito-passkey/verify.js se desincronizó de src/js/bio.js');
  if (!idx.includes(app.replace(/export /g, ''))) fail('supabase/functions/deposito-passkey/index.ts se desincronizó de src/js/bio.js');
  if (/from\s+['"]\.\/verify\.js['"]/.test(idx)) fail('index.ts no debe importar verify.js (debe ser un solo archivo)');
}

// 6. Pruebas unitarias
function done() {
  if (warn.filter(Boolean).length) console.warn(warn.filter(Boolean).join('\n'));
  if (errors.length) { console.error('\n✖ Comprobaciones fallidas:\n' + errors.map((e) => ' - ' + e).join('\n')); process.exit(1); }
}
done();
const testFiles = walk('tests').filter((f) => f.endsWith('.test.mjs')).map((f) => join(root, f));
const t = spawnSync(process.execPath, ['--test', ...testFiles], { encoding: 'utf8' });
process.stdout.write(t.stdout.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join('\n') + '\n');
if (t.status !== 0) { console.error(t.stdout + t.stderr); console.error('\n✖ Las pruebas unitarias fallaron.'); process.exit(1); }
console.log(`✔ Comprobaciones correctas (${jsFiles.length} archivos JS, ${tables.length} tablas con RLS, ${fns.size} funciones SQL).`);
