// Barra de categorías: fila que se desliza con el dedo (ocupa una sola línea) + menú desplegable con todas,
// buscador y la categoría actual marcada. Se usa en Productos (administración) y en el catálogo del preventista.
import { icon, modal } from './ui.js';
import { esc } from './format.js';

export function categoryBar(host, { cats, value, onChange, none = false }) {
  function items() {
    const list = cats();
    return [['', 'Todos'], ...list.map((c) => [c.id, c.name + (c.active === false ? ' (inactiva)' : '')]), ...(none && list.length ? [['__none', 'Sin categoría']] : [])];
  }
  function render() {
    const its = items(); const v = value();
    const cur = its.find(([k]) => k === v) || its[0];
    host.innerHTML = `<div class="catbar">
      <button type="button" class="catmenu" aria-haspopup="dialog" aria-label="Elegir categoría. Actual: ${esc(cur[1])}">${icon('list')}<span class="ellipsis">${esc(cur[1])}</span><i class="caret" aria-hidden="true"></i></button>
      <div class="catscroll" role="group" aria-label="Categorías (deslice hacia los costados)">${its.map(([k, l]) => `<button type="button" class="chip ${k === v ? 'on' : ''}" data-c="${esc(k)}" aria-pressed="${k === v}">${esc(l)}</button>`).join('')}</div></div>`;
    const sc = host.querySelector('.catscroll'); const on = sc.querySelector('.chip.on');
    if (on) sc.scrollLeft = Math.max(0, on.offsetLeft - sc.clientWidth / 2 + on.offsetWidth / 2);   // deja visible la elegida
    sc.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) pick(b.dataset.c); });
    host.querySelector('.catmenu').addEventListener('click', openMenu);
  }
  function pick(k) { if (k === value()) return; onChange(k); render(); }
  async function openMenu() {
    const its = items(); const v = value();
    const chosen = await modal(`<h2>Categorías</h2>
      ${its.length > 8 ? '<input id="cm-q" type="search" placeholder="Buscar categoría" autocomplete="off" aria-label="Buscar categoría" style="margin:6px 0 10px">' : ''}
      <div class="catlist" role="listbox" aria-label="Categorías">${its.map(([k, l]) => `<button type="button" role="option" class="catitem ${k === v ? 'on' : ''}" data-c="${esc(k)}" aria-selected="${k === v}"><span class="grow">${esc(l)}</span><span class="tick">${icon('check')}</span></button>`).join('')}</div>
      <button class="btn block" data-close type="button" style="margin-top:12px">Cerrar</button>`, {
      onMount: (ov, close) => {
        ov.querySelector('.catlist').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) close(b.dataset.c); });
        const q = ov.querySelector('#cm-q');
        q?.addEventListener('input', () => { const t = q.value.trim().toLowerCase(); ov.querySelectorAll('.catitem').forEach((b) => { b.classList.toggle('hidden', !!t && !b.textContent.toLowerCase().includes(t)); }); });
        ov.querySelector('.catitem.on')?.scrollIntoView({ block: 'center' });
      },
    });
    if (typeof chosen === 'string') pick(chosen);
  }
  render();
  return { render };
}
