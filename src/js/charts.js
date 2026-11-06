// Gráficos SVG propios (sin librerías externas): líneas/áreas, barras, anillo, barras horizontales y mini-gráficos.
import { esc } from './format.js';
import { niceScale } from './stats-utils.js';

let uid = 0;
export const PALETTE = ['var(--ch1)', 'var(--ch2)', 'var(--ch3)', 'var(--ch4)', 'var(--ch5)', 'var(--ch6)'];
const f1 = (n) => Math.round(n * 10) / 10;

// Curva suave sin "rebotes" (tangentes horizontales)
function smooth(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : '';
  let d = `M${f1(pts[0].x)},${f1(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]; const b = pts[i]; const mx = (a.x + b.x) / 2;
    d += ` C${f1(mx)},${f1(a.y)} ${f1(mx)},${f1(b.y)} ${f1(b.x)},${f1(b.y)}`;
  }
  return d;
}

/**
 * Gráfico interactivo de líneas/áreas o barras.
 * cfg: { type:'line'|'bar', labels:[], titles:[], series:[{key,name,color,values,area}], fmt(v), fmtAxis(v), height }
 */
export function mountChart(el, cfg) {
  const id = `ch${++uid}`; const hidden = new Set(); let first = true; let lastW = 0;
  const type = cfg.type || 'line';
  el.classList.add('chart');
  el.innerHTML = `<div class="legend"></div><div class="plot"></div><div class="ch-tip" role="status" hidden></div>`;
  const legend = el.querySelector('.legend'); const plot = el.querySelector('.plot'); const tip = el.querySelector('.ch-tip');
  if (cfg.series.length > 1) {
    legend.innerHTML = cfg.series.map((s) => `<button type="button" class="lg" data-k="${s.key}" aria-pressed="true"><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join('');
    legend.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const k = b.dataset.k; if (hidden.has(k)) hidden.delete(k); else if (hidden.size < cfg.series.length - 1) hidden.add(k);
      legend.querySelectorAll('[data-k]').forEach((x) => { const off = hidden.has(x.dataset.k); x.classList.toggle('off', off); x.setAttribute('aria-pressed', String(!off)); });
      draw(false);
    });
  } else legend.remove();

  function draw(animate) {
    const W = Math.max(260, Math.floor(plot.clientWidth || el.clientWidth || 320)); lastW = W;
    const H = cfg.height || 240; const n = cfg.labels.length;
    const vis = cfg.series.filter((s) => !hidden.has(s.key));
    const max = Math.max(0, ...vis.flatMap((s) => s.values.map(Number)));
    const sc = niceScale(max, 4); const axis = (cfg.fmtAxis || String);
    const lblW = Math.max(...sc.ticks.map((t) => axis(t).length)) * 6.4 + 12;
    const m = { t: 12, r: 12, b: 28, l: Math.max(34, lblW) }; const w = W - m.l - m.r; const h = H - m.t - m.b;
    const y = (v) => m.t + h - (Number(v) / sc.max) * h;
    const band = w / Math.max(1, n); const x = (i) => (type === 'bar' ? m.l + band * i + band / 2 : m.l + (n === 1 ? w / 2 : (w / (n - 1)) * i));
    const stepX = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));
    let g = `<g class="ch-grid">${sc.ticks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${f1(y(t))}" y2="${f1(y(t))}"/>`).join('')}</g>`;
    g += `<g class="ch-axis">${sc.ticks.map((t) => `<text x="${m.l - 8}" y="${f1(y(t)) + 4}" text-anchor="end">${esc(axis(t))}</text>`).join('')}`;
    g += cfg.labels.map((l, i) => (i % stepX === 0 ? `<text x="${f1(x(i))}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>` : '')).join('') + '</g>';
    if (type === 'bar') {
      const k = vis.length; const bw = Math.max(2, Math.min(34, (band * 0.7) / k));
      g += vis.map((s, si) => s.values.map((v, i) => {
        const bh = Math.max(Number(v) > 0 ? 2 : 0, h - (y(v) - m.t));
        return `<rect class="ch-bar" data-i="${i}" x="${f1(x(i) - (bw * k) / 2 + si * bw)}" y="${f1(m.t + h - bh)}" width="${f1(bw - 1)}" height="${f1(bh)}" rx="${Math.min(4, bw / 2)}" fill="${s.color}" style="animation-delay:${Math.min(i * 12, 400)}ms"/>`;
      }).join('')).join('');
    } else {
      g += `<defs>${vis.map((s) => `<linearGradient id="${id}-${s.key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity=".32"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`).join('')}</defs>`;
      for (const s of vis) {
        const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) })); const d = smooth(pts);
        if (s.area && pts.length > 1) g += `<path class="ch-area" d="${d} L${f1(pts[pts.length - 1].x)},${m.t + h} L${f1(pts[0].x)},${m.t + h} Z" fill="url(#${id}-${s.key})"/>`;
        g += pts.length > 1 ? `<path class="ch-line" pathLength="1" d="${d}" stroke="${s.color}"/>` : '';
        if (pts.length <= 31) g += pts.map((p) => `<circle class="ch-dot" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${pts.length === 1 ? 5 : 2.6}" fill="${s.color}"/>`).join('');
      }
    }
    g += `<line class="ch-guide" x1="0" x2="0" y1="${m.t}" y2="${m.t + h}" style="display:none"/><g class="ch-hover"></g>`;
    g += `<rect class="ch-hit" x="${m.l}" y="${m.t}" width="${w}" height="${h}" fill="transparent"/>`;
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria || 'Gráfico')}">${g}</svg>`;
    el.classList.toggle('static', !animate);
    // Interacción: guía, puntos y recuadro con valores
    const svg = plot.querySelector('svg'); const hit = svg.querySelector('.ch-hit'); const guide = svg.querySelector('.ch-guide'); const hov = svg.querySelector('.ch-hover');
    const show = (ev) => {
      const r = svg.getBoundingClientRect(); const px = ev.clientX - r.left;
      let i = type === 'bar' ? Math.floor((px - m.l) / band) : Math.round(n === 1 ? 0 : ((px - m.l) / w) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i)); const cx = x(i);
      guide.style.display = type === 'bar' ? 'none' : ''; guide.setAttribute('x1', cx); guide.setAttribute('x2', cx);
      hov.innerHTML = type === 'bar' ? '' : vis.map((s) => `<circle cx="${f1(cx)}" cy="${f1(y(s.values[i]))}" r="5" fill="var(--card)" stroke="${s.color}" stroke-width="2.5"/>`).join('');
      svg.querySelectorAll('.ch-bar').forEach((b) => b.classList.toggle('dim', Number(b.dataset.i) !== i));
      tip.hidden = false;
      tip.innerHTML = `<b>${esc((cfg.titles || cfg.labels)[i])}</b>${vis.map((s) => `<div class="tr"><i style="background:${s.color}"></i><span>${esc(s.name)}</span><b>${esc((cfg.fmt || String)(s.values[i]))}</b></div>`).join('')}`;
      const tw = tip.offsetWidth; const left = Math.max(4, Math.min(W - tw - 4, cx - tw / 2));
      tip.style.left = `${left + (plot.offsetLeft || 0)}px`; tip.style.top = `${plot.offsetTop + 8}px`;
    };
    const hide = () => { tip.hidden = true; guide.style.display = 'none'; hov.innerHTML = ''; svg.querySelectorAll('.ch-bar.dim').forEach((b) => b.classList.remove('dim')); };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hide);
  }
  draw(first); first = false;
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (!el.isConnected) { ro.disconnect(); return; } if (Math.abs((plot.clientWidth || 0) - lastW) > 8) draw(false); });
    ro.observe(el);
  }
}

/** Anillo de proporciones. Devuelve HTML (con leyenda). */
export function donut(segments, { center = '', sub = '', fmt = String } = {}) {
  const total = segments.reduce((t, s) => t + Number(s.value), 0);
  if (!(total > 0)) return '<p class="muted small">Sin datos en el período.</p>';
  let acc = 0;
  const arcs = segments.filter((s) => s.value > 0).map((s) => {
    const len = (Number(s.value) / total) * 100; const off = 25 - acc; acc += len;
    return `<circle class="dn" r="15.9155" cx="21" cy="21" fill="none" stroke="${s.color}" stroke-width="5.2" pathLength="100" stroke-dashoffset="${f1(off)}" style="--len:${f1(Math.max(len - 0.6, 0.1))}"><title>${esc(s.label)}: ${esc(fmt(s.value))}</title></circle>`;
  }).join('');
  return `<div class="donut-wrap"><div class="donut"><svg viewBox="0 0 42 42" role="img" aria-label="Distribución">${'<circle r="15.9155" cx="21" cy="21" fill="none" stroke="var(--idle-bg)" stroke-width="5.2"/>'}${arcs}</svg>
    <div class="dc"><b>${esc(center)}</b><span>${esc(sub)}</span></div></div>
    <ul class="dl">${segments.filter((s) => s.value > 0).map((s) => `<li><i style="background:${s.color}"></i><span class="grow ellipsis">${esc(s.label)}</span><b class="mono">${esc(fmt(s.value))}</b><span class="muted small mono">${Math.round((s.value / total) * 100)}%</span></li>`).join('')}</ul></div>`;
}

/** Lista de barras horizontales con ranking. items: [{name, value, sub?}] */
export function hbars(items, { fmt = String, color = 'var(--ch1)', empty = 'Sin datos en el período.' } = {}) {
  if (!items.length) return `<p class="muted small">${esc(empty)}</p>`;
  const max = Math.max(1e-9, ...items.map((i) => Number(i.value)));
  return `<div class="hb">${items.map((it, i) => `<div class="hbr"><div class="row between small"><span class="ellipsis"><span class="rank">${i + 1}</span>${esc(it.name)}</span><b class="mono">${esc(fmt(it.value))}</b></div>
    <div class="track"><div class="fill" style="width:${Math.max(2, (Number(it.value) / max) * 100)}%;background:${color};animation-delay:${i * 50}ms"></div></div>${it.sub ? `<div class="muted small">${esc(it.sub)}</div>` : ''}</div>`).join('')}</div>`;
}

/** Mini gráfico de tendencia para tarjetas de indicadores */
export function sparkline(values, color = 'var(--ch1)', w = 96, h = 30) {
  const v = values.map(Number); if (v.length < 2 || Math.max(...v) <= 0) return '';
  const max = Math.max(...v); const pts = v.map((n, i) => ({ x: (w / (v.length - 1)) * i, y: h - 3 - (n / max) * (h - 6) }));
  const d = smooth(pts);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d} L${w},${h} L0,${h} Z" fill="${color}" opacity=".12"/><path class="ch-line" pathLength="1" d="${d}" stroke="${color}" style="stroke-width:2"/></svg>`;
}
