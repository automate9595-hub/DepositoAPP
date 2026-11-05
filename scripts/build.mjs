// Compila src/ → docs/ (GitHub Pages). Sin dependencias. Inyecta la configuración PÚBLICA y la versión del service worker.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnvFile, validateUrl, validateKey } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src'); const out = join(root, 'docs'); const MARK = '.deposito-build';
const die = (m) => { console.error('✖ ' + m); process.exit(1); };

const env = { ...parseEnvFile(join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SUPABASE_URL|SUPABASE_ANON_KEY|CURRENCY|LOCALE)$/.test(k))) };
let url; let key;
if (process.argv.includes('--sin-config')) { url = 'https://TU-PROYECTO.supabase.co'; key = 'TU-CLAVE-PUBLICA-ANON'; }
else { try { url = validateUrl(env.SUPABASE_URL); key = validateKey(env.SUPABASE_ANON_KEY); } catch (e) { die(e.message + '\n  Configure el archivo .env (copie .env.example) o ejecute publicar.bat.'); } }
const config = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key, CURRENCY: env.CURRENCY || 'ARS', LOCALE: env.LOCALE || 'es-AR' };

// docs/ solo se limpia si lo creó este script (marca); nunca se borran archivos ajenos
if (existsSync(out)) {
  const entries = readdirSync(out);
  if (entries.length && !entries.includes(MARK)) die('La carpeta docs/ tiene archivos que no son de esta compilación. Muévala o bórrela manualmente y vuelva a intentar.');
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(src).filter((f) => !f.endsWith('config.example.js'));
const hash = createHash('sha1');
for (const f of files.sort()) hash.update(relative(src, f)).update(readFileSync(f));

const VERSION = hash.digest('hex').slice(0, 10);

const TEXT = new Set(['.html', '.js', '.css', '.webmanifest', '.json']);
const written = [];
for (const f of files) {
  const rel = relative(src, f).split('\\').join('/');
  const dest = join(out, rel); mkdirSync(dirname(dest), { recursive: true });
  if (TEXT.has(extname(f))) writeFileSync(dest, readFileSync(f, 'utf8').replace(/__VERSION__/g, VERSION));
  else writeFileSync(dest, readFileSync(f));
  written.push(rel);
}
writeFileSync(join(out, 'config.js'), `// Configuración PÚBLICA. Edite con el Bloc de notas: URL del proyecto y clave "anon public" de Supabase.\n// NUNCA pegue aquí la clave service_role / secret.\nwindow.APP_CONFIG = {\n  SUPABASE_URL: ${JSON.stringify(config.SUPABASE_URL)},\n  SUPABASE_ANON_KEY: ${JSON.stringify(config.SUPABASE_ANON_KEY)},\n  CURRENCY: ${JSON.stringify(config.CURRENCY)},\n  LOCALE: ${JSON.stringify(config.LOCALE)},\n};\n`);
written.push('config.js');

const versioned = new Set(['css/app.css', 'js/main.js']);
const assets = ['./', './index.html', './manifest.webmanifest'];
for (const rel of written) {
  if (rel === 'sw.js' || rel === 'index.html' || rel === 'manifest.webmanifest' || rel === 'config.js') continue;
  assets.push(versioned.has(rel) ? `./${rel}?v=${VERSION}` : `./${rel}`);
}
const swPath = join(out, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace('__ASSETS__', JSON.stringify(assets, null, 1)));

writeFileSync(join(out, 'index.html'), readFileSync(join(out, 'index.html')));
writeFileSync(join(out, '404.html'), readFileSync(join(out, 'index.html')));
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, MARK), `build ${VERSION}\n`);

// Verificaciones finales de la compilación
const bad = [];
for (const rel of ['index.html', 'sw.js', 'config.js', 'manifest.webmanifest', 'js/main.js', 'css/app.css']) if (!existsSync(join(out, rel))) bad.push(rel);
if (/__VERSION__|__ASSETS__/.test(readFileSync(join(out, 'sw.js'), 'utf8') + readFileSync(join(out, 'index.html'), 'utf8'))) bad.push('marcadores sin reemplazar');
if (bad.length) die('La compilación quedó incompleta: ' + bad.join(', '));
console.log(`✔ Compilación correcta · versión ${VERSION} · ${written.length} archivos en docs/`);
