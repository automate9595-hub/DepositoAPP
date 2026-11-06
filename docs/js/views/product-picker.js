// Selector de productos con cantidades (para que la administración sume productos a un pedido)
import { read } from '../api.js';
import { esc, money, cleanSearch, debounce, one, toInt } from '../format.js';
import { $, modal, icon, spinner, errorBox } from '../ui.js';
import { friendly } from '../api.js';

export function pickProducts({ title = 'Agregar productos', hint = '' } = {}) {
  const picks = new Map(); // id -> { id, name, qty, max }
  return modal(`<h2>${esc(title)}</h2>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
    <input id="pq" type="search" placeholder="Buscar producto o código" aria-label="Buscar producto" autocomplete="off">
    <div id="pl" class="list" style="margin:12px 0;max-height:46vh;overflow:auto"></div>
    <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button><button type="button" class="btn accent grow" id="pok" disabled>Agregar</button></div>`, {
    onMount: async (ov, close) => {
      const list = $('#pl', ov); const ok = $('#pok', ov); let gen = 0; let rows = [];
      const sync = () => { const n = [...picks.values()].reduce((t, p) => t + p.qty, 0); ok.disabled = n === 0; ok.textContent = n ? `Agregar (${picks.size} producto${picks.size === 1 ? '' : 's'}, ${n} u.)` : 'Agregar'; };
      const draw = () => {
        list.innerHTML = rows.length ? rows.map((p) => {
          const av = one(p.inventory)?.available_stock ?? 0; const q = picks.get(p.id)?.qty ?? 0;
          return `<div class="card row" data-id="${p.id}"><div class="grow"><div class="pname">${esc(p.name)}</div>
            <div class="muted small mono">${esc(p.code)} · ${money(p.price)} · disp. <b>${av}</b></div></div>
            ${av > 0 ? `<div class="stepper" style="width:124px"><button type="button" data-d="-1" aria-label="Quitar uno">−</button><input inputmode="numeric" value="${q}" data-q data-max="${av}" aria-label="Cantidad"><button type="button" data-d="1" aria-label="Agregar uno">+</button></div>` : '<span class="status s-idle">Sin stock</span>'}</div>`;
        }).join('') : '<p class="muted" style="text-align:center">No hay productos para mostrar.</p>';
      };
      const set = (row, n) => {
        const p = rows.find((r) => r.id === row.dataset.id); if (!p) return;
        const max = one(p.inventory)?.available_stock ?? 0; const v = Math.max(0, Math.min(max, n));
        if (v === 0) picks.delete(p.id); else picks.set(p.id, { id: p.id, name: p.name, qty: v, max });
        $('[data-q]', row).value = v; sync();
      };
      async function load() {
        const my = ++gen; list.innerHTML = spinner();
        try {
          const { data } = await read((s) => {
            let b = s.from('products').select('id,code,name,price,inventory(available_stock)').eq('active', true).order('name').limit(30);
            const t = cleanSearch($('#pq', ov).value); if (t) b = b.or(`name.ilike.%${t}%,code.ilike.%${t}%`); return b;
          });
          if (my !== gen) return; rows = data || []; draw();
        } catch (e) { if (my === gen) list.innerHTML = errorBox(friendly(e)); }
      }
      $('#pq', ov).addEventListener('input', debounce(load, 350));
      list.addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (!b) return; const row = b.closest('[data-id]'); set(row, toInt($('[data-q]', row).value) + toInt(b.dataset.d)); });
      list.addEventListener('change', (e) => { if (e.target.matches('[data-q]')) set(e.target.closest('[data-id]'), toInt(e.target.value)); });
      ok.addEventListener('click', () => close([...picks.values()].map((p) => ({ product_id: p.id, qty: p.qty, name: p.name }))));
      await load(); $('#pq', ov).focus();
    },
  }).then((v) => (Array.isArray(v) ? v : null));
}
