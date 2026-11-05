// Normaliza la dirección del repositorio. Imprime: URL_GIT|PAGINA
import { normalizeRepo } from './lib.mjs';
try { const r = normalizeRepo(process.argv[2]); console.log(`${r.url}|${r.pages}|${r.owner}/${r.name}`); }
catch (e) { console.error(e.message); process.exit(1); }
