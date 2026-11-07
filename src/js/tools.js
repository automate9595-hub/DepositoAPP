// Herramientas con interfaz: escáner de códigos de barras, descarga de CSV, compartir e imprimir pedidos.
import { modal, icon, toast, ok, fail } from './ui.js';
import { esc } from './format.js';
import { toCsv, orderText, remitoHtml } from './export-utils.js';
import { decodeRgba } from './barcode-decode.js';

// ---------- Descargas ----------
export function downloadCsv(filename, header, rows) {
  const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const stamp = () => new Date().toISOString().slice(0, 10);

// Trae TODAS las filas de una consulta paginada (de a 1000, con tope de seguridad)
export async function fetchAll(build, { page = 1000, max = 20000 } = {}) {
  const out = [];
  for (let from = 0; from < max; from += page) {
    const { data } = await build(from, from + page - 1);
    out.push(...(data || []));
    if ((data || []).length < page) break;
  }
  return out;
}

// ---------- Compartir e imprimir pedidos ----------
export async function shareOrder(o) {
  const text = orderText(o);
  try {
    if (navigator.share) { await navigator.share({ title: `Pedido ${o.order_number}`, text }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}
export function printOrder(o) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  f.srcdoc = remitoHtml(o);
  f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { fail('No se pudo abrir la impresión en este dispositivo.'); } setTimeout(() => f.remove(), 60000); };
  document.body.append(f);
}
export const orderToolsHtml = () => `<div class="row"><button class="btn grow" type="button" data-share>${icon('share')} Compartir</button><button class="btn grow" type="button" data-print>${icon('print')} Imprimir</button></div>`;
export function bindOrderTools(root, o) {
  root.querySelector('[data-share]')?.addEventListener('click', () => shareOrder(o));
  root.querySelector('[data-print]')?.addEventListener('click', () => printOrder(o));
}

// ---------- Escáner de códigos de barras / QR (usa la cámara; solo si el navegador lo permite) ----------
// Usa BarcodeDetector si el navegador lo trae; si no (iPhone/Safari), usa el decodificador propio de EAN/UPC.
export const scannerSupported = () => !!navigator.mediaDevices?.getUserMedia;

export function scanBarcode({ title = 'Escanear código' } = {}) {
  return modal(`<h2>${esc(title)}</h2>
    <div class="scanbox"><video id="sv" playsinline muted autoplay></video><i class="scanline"></i></div>
    <p class="muted small" id="sm" aria-live="polite">Apunte la cámara al código de barras del producto. Si está oscuro o borroso, acérquelo o aléjelo un poco.</p>
    <form id="mf" class="row" style="margin-top:10px"><input name="c" class="grow" inputmode="numeric" placeholder="O escriba el código a mano" aria-label="Código escrito a mano" maxlength="60"><button class="btn primary" aria-label="Usar este código">${icon('check')}</button></form>
    <button class="btn block" data-close type="button" style="margin-top:12px">Cancelar</button>`, {
    onMount: async (ov, close) => {
      let stream; let stop = false; const msg = ov.querySelector('#sm'); const video = ov.querySelector('#sv');
      const cleanup = () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
      const obs = new MutationObserver(() => { if (!ov.isConnected) { cleanup(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
      ov.querySelector('#mf').addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.c.value.trim(); if (v) { cleanup(); close(v); } });
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        video.srcObject = stream; await video.play();
        const det = 'BarcodeDetector' in window ? new BarcodeDetector() : null;   // todos los formatos que soporte el dispositivo
        const canvas = document.createElement('canvas'); const g = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (stop) return;
          try {
            let code = null;
            if (det) { const r = await det.detect(video); code = r[0]?.rawValue || null; }
            if (!code && video.videoWidth) {
              const k = Math.min(1, 960 / video.videoWidth); canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
              g.drawImage(video, 0, 0, canvas.width, canvas.height);
              code = decodeRgba(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            }
            if (code) { cleanup(); close(code); return; }
          } catch { /* sigue intentando */ }
          setTimeout(tick, det ? 250 : 180);
        };
        tick();
      } catch (e) {
        cleanup();
        msg.textContent = e?.name === 'NotAllowedError' ? 'No hay permiso para usar la cámara. Habilítelo en los ajustes del navegador, o escriba el código a mano.' : 'No se pudo iniciar la cámara en este dispositivo. Puede escribir el código a mano.';
      }
    },
  });
}

// Agrega un botón de escaneo junto a un buscador: al leer un código lo escribe y dispara la búsqueda
export function attachScanner(input) {
  if (!input || !scannerSupported() || input.dataset.scan) return;
  input.dataset.scan = '1';
  const wrap = document.createElement('div'); wrap.className = 'row';
  input.replaceWith(wrap); input.classList.add('grow'); wrap.append(input);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn scanbtn'; b.setAttribute('aria-label', 'Escanear código de barras'); b.innerHTML = icon('scan');
  b.addEventListener('click', async () => {
    const code = await scanBarcode();
    if (!code) return;
    input.value = code; input.dispatchEvent(new Event('input', { bubbles: true })); toast(`Código leído: ${code}`, 'ok');
  });
  wrap.append(b);
}
export { ok };
