// Small SVG chart kit: stacked columns, lines, quota step-area, time columns, heatmap, bar lists.
// Every chart has a hover layer; identity is never colour-only (legend + tooltip + table views).
import {h, s, compact, num, fill} from './util.js';

// ---------- tooltip ----------
const tip = h('div', {class: 'tip', role: 'tooltip', 'aria-hidden': 'true'});
document.body.append(tip);

export function showTip(event, title, rows = [], note) {
  fill(tip, 
    title ? h('div', {class: 'tip-title'}, title) : null,
    rows.length ? h('div', {class: 'tip-rows'}, rows.map(r => h('div', {class: ['tip-row', r.muted && 'muted']},
      r.color ? h('i', {class: 'key', style: {background: r.color}}) : h('i', {class: 'key blank'}),
      h('b', {}, r.value), h('span', {}, r.label)))) : null,
    note ? h('div', {class: 'tip-note'}, note) : null);
  tip.classList.add('on');
  const pad = 14, w = tip.offsetWidth, hh = tip.offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + w > innerWidth - 8) x = event.clientX - w - pad;
  if (y + hh > innerHeight - 8) y = Math.max(8, event.clientY - hh - pad);
  tip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
}
export function hideTip() { tip.classList.remove('on'); }

// ---------- scales ----------
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * .001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function width(el) { return Math.max(320, Math.floor(el.clientWidth || el.parentElement?.clientWidth || 800)); }

function frame(el, H, label) {
  const W = width(el);
  const svg = s('svg', {viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label || 'Chart'});
  fill(el, svg);
  return {svg, W, H};
}

function yAxis(svg, ticks, y, L, R, W, fmt) {
  for (const v of ticks) {
    svg.append(s('line', {x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'gridline'}));
    svg.append(s('text', {x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end'}, fmt(v)));
  }
}

// Columns with 4px rounded data-end, square at the baseline.
function columnPath(x, y0, w, y1, rounded) {
  const hgt = y0 - y1;
  if (hgt <= 0) return '';
  const r = rounded ? Math.min(4, w / 2, hgt) : 0;
  return `M${x},${y0}V${y1 + r}${r ? `Q${x},${y1} ${x + r},${y1}` : ''}H${x + w - r}${r ? `Q${x + w},${y1} ${x + w},${y1 + r}` : ''}V${y0}Z`;
}

// ---------- stacked columns over categorical buckets ----------
// ghost: Map(bucket key → value) drawn as a dashed marker (e.g. the previous period);
// focus: bucket key kept bright while the others fade; ref: {value, label} horizontal line.
export function columns(el, {buckets, series, values, fmt = compact, height = 300, stacked = true, onClick, emptyText, ghost, ghostLabel = 'Previous period', focus, ref, clickNote}) {
  const totals = buckets.map(b => series.reduce((n, sr) => n + (values.get(b.key)?.[sr.key] || 0), 0));
  const ghosts = buckets.map(b => ghost?.get(b.key) || 0);
  if (!buckets.length || !(totals.some(Boolean) || ghosts.some(Boolean))) { fill(el, h('div', {class: 'empty'}, emptyText || 'No data in the selected period')); return; }
  const {svg, W, H} = frame(el, height, 'Bar chart');
  const L = 64, R = 12, T = 14, B = 34;
  const max = Math.max(ref?.value || 0, ...ghosts, ...(stacked ? totals : buckets.flatMap(b => series.map(sr => values.get(b.key)?.[sr.key] || 0))));
  const ticks = niceTicks(max), top = ticks[ticks.length - 1];
  const y = v => H - B - v / top * (H - T - B);
  yAxis(svg, ticks, y, L, R, W, fmt);
  const band = (W - L - R) / buckets.length, cw = Math.max(2, Math.min(24, band * .72));
  const stride = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor((W - L - R) / 74))));
  const marks = s('g');
  svg.append(marks);
  buckets.forEach((b, i) => {
    const cx = L + band * (i + .5), x = cx - cw / 2;
    const g = s('g', {class: ['col', focus != null && b.key !== focus && 'faded']});
    let base = 0;
    const present = series.filter(sr => (values.get(b.key)?.[sr.key] || 0) > 0);
    present.forEach((sr, j) => {
      const v = values.get(b.key)[sr.key];
      const y0 = y(base), y1 = y(base + v);
      const gap = j > 0 ? 1 : 0; // 2px surface gap between segments (1px off each neighbour)
      const top1 = j === present.length - 1;
      const d = columnPath(x, y0 - gap, cw, Math.min(y0 - gap, y1 + (top1 ? 0 : 1)), top1);
      if (d) g.append(s('path', {d, fill: sr.color}));
      base += v;
    });
    if (ghosts[i]) g.append(s('line', {x1: x - 3, x2: x + cw + 3, y1: y(ghosts[i]), y2: y(ghosts[i]), class: 'ghost'}));
    const hit = s('rect', {x: cx - band / 2, y: T, width: band, height: H - T - B, class: 'hit', tabindex: 0});
    const showB = ev => {
      g.classList.add('hover');
      const rows = series.map(sr => ({color: sr.color, label: sr.label, value: fmt(values.get(b.key)?.[sr.key] || 0), v: values.get(b.key)?.[sr.key] || 0}))
        .filter(r => r.v > 0).sort((p, q) => q.v - p.v).slice(0, 10);
      if (rows.length > 1) rows.push({label: 'Total', value: fmt(totals[i])});
      if (ghost) rows.push({label: ghostLabel, value: fmt(ghosts[i]), muted: true, color: 'var(--ink-2)'});
      showTip(ev, b.label, rows, onClick ? clickNote || 'Click to open this period' : null);
    };
    hit.addEventListener('pointermove', showB);
    hit.addEventListener('focus', ev => { const r = hit.getBoundingClientRect(); showB({clientX: r.x + r.width / 2, clientY: r.y + 30}); });
    hit.addEventListener('pointerleave', () => { g.classList.remove('hover'); hideTip(); });
    hit.addEventListener('blur', () => { g.classList.remove('hover'); hideTip(); });
    if (onClick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => onClick(b)); }
    marks.append(g);
    svg.append(hit);
    if (i % stride === 0) svg.append(s('text', {x: cx, y: H - B + 20, class: ['tick', b.key === focus && 'tick-on'], 'text-anchor': 'middle'}, b.short || b.label));
  });
  if (ref && ref.value > 0) {
    svg.append(s('line', {x1: L, x2: W - R, y1: y(ref.value), y2: y(ref.value), class: 'refline dashed'}));
    svg.append(s('text', {x: W - R - 4, y: y(ref.value) - 6, class: 'reflabel', 'text-anchor': 'end'}, ref.label));
  }
}

// ---------- multi-series lines with crosshair ----------
export function lines(el, {labels, series, fmt = compact, height = 280, yMax, emptyText, area = false}) {
  const all = series.flatMap(sr => sr.values.filter(v => v != null));
  if (!labels.length || !all.length) { fill(el, h('div', {class: 'empty'}, emptyText || 'No data')); return; }
  const {svg, W, H} = frame(el, height, 'Line chart');
  const L = 64, R = 16, T = 14, B = 34;
  const ticks = yMax ? niceTicks(yMax) : niceTicks(Math.max(...all)), top = ticks[ticks.length - 1];
  const y = v => H - B - v / top * (H - T - B);
  const n = labels.length, x = i => n === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (n - 1);
  yAxis(svg, ticks, y, L, R, W, fmt);
  const stride = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 80))));
  labels.forEach((lb, i) => { if (i % stride === 0) svg.append(s('text', {x: x(i), y: H - B + 20, class: 'tick', 'text-anchor': 'middle'}, lb.short || lb.label)); });
  const cross = s('line', {y1: T, y2: H - B, class: 'cross'});
  svg.append(cross);
  for (const sr of series) {
    let d = '', run = [];
    const flush = () => {
      if (!run.length) return;
      d += run.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
      if (area && run.length > 1) svg.append(s('path', {d: run.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i)},${y(v)}`).join('') + `L${x(run[run.length - 1][0])},${y(0)}L${x(run[0][0])},${y(0)}Z`, fill: sr.color, class: 'wash'}));
      run = [];
    };
    sr.values.forEach((v, i) => { if (v == null) flush(); else run.push([i, v]); });
    flush();
    svg.append(s('path', {d, stroke: sr.color, class: 'line'}));
    const dots = n <= 40 || sr.values.filter(v => v != null).length <= 40;
    sr.values.forEach((v, i) => {
      const isolated = v != null && sr.values[i - 1] == null && sr.values[i + 1] == null;
      if (v != null && (dots || isolated)) svg.append(s('circle', {cx: x(i), cy: y(v), r: 4, fill: sr.color, class: 'dot'}));
    });
  }
  const hit = s('rect', {x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit'});
  hit.addEventListener('pointermove', ev => {
    const box = svg.getBoundingClientRect(), px = (ev.clientX - box.left) * W / box.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(n === 1 ? 0 : (px - L) / ((W - L - R) / (n - 1)))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.add('on');
    const rows = series.map(sr => ({color: sr.color, label: sr.label, value: sr.values[i] == null ? '—' : fmt(sr.values[i]), v: sr.values[i] ?? -1}))
      .sort((p, q) => q.v - p.v);
    showTip(ev, labels[i].label, rows.slice(0, 12), labels[i].note);
  });
  hit.addEventListener('pointerleave', () => { cross.classList.remove('on'); hideTip(); });
  svg.append(hit);
}

// ---------- time axis helpers ----------
function timeTicks(a, b, clock, px) {
  const span = b - a, maxTicks = Math.max(2, Math.floor(px / 92));
  const ticks = [];
  if (span <= 3 * 86400) {
    const step = [1, 2, 3, 6, 12, 24].find(hh => span / (hh * 3600) <= maxTicks) || 24;
    let t = clock.hourStart(a);
    while (t < b) {
      if (t >= a && clock.hour(t) % step === 0) ticks.push([t, clock.hour(t) === 0 ? clock.date(t) : clock.time(t)]);
      t += 3600;
    }
    return ticks;
  }
  const step = [1, 2, 3, 7, 14, 30].find(d => span / (d * 86400) <= maxTicks) || 30;
  let day = clock.day(a);
  if (clock.dayStart(day) < a) day++;
  const last = clock.day(b);
  for (; day <= last; day++) {
    const t = clock.dayStart(day);
    if (t >= b) break;
    if (step === 30 ? new Date(day * 86400000).getUTCDate() === 1 : step === 7 ? (day + 3) % 7 === 0 : (day % step === 0)) ticks.push([t, clock.date(t)]);
  }
  return ticks;
}

function timeAxis(svg, a, b, clock, X, L, R, W, H, B) {
  for (const [t, label] of timeTicks(a, b, clock, W - L - R)) {
    svg.append(s('line', {x1: X(t), x2: X(t), y1: H - B, y2: H - B + 4, class: 'axis'}));
    svg.append(s('text', {x: X(t), y: H - B + 18, class: 'tick', 'text-anchor': 'middle'}, label));
  }
}

// ---------- quota fill over time (step area) ----------
// points: [ts, used, reset, refill?]; value holds until next point or the deadline, then drops to 0.
export function quotaSteps(points, a, b) {
  const steps = [];
  let i = 0;
  while (i < points.length && points[i][0] < a) i++;
  const start = Math.max(0, i - 1);
  for (let k = start; k < points.length && points[k][0] < b; k++) {
    const [t, v, reset] = points[k];
    const next = k + 1 < points.length ? points[k + 1][0] : Math.min(b, Date.now() / 1000);
    const from = Math.max(a, t), until = Math.min(b, next);
    if (until <= from && k !== start) continue;
    if (reset < until && reset >= from) {
      steps.push([from, v, reset], [reset, 0, null]);
    } else if (reset < from) {
      steps.push([from, 0, null]);
    } else {
      steps.push([from, v, reset]);
    }
  }
  return steps;
}

export function quotaChart(el, {points, a, b, clock, height = 260, resets = [], color = 'var(--s1)'}) {
  const steps = quotaSteps(points, a, b);
  if (!steps.length) { fill(el, h('div', {class: 'empty'}, 'No snapshots of this counter in the selected range')); return; }
  const {svg, W, H} = frame(el, height, 'Quota usage over time');
  const L = 48, R = 14, T = 12, B = 30;
  const end = Math.min(b, Math.max(Date.now() / 1000, steps[steps.length - 1][0]));
  const X = t => L + (t - a) / (b - a) * (W - L - R), y = v => H - B - v / 100 * (H - T - B);
  yAxis(svg, [0, 25, 50, 75, 100], y, L, R, W, v => v + '%');
  timeAxis(svg, a, b, clock, X, L, R, W, H, B);
  let d = `M${X(steps[0][0])},${y(steps[0][1])}`;
  for (let k = 1; k < steps.length; k++) d += `H${X(steps[k][0])}V${y(steps[k][1])}`;
  d += `H${X(end)}`;
  svg.append(s('path', {d: d + `V${y(0)}H${X(steps[0][0])}Z`, fill: color, class: 'wash'}));
  svg.append(s('path', {d, stroke: color, class: 'line'}));
  for (const r of resets) {
    if (r.ts < a || r.ts >= b || !r.early) continue;
    svg.append(s('line', {x1: X(r.ts), x2: X(r.ts), y1: T, y2: H - B, class: 'marker'}));
  }
  const cross = s('line', {y1: T, y2: H - B, class: 'cross'});
  const dot = s('circle', {r: 4, fill: color, class: 'dot', style: {display: 'none'}});
  svg.append(cross, dot);
  const hit = s('rect', {x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit'});
  hit.addEventListener('pointermove', ev => {
    const box = svg.getBoundingClientRect(), px = (ev.clientX - box.left) * W / box.width;
    const t = a + (px - L) / (W - L - R) * (b - a);
    let k = steps.length - 1;
    while (k > 0 && steps[k][0] > t) k--;
    const [, v, reset] = steps[k];
    cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t)); cross.classList.add('on');
    dot.setAttribute('cx', X(t)); dot.setAttribute('cy', y(v)); dot.style.display = '';
    const early = resets.find(r => r.early && Math.abs(r.ts - t) < (b - a) / 200);
    showTip(ev, clock.dateTime(t), [{color, label: 'used', value: num(v) + '%'}],
      (reset ? `Reset: ${clock.dateTime(reset)}` : 'Window inactive') + (early ? ' · nearby early reset' : ''));
  });
  hit.addEventListener('pointerleave', () => { cross.classList.remove('on'); dot.style.display = 'none'; hideTip(); });
  svg.append(hit);
}

// ---------- items placed on a time axis (quota windows) ----------
export function timeColumns(el, {items, a, b, clock, fmt = compact, height = 280, ref, onClick}) {
  if (!items.length) { fill(el, h('div', {class: 'empty'}, 'No windows in this range')); return; }
  const {svg, W, H} = frame(el, height, 'Quota windows');
  const L = 64, R = 14, T = 14, B = 30;
  const ticks = niceTicks(Math.max(...items.map(i => i.value), ref?.value || 0)), top = ticks[ticks.length - 1];
  const X = t => L + (t - a) / (b - a) * (W - L - R), y = v => H - B - v / top * (H - T - B);
  yAxis(svg, ticks, y, L, R, W, fmt);
  timeAxis(svg, a, b, clock, X, L, R, W, H, B);
  for (const it of items) {
    const x0 = X(Math.max(a, it.start)), x1 = X(Math.min(b, it.end));
    const w = Math.max(2, Math.min(28, x1 - x0 - 2));
    const g = s('g', {class: ['col', it.faded && 'faded']});
    const d = columnPath(x0 + 1, y(0), w, y(it.value), true);
    if (d) g.append(s('path', {d, fill: it.color}));
    const hit = s('rect', {x: x0 - 2, y: T, width: w + 4, height: H - T - B, class: 'hit'});
    hit.addEventListener('pointermove', ev => { g.classList.add('hover'); showTip(ev, it.title, it.rows, it.note); });
    hit.addEventListener('pointerleave', () => { g.classList.remove('hover'); hideTip(); });
    if (onClick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => onClick(it)); }
    svg.append(g, hit);
  }
  if (ref && ref.value > 0) {
    svg.append(s('line', {x1: L, x2: W - R, y1: y(ref.value), y2: y(ref.value), class: 'refline'}));
    svg.append(s('text', {x: W - R - 4, y: y(ref.value) - 6, class: 'reflabel', 'text-anchor': 'end'}, ref.label));
  }
}

// ---------- heatmap (weekday × hour) ----------
const RAMP = ['var(--q1)', 'var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q6)', 'var(--q7)'];
export function heatmap(el, {rows, cols, values, fmt = compact, note}) {
  const max = Math.max(0, ...values.flat());
  if (!max) { fill(el, h('div', {class: 'empty'}, 'No activity')); return; }
  const W = width(el), L = 34, T = 4, B = 22, cell = Math.max(10, (W - L) / cols.length), ch = Math.min(30, Math.max(14, cell * .8)), H = T + B + rows.length * ch;
  const svg = s('svg', {viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Activity heatmap'});
  fill(el, svg);
  rows.forEach((r, i) => svg.append(s('text', {x: L - 6, y: T + i * ch + ch / 2 + 4, class: 'tick', 'text-anchor': 'end'}, r)));
  cols.forEach((c, j) => { if (j % 3 === 0) svg.append(s('text', {x: L + j * cell + cell / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle'}, c)); });
  values.forEach((row, i) => row.forEach((v, j) => {
    const level = v ? Math.min(RAMP.length - 1, Math.floor(Math.sqrt(v / max) * RAMP.length)) : -1;
    const rect = s('rect', {x: L + j * cell + 1, y: T + i * ch + 1, width: cell - 2, height: ch - 2, rx: 3,
      fill: level < 0 ? 'var(--cell-empty)' : RAMP[level], class: 'cell'});
    rect.addEventListener('pointermove', ev => showTip(ev, `${rows[i]}, ${cols[j]}:00–${cols[j]}:59`, [{label: note || 'tokens', value: fmt(v)}]));
    rect.addEventListener('pointerleave', hideTip);
    svg.append(rect);
  }));
}

// ---------- horizontal bar list (HTML) ----------
export function barList(el, items, {fmt = compact, total, empty = 'No data', max: maxItems = 12, onClick} = {}) {
  if (!items.length) { fill(el, h('div', {class: 'empty'}, empty)); return; }
  const shown = items.slice(0, maxItems), max = Math.max(...shown.map(i => i.value)) || 1;
  const sum = total ?? items.reduce((n, i) => n + i.value, 0);
  fill(el, h('div', {class: 'bars'}, shown.map(it => h(onClick ? 'button' : 'div', {
      class: ['bar-row', onClick && 'clickable'], type: onClick ? 'button' : null, title: it.title || null,
      onclick: onClick ? () => onClick(it) : null},
    h('div', {class: 'bar-label'}, it.color ? h('i', {class: 'swatch', style: {background: it.color}}) : null,
      h('span', {class: 'bar-name'}, it.label), it.sub ? h('span', {class: 'bar-sub'}, it.sub) : null),
    h('div', {class: 'bar-track'}, h('div', {class: 'bar-fill', style: {width: Math.max(.5, 100 * it.value / max) + '%', background: it.color || 'var(--s1)'}})),
    h('div', {class: 'bar-value'}, h('b', {}, fmt(it.value)), h('span', {}, sum ? num(100 * it.value / sum, 1) + '%' : ''))))),
    items.length > maxItems ? h('div', {class: 'muted small more'}, `and another ${items.length - maxItems}`) : null);
}

// ---------- 100% composition bar (HTML) ----------
export function composition(el, parts, fmt = compact) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) { fill(el, h('div', {class: 'empty'}, 'No data')); return; }
  fill(el, 
    h('div', {class: 'stackbar'}, parts.filter(p => p.value > 0).map(p => {
      const seg = h('div', {class: 'seg', style: {flexGrow: p.value, background: p.color}, tabindex: 0});
      seg.addEventListener('pointermove', ev => showTip(ev, p.label, [{color: p.color, label: 'share', value: num(100 * p.value / total, 1) + '%'}, {label: 'tokens', value: fmt(p.value)}], p.note));
      seg.addEventListener('pointerleave', hideTip);
      return seg;
    })),
    h('div', {class: 'stack-legend'}, parts.map(p => h('div', {class: 'stack-item'},
      h('i', {class: 'swatch', style: {background: p.color}}),
      h('div', {}, h('div', {class: 'stack-label'}, p.label), h('div', {class: 'stack-value'}, h('b', {}, num(100 * p.value / total, 1) + '%'), ' · ', fmt(p.value)),
        p.note ? h('div', {class: 'muted small'}, p.note) : null)))));
}

export function legend(items) {
  return h('div', {class: 'legend'}, items.map(i => h('span', {class: 'legend-item'},
    h('i', {class: i.line ? 'swatch line' : 'swatch', style: {background: i.color}}), i.label)));
}

// ---------- tiny inline sparkline (last point emphasised) ----------
export function sparkline(values, {color = 'var(--s1)', width: W = 132, height: H = 34, focus = values.length - 1, base} = {}) {
  const svg = s('svg', {viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'spark', 'aria-hidden': 'true'});
  const vals = values.map(v => v ?? null), known = vals.filter(v => v != null);
  if (!known.length) return svg;
  const max = Math.max(...known, base || 0) || 1, n = vals.length;
  const x = i => n === 1 ? W / 2 : 3 + i * (W - 6) / (n - 1), y = v => H - 3 - v / max * (H - 6);
  if (base) svg.append(s('line', {x1: 0, x2: W, y1: y(base), y2: y(base), class: 'spark-base'}));
  let d = '';
  vals.forEach((v, i) => { if (v != null) d += `${d && vals[i - 1] != null ? 'L' : 'M'}${x(i)},${y(v)}`; });
  svg.append(s('path', {d, stroke: color, class: 'spark-line'}));
  if (vals[focus] != null) svg.append(s('circle', {cx: x(focus), cy: y(vals[focus]), r: 3, fill: color}));
  return svg;
}

// ---------- diverging change bars (HTML): what grew, what shrank ----------
export function deltaBars(el, items, {fmt = compact, max: maxItems = 8, empty = 'No change', onClick} = {}) {
  const shown = items.filter(i => i.delta).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, maxItems);
  if (!shown.length) { fill(el, h('div', {class: 'empty'}, empty)); return; }
  const max = Math.max(...shown.map(i => Math.abs(i.delta))) || 1;
  const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
  fill(el, h('div', {class: 'deltas'}, shown.map(it => h(onClick ? 'button' : 'div', {
      class: ['delta-row', onClick && 'clickable'], type: onClick ? 'button' : null, onclick: onClick ? () => onClick(it) : null, title: it.title || null},
    h('div', {class: 'bar-label'}, it.color ? h('i', {class: 'swatch', style: {background: it.color}}) : null, h('span', {class: 'bar-name'}, it.label)),
    h('div', {class: 'delta-track'},
      h('div', {class: ['delta-fill', it.delta > 0 ? 'pos' : 'neg'], style: {width: (50 * Math.abs(it.delta) / max) + '%', [it.delta > 0 ? 'left' : 'right']: '50%'}})),
    h('div', {class: 'bar-value'}, h('b', {}, sign(it.delta)),
      h('span', {}, it.before ? (it.delta > 0 ? '+' : '') + num(100 * it.delta / it.before) + '%' : 'new'))))));
}

// ---------- session timeline (HTML Gantt with activity bins) ----------
// rows: [{label, sub, color, first, last, bins: number[], value, onClick, title}]
export function timeline(el, {a, b, rows, clock, fmt = compact, nBins, max: maxRows = 14, ticks = []}) {
  if (!rows.length) { fill(el, h('div', {class: 'empty'}, 'No sessions in this period')); return; }
  let showAll = false;
  const draw = () => {
    const shown = showAll ? rows : rows.slice(0, maxRows);
    const peak = Math.max(1, ...shown.flatMap(r => r.bins));
    const pos = t => Math.max(0, Math.min(100, 100 * (t - a) / (b - a)));
    fill(el, h('div', {class: 'timeline'},
      h('div', {class: 'tl-row tl-axis'}, h('div'), h('div', {class: 'tl-track'}, ticks.map(([t, label]) => h('span', {class: 'tl-tick', style: {left: pos(t) + '%'}}, label))), h('div')),
      shown.map(r => {
        const track = h('div', {class: 'tl-track'},
          ticks.map(([t]) => h('i', {class: 'tl-grid', style: {left: pos(t) + '%'}})),
          h('i', {class: 'tl-span', style: {left: pos(r.first) + '%', width: Math.max(.4, pos(r.last) - pos(r.first)) + '%', background: r.color}}),
          r.bins.map((v, k) => v ? h('i', {class: 'tl-bin', style: {left: (100 * k / nBins) + '%', width: (100 / nBins) + '%', background: r.color, opacity: .25 + .75 * Math.sqrt(v / peak)}}) : null));
        const row = h(r.onClick ? 'button' : 'div', {class: ['tl-row', r.onClick && 'clickable'], type: r.onClick ? 'button' : null, onclick: r.onClick || null},
          h('div', {class: 'tl-label'}, h('span', {class: 'bar-name'}, r.label), r.sub ? h('span', {class: 'tl-sub'}, r.sub) : null),
          track, h('div', {class: 'bar-value'}, h('b', {}, fmt(r.value)), r.share != null ? h('span', {}, num(r.share * 100, 1) + '%') : null));
        row.addEventListener('pointermove', ev => showTip(ev, r.label, r.tip || [], `${clock.dateTime(r.first)} → ${clock.dateTime(r.last)}`));
        row.addEventListener('pointerleave', hideTip);
        return row;
      }),
      rows.length > maxRows ? h('button', {type: 'button', class: 'ghost small more', onclick: () => { showAll = !showAll; draw(); }},
        showAll ? 'Show fewer' : `Show all ${rows.length} sessions`) : null));
  };
  draw();
}

// ---------- heat table (HTML): two dimensions, totals on the margins ----------
// cell(r, c) → {value, text, sub?, level (0..1) | tone (-1..1), title?}
export function heatTable(el, {rows, cols, cell, rowTotal, colTotal, corner = '', onCell, empty = 'No data'}) {
  if (!rows.length || !cols.length) { fill(el, h('div', {class: 'empty'}, empty)); return; }
  const shade = x => x.tone != null
    ? `color-mix(in srgb, ${x.tone < 0 ? 'var(--s2)' : 'var(--s1)'} ${Math.round(Math.min(1, Math.abs(x.tone)) * 70)}%, var(--surface))`
    : x.level ? `color-mix(in srgb, var(--s1) ${Math.round(8 + 64 * Math.min(1, x.level))}%, var(--surface))` : null;
  const ink = x => (x.tone != null ? Math.abs(x.tone) : x.level || 0) > .62 ? 'var(--on-strong)' : null;
  fill(el, h('div', {class: 'scroll heat-scroll'}, h('table', {class: 'heat'},
    h('thead', {}, h('tr', {}, h('th', {}, corner), cols.map(c => h('th', {class: 'num', title: c.title || null}, c.label)), rowTotal ? h('th', {class: 'num total'}, 'Total') : null)),
    h('tbody', {}, rows.map(r => h('tr', {},
      h('th', {scope: 'row', class: 'heat-row'}, r.color ? h('i', {class: 'swatch', style: {background: r.color}}) : null, h('span', {}, r.label)),
      cols.map(c => {
        const x = cell(r, c);
        if (!x || x.value == null) return h('td', {class: 'num heat-empty'}, '·');
        const td = h('td', {class: ['num', onCell && 'clickable'], style: {background: shade(x), color: ink(x)}, tabindex: onCell ? 0 : null,
          onclick: onCell ? () => onCell(r, c, x) : null}, x.text, x.sub ? h('span', {class: 'heat-sub'}, x.sub) : null);
        if (x.tip) { td.addEventListener('pointermove', ev => showTip(ev, x.tip.title, x.tip.rows, x.tip.note)); td.addEventListener('pointerleave', hideTip); }
        return td;
      }),
      rowTotal ? h('td', {class: 'num total'}, rowTotal(r)) : null))),
    colTotal ? h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), cols.map(c => h('td', {class: 'num total'}, colTotal(c))), rowTotal ? h('td', {class: 'num total'}, rowTotal(null)) : null)) : null)));
}

// ---------- scatter on a time axis with optional trend lines and shaded bands ----------
// points: [{t, v, color, faded, title, rows, note, data}], trends: [{color, pts: [[t, v]], label}], bands: [{a, b, label, cls}]
export function timeScatter(el, {points, trends = [], bands = [], a, b, clock, fmt = compact, height = 300, onClick, emptyText}) {
  if (!points.length) { fill(el, h('div', {class: 'empty'}, emptyText || 'No data')); return; }
  const {svg, W, H} = frame(el, height, 'Scatter chart');
  const L = 64, R = 14, T = 18, B = 30;
  const ticks = niceTicks(Math.max(...points.map(p => p.v), ...trends.flatMap(t => t.pts.map(p => p[1])))), top = ticks[ticks.length - 1];
  const X = t => L + (t - a) / (b - a) * (W - L - R), y = v => H - B - v / top * (H - T - B);
  for (const band of bands) {
    const x0 = X(Math.max(a, band.a)), x1 = X(Math.min(b, band.b));
    if (x1 <= x0) continue;
    svg.append(s('rect', {x: x0, y: T, width: x1 - x0, height: H - T - B, class: ['band', band.cls]}));
    svg.append(s('text', {x: x0 + 6, y: T + 2, class: 'band-label'}, band.label));
  }
  yAxis(svg, ticks, y, L, R, W, fmt);
  timeAxis(svg, a, b, clock, X, L, R, W, H, B);
  for (const tr of trends) {
    if (tr.pts.length < 2) continue;
    svg.append(s('path', {d: tr.pts.map(([t, v], k) => `${k ? 'L' : 'M'}${X(t)},${y(v)}`).join(''), stroke: tr.color, class: 'line trend'}));
  }
  for (const p of points) {
    const dot = s('circle', {cx: X(p.t), cy: y(p.v), r: p.r || 4.5, fill: p.color, class: ['pt', p.faded && 'faded']});
    dot.addEventListener('pointermove', ev => { dot.classList.add('hover'); showTip(ev, p.title, p.rows || [], p.note); });
    dot.addEventListener('pointerleave', () => { dot.classList.remove('hover'); hideTip(); });
    if (onClick) { dot.style.cursor = 'pointer'; dot.addEventListener('click', () => onClick(p)); }
    svg.append(dot);
  }
}

// ---------- waterfall (SVG): start → contributions → end ----------
// steps: [{label, value, kind: 'total' | 'delta', note}]
export function waterfall(el, steps, {fmt = compact, height = 240} = {}) {
  if (!steps.length) { fill(el, h('div', {class: 'empty'}, 'No data')); return; }
  const {svg, W, H} = frame(el, height, 'Waterfall chart');
  const L = 64, R = 12, T = 18, B = 34;
  let run = 0;
  const bars = steps.map(st => {
    if (st.kind === 'total') { run = st.value; return {...st, from: 0, to: st.value}; }
    const from = run; run += st.value; return {...st, from, to: run};
  });
  const ticks = niceTicks(Math.max(...bars.map(b => Math.max(b.from, b.to)))), top = ticks[ticks.length - 1];
  const y = v => H - B - v / top * (H - T - B);
  yAxis(svg, ticks, y, L, R, W, fmt);
  const band = (W - L - R) / bars.length, cw = Math.min(96, band * .56);
  bars.forEach((bar, i) => {
    const cx = L + band * (i + .5), x = cx - cw / 2, y0 = y(Math.min(bar.from, bar.to)), y1 = y(Math.max(bar.from, bar.to));
    const cls = bar.kind === 'total' ? 'wf-total' : bar.value >= 0 ? 'wf-up' : 'wf-down';
    const rect = s('rect', {x, y: y1, width: cw, height: Math.max(1.5, y0 - y1), rx: 3, class: ['wf', cls]});
    svg.append(rect);
    if (i < bars.length - 1) svg.append(s('line', {x1: x + cw, x2: x + band, y1: y(bar.to), y2: y(bar.to), class: 'wf-link'}));
    const text = bar.kind === 'total' ? fmt(bar.value) : (bar.value >= 0 ? '+' : '−') + fmt(Math.abs(bar.value));
    svg.append(s('text', {x: cx, y: y1 - 6, class: 'reflabel', 'text-anchor': 'middle'}, text));
    svg.append(s('text', {x: cx, y: H - B + 20, class: 'tick', 'text-anchor': 'middle'}, bar.label));
    rect.addEventListener('pointermove', ev => showTip(ev, bar.label, [{label: bar.kind === 'total' ? 'total' : 'contribution', value: text}], bar.note));
    rect.addEventListener('pointerleave', hideTip);
  });
}

// ---------- trajectories: one line per series over a step index ----------
// series: [{key, label, color, values: [number|null], marks: [step index], rows: i => tooltip rows}]
// focus: key drawn on top in colour; the rest are thin neutral lines. refs: [{value, label}] horizontal guides.
export function trajectories(el, {series, focus, fmt = compact, height = 300, yMax, refs = [], xLabel = 'response', onClick, emptyText}) {
  const all = series.flatMap(sr => sr.values.filter(v => v != null));
  if (!all.length) { fill(el, h('div', {class: 'empty'}, emptyText || 'No data')); return; }
  const {svg, W, H} = frame(el, height, 'Trajectory chart');
  const L = 64, R = 16, T = 14, B = 30;
  const n = Math.max(2, ...series.map(sr => sr.values.length));
  const ticks = niceTicks(Math.max(yMax || 0, ...all)), top = ticks[ticks.length - 1];
  const y = v => H - B - v / top * (H - T - B), x = i => L + i / (n - 1) * (W - L - R);
  yAxis(svg, ticks, y, L, R, W, fmt);
  for (const v of niceTicks(n - 1, Math.max(2, Math.floor((W - L - R) / 90)))) {
    if (v > n - 1) continue;
    svg.append(s('text', {x: x(v), y: H - B + 18, class: 'tick', 'text-anchor': 'middle'}, num(v + 1)));
  }
  for (const ref of refs) {
    svg.append(s('line', {x1: L, x2: W - R, y1: y(ref.value), y2: y(ref.value), class: 'refline dashed'}));
    svg.append(s('text', {x: L + 6, y: y(ref.value) - 6, class: 'reflabel'}, ref.label));
  }
  const pathOf = values => {
    let d = '', pen = false;
    values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const paths = new Map();
  const ordered = [...series.filter(sr => sr.key !== focus), ...series.filter(sr => sr.key === focus)];
  for (const sr of ordered) {
    const on = sr.key === focus;
    const p = s('path', {d: pathOf(sr.values), class: ['line', 'traj', on && 'on'], style: on ? {stroke: sr.color} : null});
    svg.append(p); paths.set(sr.key, p);
    if (on) for (const i of sr.marks || []) {
      if (sr.values[i] == null) continue;
      svg.append(s('line', {x1: x(i), x2: x(i), y1: y(sr.values[i - 1] ?? sr.values[i]), y2: y(sr.values[i]), class: 'traj-drop'}));
      svg.append(s('circle', {cx: x(i), cy: y(sr.values[i]), r: 4, class: 'traj-mark'}));
    }
  }
  const cross = s('line', {y1: T, y2: H - B, class: 'cross'});
  svg.append(cross);
  const hit = s('rect', {x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit'});
  let hover = null;
  const nearest = ev => {
    const box = svg.getBoundingClientRect(), px = (ev.clientX - box.left) * W / box.width, py = (ev.clientY - box.top) * H / box.height;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / (W - L - R) * (n - 1))));
    let best = null, dist = Infinity;
    for (const sr of series) { const v = sr.values[i]; if (v == null) continue; const d = Math.abs(y(v) - py); if (d < dist) { dist = d; best = sr; } }
    return {i, sr: dist < 40 ? best : null};
  };
  hit.addEventListener('pointermove', ev => {
    const {i, sr} = nearest(ev);
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.add('on');
    if (hover && hover !== sr) paths.get(hover.key)?.classList.remove('hover');
    hover = sr;
    if (!sr) { hideTip(); hit.style.cursor = ''; return; }
    paths.get(sr.key)?.classList.add('hover');
    hit.style.cursor = onClick ? 'pointer' : '';
    showTip(ev, sr.label, [{label: 'context', value: fmt(sr.values[i])}, ...(sr.rows ? sr.rows(i) : [])], `${xLabel} ${num(i + 1)} of ${num(sr.values.length)}`);
  });
  hit.addEventListener('pointerleave', () => { cross.classList.remove('on'); if (hover) paths.get(hover.key)?.classList.remove('hover'); hover = null; hideTip(); });
  if (onClick) hit.addEventListener('click', ev => { const {sr} = nearest(ev); if (sr) onClick(sr); });
  svg.append(hit);
}
