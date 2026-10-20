// Focus pages: task-oriented investigations that combine several metrics into one answer.
// review — how a day / week / month went compared with earlier ones;
// watch — whether observed quota capacity changed, per model;
// anatomy — what the spend is made of (model × context size × project …) and what drove a change.
import {locales, h, num, compact, pct, share, duration, plural, median, quantile, mannWhitney, projectName, projectKey} from './util.js';
import {columns, lines, timeline, deltaBars, heatTable, timeScatter, waterfall, sparkline, barList, composition, legend} from './charts.js';
import {ctx, state, saveState, view, sum, sessionStats, eventsBetween, period, periodStart, periodShift, unitNames, quotaBurn,
  CONTEXT_BUCKETS, contextBucket, granularity, bucketer, buckets, card, tile, chartBox, segmented, select, table, color, modelName, modelDot,
  metricLabel, sessionKind, info, icon} from './core.js';
import {sessionDetail, sessionTitle, windowDetail, toggleProject, toggleModel} from './pages.js';
import {contextLine} from './context.js';

const fmtMetric = v => state.metric === 'responses' ? num(v) : compact(v);
const signed = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), digits);
const change = (now, before) => before ? now / before - 1 : NaN;
const changeText = x => Number.isFinite(x) ? signed(x * 100, Math.abs(x) < .1 ? 1 : 0) + '%' : 'n/a';

function rootIndex(i) {
  const D = ctx.D;
  let k = i, sess = D.sessions[i];
  for (let guard = 0; sess?.parent && guard < 6; guard++) {
    const p = D.sessionIndex.get(sess.parent);
    if (p == null) break;
    k = p; sess = D.sessions[p];
  }
  return k;
}

function quotaKeys() {
  const keys = ctx.D.quotaKeys;
  return {five: keys.find(k => k.endsWith('|300')), week: keys.find(k => k.endsWith('|10080'))};
}

// ======================================================================
// Period review
// ======================================================================
const HISTORY = {day: 14, week: 12, month: 12};
const BINS = {day: 48, week: 84};

export function review() {
  const D = ctx.D, c = ctx.clock, mi = D.mi[state.metric], R = state.review, unit = R.unit;
  const today = c.today(), now = Date.now() / 1000;
  const currentStart = periodStart(unit, today);
  const startDay = Math.min(currentStart, periodStart(unit, R.at ? c.fromIso(R.at) : today));
  const P = period(unit, startDay), PP = period(unit, periodShift(unit, startDay, -1));
  const isCurrent = startDay === currentStart;
  const go = day => { R.at = day === currentStart ? null : c.iso(day); saveState(); ctx.render(); };
  ctx.keys = e => {
    if (e.key === 'ArrowLeft') go(periodShift(unit, startDay, -1));
    else if (e.key === 'ArrowRight' && !isCurrent) go(periodShift(unit, startDay, 1));
  };
  ctx.bar = h('div', {class: 'bar-group'},
    segmented(Object.entries(unitNames), unit, u => { R.unit = u; saveState(); ctx.render(); }, {label: 'Period length', class: 'small'}),
    h('div', {class: 'stepper'},
      h('button', {type: 'button', class: 'ghost small', title: `Previous ${unit} (←)`, 'aria-label': `Previous ${unit}`, onclick: () => go(periodShift(unit, startDay, -1))}, '‹'),
      h('span', {class: 'stepper-label'}, P.label),
      h('button', {type: 'button', class: 'ghost small', title: `Next ${unit} (→)`, 'aria-label': `Next ${unit}`, disabled: isCurrent, onclick: () => go(periodShift(unit, startDay, 1))}, '›')),
    isCurrent ? null : h('button', {type: 'button', class: 'ghost small', onclick: () => go(currentStart)}, `This ${unit}`));

  // Earlier periods for comparison; when browsing the past, show a few periods after it too.
  const after = Math.min(3, Math.round((currentStart - startDay) / (unit === 'month' ? 30 : unit === 'week' ? 7 : 1)));
  const first = periodShift(unit, startDay, -(HISTORY[unit] - 1 - after));
  const periods = Array.from({length: HISTORY[unit]}, (_, i) => period(unit, periodShift(unit, first, i)))
    .filter(p => D.firstTs == null || p.b > D.firstTs - 86400 * 40);
  const hist = eventsBetween(periods[0].a, periods[periods.length - 1].b);
  const keyOf = ts => periodStart(unit, c.day(ts));
  const perPeriod = new Map(periods.map(p => [p.key, {}]));
  for (const e of hist) {
    const row = perPeriod.get(keyOf(e[0]));
    if (row) { const m = D.models[e[1]]; row[m] = (row[m] || 0) + (e[5][mi] || 0); }
  }
  const totalOf = key => Object.values(perPeriod.get(key) || {}).reduce((a, b) => a + b, 0);

  const events = hist.filter(e => e[0] >= P.a && e[0] < P.b);
  // An unfinished period is compared with the previous one at the same elapsed point.
  const elapsed = isCurrent ? Math.max(1, now - P.a) : P.b - P.a;
  const prevEvents = eventsBetween(PP.a, isCurrent ? Math.min(PP.b, PP.a + elapsed) : PP.b);
  const total = sum(events, mi), prev = sum(prevEvents, mi);
  const earlier = periods.filter(p => p.key < startDay && p.a >= (D.firstTs ?? 0) - (p.b - p.a)).map(p => totalOf(p.key));
  const avg = earlier.length ? earlier.reduce((a, b) => a + b, 0) / earlier.length : 0;
  const projected = isCurrent && elapsed > 3600 ? total * (P.b - P.a) / elapsed : null;

  const {five, week} = quotaKeys();
  const burn = k => k ? quotaBurn(k, P.a, P.b) : null;
  const prevBurn = k => k ? quotaBurn(k, PP.a, isCurrent ? Math.min(PP.b, PP.a + elapsed) : PP.b) : null;
  const q5 = burn(five), q5p = prevBurn(five), qw = burn(week), qwp = prevBurn(week);

  const hours = new Set(events.map(e => c.hourStart(e[0]))).size, prevHours = new Set(prevEvents.map(e => c.hourStart(e[0]))).size;
  const roots = new Map();
  for (const e of events) {
    const k = rootIndex(e[3]);
    let r = roots.get(k);
    if (!r) roots.set(k, r = {index: k, value: 0, total: 0, responses: 0, first: e[0], last: e[0], models: new Map(), subs: new Set(), bins: null});
    const v = e[5][mi] || 0;
    r.value += v; r.total += e[5][D.mi.total_tokens] || 0; r.responses++; r.last = e[0];
    r.models.set(e[1], (r.models.get(e[1]) || 0) + v);
    if (k !== e[3]) r.subs.add(e[3]);
  }
  const vsLabel = isCurrent ? `vs same point last ${unit}` : `vs previous ${unit}`;

  // ---------- headline ----------
  const quotaLine = (name, q, qp, k) => q && k ? h('li', {},
    h('b', {}, num(q.burn) + '%'), ` of the ${name} quota burned`,
    q.minutes === 300 && q.burn ? h('span', {class: 'muted'}, ` (≈ ${num(q.burn / 100, 1)} full windows)`) : null,
    qp?.burn ? h('span', {class: 'muted'}, ` · ${changeText(change(q.burn, qp.burn))} ${vsLabel}`) : null,
    q.full ? h('span', {class: 'muted'}, ` · ${q.full} ${plural(q.full, 'window', 'windows')} hit 100%`) : null) : null;
  const headline = card(null, {class: 'headline'},
    h('div', {class: 'headline-body'},
      h('div', {class: 'headline-text'},
        h('div', {class: 'eyebrow'}, `${unitNames[unit]} · ${P.label}`, isCurrent ? h('span', {class: 'live'}, 'in progress') : null),
        h('p', {class: 'lede'},
          h('b', {}, fmtMetric(total)), ` ${metricLabel(state.metric).toLowerCase()}`,
          prev ? [' — ', h('b', {class: total >= prev ? 'up' : 'down'}, changeText(change(total, prev))), ` ${vsLabel}`] : null,
          avg ? [', ', h('b', {}, changeText(change(isCurrent && projected ? projected : total, avg))), ` vs the ${earlier.length}-${unit} average`, isCurrent && projected ? ' (projected)' : ''] : null, '.'),
        h('ul', {class: 'facts'},
          quotaLine('five-hour', q5, q5p, five), quotaLine('weekly', qw, qwp, week),
          q5?.locked || qw?.locked ? h('li', {}, h('b', {}, duration((q5?.locked || 0) + (qw?.locked || 0))), ' spent at a usage limit') : null,
          projected ? h('li', {}, 'On pace for ', h('b', {}, fmtMetric(projected)), ` by the end of the ${unit}`) : null,
          roots.size ? h('li', {}, h('b', {}, num(roots.size)), ` ${plural(roots.size, 'session', 'sessions')} across `, h('b', {}, num(hours)), ` active ${plural(hours, 'hour', 'hours')}`) : null)),
      h('div', {class: 'headline-spark'},
        sparkline(periods.map(p => totalOf(p.key)), {focus: periods.findIndex(p => p.key === startDay), base: avg, width: 180, height: 56}),
        h('div', {class: 'muted small'}, `last ${periods.length} ${unit}s`))));

  const tiles = h('div', {class: 'tiles'},
    tile(metricLabel(state.metric), fmtMetric(total), null, {delta: change(total, prev), deltaNote: vsLabel, class: 'hero'}),
    five ? tile('Five-hour quota burned', num(q5.burn) + '%', `${q5.started} ${plural(q5.started, 'window', 'windows')} started · ${q5.full} at 100%`, {delta: change(q5.burn, q5p.burn), deltaNote: vsLabel}) : null,
    week ? tile('Weekly quota burned', num(qw.burn) + '%', qw.full ? 'the weekly limit was reached' : 'share of one full weekly quota', {delta: change(qw.burn, qwp.burn), deltaNote: vsLabel}) : null,
    tile('Time at a limit', (q5?.locked || qw?.locked) ? duration((q5?.locked || 0) + (qw?.locked || 0)) : '—', 'between hitting 100% and the reset',
      {title: 'Overlapping five-hour and weekly lockouts are added together.'}),
    tile('Active hours', num(hours), `hours with at least one response`, {delta: change(hours, prevHours), deltaNote: vsLabel}),
    tile(`${metricLabel(state.metric)} per active hour`, hours ? fmtMetric(total / hours) : '—', 'intensity while working',
      {delta: change(hours ? total / hours : 0, prevHours ? prev / prevHours : 0), deltaNote: vsLabel}));

  // ---------- past periods ----------
  const measure = (R.measure === 'five' && !five) || (R.measure === 'week' && !week) ? 'tokens' : R.measure;
  let compareChart;
  if (measure === 'tokens') {
    const series = D.models.filter(m => periods.some(p => perPeriod.get(p.key)[m])).map(m => ({key: m, label: m, color: color(m)}));
    compareChart = chartBox(el => columns(el, {buckets: periods, series, values: perPeriod, fmt: fmtMetric, focus: startDay, height: 260,
      ref: avg ? {value: avg, label: `average ${fmtMetric(avg)}`} : null, onClick: b => go(b.key), clickNote: `Click to review this ${unit}`}));
  } else {
    const k = measure === 'five' ? five : week;
    const vals = new Map(periods.map(p => [p.key, {q: quotaBurn(k, p.a, p.b).burn}]));
    const prior = periods.filter(p => p.key < startDay).map(p => vals.get(p.key).q).filter(Boolean);
    const qa = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    compareChart = chartBox(el => columns(el, {buckets: periods, series: [{key: 'q', label: 'quota burned', color: 'var(--s1)'}], values: vals, fmt: v => num(v) + '%',
      focus: startDay, height: 260, ref: qa ? {value: qa, label: `average ${num(qa)}%`} : null, onClick: b => go(b.key), clickNote: `Click to review this ${unit}`}));
  }
  const compareCard = card(`Compared with earlier ${unit}s`, {
    sub: `The highlighted bar is the ${unit} under review; the dashed line is the average of the ${unit}s before it. Click a bar to jump there.`,
    actions: segmented([['tokens', metricLabel(state.metric)], ...(five ? [['five', 'Five-hour quota %']] : []), ...(week ? [['week', 'Weekly quota %']] : [])],
      measure, m => { R.measure = m; saveState(); ctx.render(); }, {class: 'small'})},
  compareChart);

  // ---------- inside the period, against the previous one ----------
  const inner = unit === 'day' ? 'hour' : 'day';
  const bs = buckets({a: P.a, b: P.b, fromDay: P.startDay, toDay: P.endDay - 1}, inner);
  const key = bucketer(inner), values = new Map(), present = new Set();
  for (const e of events) {
    const k = key(e[0]); let row = values.get(k);
    if (!row) values.set(k, row = {});
    const m = D.models[e[1]]; row[m] = (row[m] || 0) + (e[5][mi] || 0); present.add(m);
  }
  const ghost = new Map();
  for (const e of eventsBetween(PP.a, PP.b)) {
    const idx = inner === 'hour' ? Math.floor((e[0] - PP.a) / 3600) : c.day(e[0]) - PP.startDay;
    const b = bs[idx]; if (b) ghost.set(b.key, (ghost.get(b.key) || 0) + (e[5][mi] || 0));
  }
  const innerSeries = D.models.filter(m => present.has(m)).map(m => ({key: m, label: m, color: color(m)}));
  const innerCard = card(`Inside the ${unit}`, {sub: `${metricLabel(state.metric)} by ${inner}, colored by model. Dashed markers show the same ${inner} of the previous ${unit}.`},
    chartBox(el => columns(el, {buckets: bs, series: innerSeries, values, ghost, ghostLabel: `Previous ${unit}`, fmt: fmtMetric, height: 240,
      emptyText: `No activity this ${unit}`})),
    legend([...innerSeries, {label: `previous ${unit}`, color: 'var(--ink-2)', line: true}]));

  // ---------- sessions ----------
  const nBins = BINS[unit] || P.days * 4;
  for (const r of roots.values()) r.bins = Array(nBins).fill(0);
  for (const e of events) {
    const r = roots.get(rootIndex(e[3]));
    r.bins[Math.min(nBins - 1, Math.floor((e[0] - P.a) / (P.b - P.a) * nBins))] += e[5][mi] || 0;
  }
  const rows = [...roots.values()].sort((p, q) => q.value - p.value).map(r => {
    const sess = D.sessions[r.index], main = [...r.models.entries()].sort((p, q) => q[1] - p[1])[0][0];
    return {label: sessionTitle(sess), color: color(D.models[main]), first: r.first, last: r.last, bins: r.bins, value: r.value, share: total ? r.value / total : null,
      sub: [projectName(sess.cwd), sess.branch, r.subs.size ? `+${r.subs.size} ${plural(r.subs.size, 'subagent', 'subagents')}` : null].filter(Boolean).join(' · '),
      onClick: () => sessionDetail(sess.id),
      tip: [{label: metricLabel(state.metric), value: fmtMetric(r.value)}, {label: 'responses', value: num(r.responses)},
        ...[...r.models.entries()].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([m, v]) => ({color: color(D.models[m]), label: D.models[m], value: fmtMetric(v), muted: true}))]};
  });
  const ticks = [];
  if (unit === 'day') for (let t = P.a; t < P.b; t += 3 * 3600) ticks.push([t, c.time(t)]);
  else if (unit === 'week') for (let d = P.startDay; d < P.endDay; d++) ticks.push([c.dayStart(d), c.weekdayDate(c.dayStart(d)).split(/[ ,]/)[0]]);
  else for (let d = P.startDay; d < P.endDay; d += 7) ticks.push([c.dayStart(d), c.date(c.dayStart(d))]);
  const sessionsCard = card('Sessions you worked on', {
    sub: 'Each row is a conversation with its subagents rolled in; the shaded span runs from first to last response and darker cells mark busier stretches. Click a row for details.'},
  chartBox(el => timeline(el, {a: P.a, b: P.b, rows, clock: c, fmt: fmtMetric, nBins, ticks})));

  // ---------- what changed ----------
  const diff = (getKey, label) => {
    const m = new Map();
    for (const e of events) { const k = getKey(e); const x = m.get(k) || {now: 0, before: 0}; x.now += e[5][mi] || 0; m.set(k, x); }
    for (const e of prevEvents) { const k = getKey(e); const x = m.get(k) || {now: 0, before: 0}; x.before += e[5][mi] || 0; m.set(k, x); }
    return [...m.entries()].map(([k, x]) => ({...label(k), key: k, delta: x.now - x.before, before: x.before}));
  };
  const projectOf = e => projectKey(D.sessions[e[3]].cwd);
  const byModelDiff = diff(e => e[1], k => ({label: D.models[k], color: color(D.models[k])}));
  const byProjectDiff = diff(projectOf, k => ({label: k ? projectName(k.startsWith('worktree:') ? '/' + k.slice(9) : k) : 'No directory', title: k}));
  const byContextDiff = diff(e => contextBucket(e[6]), k => ({label: CONTEXT_BUCKETS[k][2] + ' context'}));
  const changed = h('div', {class: 'grid three'},
    card('Change by project', {sub: `${vsLabel} · click to filter`}, chartBox(el => deltaBars(el, byProjectDiff, {fmt: fmtMetric, onClick: it => toggleProject(it.key)}))),
    card('Change by model', {sub: `${vsLabel} · click to filter`}, chartBox(el => deltaBars(el, byModelDiff, {fmt: fmtMetric, onClick: it => toggleModel(D.models[it.key])}))),
    card('Change by context size', {sub: vsLabel}, chartBox(el => deltaBars(el, byContextDiff, {fmt: fmtMetric}))));

  // ---------- how the spend formed ----------
  const inp = sum(events, D.mi.input_tokens), cached = sum(events, D.mi.cached_input_tokens), out = sum(events, D.mi.output_tokens);
  const reasoning = D.mi.reasoning_output_tokens != null ? sum(events, D.mi.reasoning_output_tokens) : 0;
  const allTokens = sum(events, D.mi.total_tokens);
  let big = 0; for (const e of events) if (e[6] >= 128e3) big += e[5][D.mi.total_tokens] || 0;
  const openAnatomy = () => { Object.assign(state.range, {preset: 'custom', from: c.iso(P.startDay), to: c.iso(P.endDay - 1)}); saveState(); ctx.go('anatomy'); };
  const formed = card('How the spend formed', {sub: `${share(big, allTokens, 0)} of all tokens came from responses with at least 128K tokens of context.`,
    actions: h('button', {type: 'button', class: 'link', onclick: openAnatomy}, 'Open in Spend anatomy →')},
  chartBox(el => composition(el, [
    {label: 'Uncached input', value: inp - cached, color: 'var(--c1)'}, {label: 'Cached input', value: cached, color: 'var(--c2)'},
    {label: 'Output: response', value: out - reasoning, color: 'var(--c3)'}, {label: 'Output: reasoning', value: reasoning, color: 'var(--c4)'}])));
  const stats = sessionStats(events, mi), projects = new Map();
  for (const st of stats.values()) {
    const k = projectKey(st.session.cwd); const p = projects.get(k) || {key: k, label: projectName(st.session.cwd), value: 0};
    p.value += st.value; projects.set(k, p);
  }
  const projCard = card('Projects', {sub: 'Click a project to filter every page to it'},
    chartBox(el => barList(el, [...projects.values()].sort((p, q) => q.value - p.value), {fmt: fmtMetric, max: 8, onClick: it => toggleProject(it.key)})));

  return [headline, tiles, compareCard, innerCard, sessionsCard, changed, h('div', {class: 'grid'}, formed, projCard)];
}

// ======================================================================
// Quota watch
// ======================================================================
function basisValue(w) {
  const k = state.metric;
  return (w.metrics[k] || 0) + (state.internal ? (w.internal_metrics[k] || 0) : 0);
}
function sampleValue(w, sample) {
  if (sample === 'cap') return !w.exclusion && w.max_used >= state.quota.threshold ? basisValue(w) : null;
  const used = w.max_used - w.first_used;
  if (used < 10 || w.exclusion_code === 'too_long' || w.exclusion_code === 'no_usage') return null;
  const v = basisValue(w);
  return v ? v / used : null;
}

const pText = p => p < .001 ? 'p < 0.001' : `p = ${num(p, p < .01 ? 3 : 2)}`;
const MIXED = new Set(['__all__', '__mixed__']);

function verdict(recent, base, model) {
  if (recent.length < 3 || base.length < 3) return {code: 'thin', text: recent.length ? 'Not enough windows' : 'No recent windows', chip: 'neutral'};
  if (MIXED.has(model)) {
    // The model mix inside these windows changes over time, so a shift is not evidence about the quota.
    return {code: 'mixed', text: 'Mixed workload', chip: 'neutral', ratio: median(recent) / median(base) - 1, p: mannWhitney(recent, base).p};
  }
  const ratio = median(recent) / median(base) - 1, {p} = mannWhitney(recent, base);
  if (p < .05 && Math.abs(ratio) >= .08) return ratio < 0 ? {code: 'down', text: 'Capacity decreased', chip: 'bad', ratio, p} : {code: 'up', text: 'Capacity increased', chip: 'ok', ratio, p};
  if (p < .2 && Math.abs(ratio) >= .08) return {code: 'maybe', text: 'Possible change', chip: 'warn', ratio, p};
  return {code: 'stable', text: 'No clear change', chip: 'neutral', ratio, p};
}

// Shared by the page and the overview launcher.
function watchStats(qkey, sample) {
  const D = ctx.D, W = state.watch, now = Date.now() / 1000;
  const [limitId, minutes] = qkey.split('|');
  const recentA = now - W.recent * 86400, baseA = W.baseline ? recentA - W.baseline * 86400 : -Infinity;
  const all = D.windows.filter(w => w.limit_id === limitId && w.minutes === Number(minutes))
    .map(w => ({w, v: sampleValue(w, sample)})).filter(x => x.v != null);
  const groups = new Map([['__all__', []]]);
  for (const x of all) {
    groups.get('__all__').push(x);
    if (!groups.has(x.w.classification)) groups.set(x.w.classification, []);
    groups.get(x.w.classification).push(x);
  }
  const out = [...groups.entries()].map(([model, xs]) => {
    const recent = xs.filter(x => x.w.start >= recentA).map(x => x.v), base = xs.filter(x => x.w.start >= baseA && x.w.start < recentA).map(x => x.v);
    return {model, xs, recent, base, last: Math.max(...xs.map(x => x.w.start)), v: verdict(recent, base, model)};
  }).filter(g => g.xs.length);
  return {groups: out, recentA, baseA, now, all, minutes: Number(minutes)};
}

const groupName = m => m === '__all__' ? 'All windows' : modelName(m);
const groupColor = m => m === '__all__' ? 'var(--ink-2)' : color(m);

export function watch() {
  const D = ctx.D, c = ctx.clock, W = state.watch;
  if (!D.quotaKeys.length) return [card('Quota watch', {}, h('div', {class: 'empty'}, 'No quota snapshots in the history of this profile.'))];
  let qkey = W.key;
  if (!D.quotaKeys.includes(qkey)) qkey = D.quotaKeys.find(k => k.endsWith('|300')) || D.quotaKeys[0];
  const set = patch => { Object.assign(W, patch); saveState(); ctx.render(); };
  const sample = W.sample;
  const unitLabel = sample === 'cap' ? 'per exhausted window' : 'per 1% of quota';
  ctx.bar = h('div', {class: 'bar-group'},
    segmented(D.quotaKeys.map(k => [k, Number(k.split('|')[1]) === 300 ? '5-hour' : Number(k.split('|')[1]) === 10080 ? 'Weekly' : k]), qkey, k => set({key: k}), {class: 'small', label: 'Counter'}),
    segmented([['per', 'Per 1%'], ['cap', 'Per full window']], sample, v => set({sample: v}), {class: 'small', label: 'Measure'}),
    h('label', {class: 'inline-field'}, h('span', {}, 'Recent'), select([[7, '7 days'], [14, '14 days'], [30, '30 days']], W.recent, v => set({recent: Number(v)}))),
    h('label', {class: 'inline-field'}, h('span', {}, 'vs'), select([[30, 'previous 30 days'], [60, 'previous 60 days'], [0, 'all earlier']], W.baseline, v => set({baseline: Number(v)}))));

  const st = watchStats(qkey, sample);
  const {groups, recentA, baseA, now, minutes} = st;
  const qname = minutes === 300 ? 'five-hour' : minutes === 10080 ? 'weekly' : 'quota';
  const fmtV = v => compact(v);
  const real = groups.filter(g => g.model !== '__all__');
  const lead = real.filter(g => g.model !== '__mixed__').sort((p, q) => q.recent.length - p.recent.length)[0] || groups[0];

  // ---------- headline ----------
  const say = g => {
    if (!g) return 'No quota windows with enough usage were recorded.';
    const v = g.v;
    if (!g.recent.length) return `No ${qname} windows with enough usage in the last ${W.recent} days. Choose a longer Recent range to compare.`;
    if (v.code === 'thin') return `Not enough recent ${qname} windows for ${groupName(g.model)} to compare (${g.recent.length} recent, ${g.base.length} baseline).`;
    const what = `${groupName(g.model)}: ${compact(median(g.recent))} ${metricLabel(state.metric).toLowerCase()} ${unitLabel} in the last ${W.recent} days vs ${compact(median(g.base))} before`;
    return `${what} (${changeText(v.ratio)}, ${pText(v.p)}).`;
  };
  const flagged = real.filter(g => g.v.code === 'down' || g.v.code === 'up' || g.v.code === 'maybe');
  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'},
    h('div', {class: 'headline-text'},
      h('div', {class: 'eyebrow'}, `${minutes === 300 ? 'Five-hour' : 'Weekly'} quota · last ${W.recent} days vs ${W.baseline ? `the ${W.baseline} days before` : 'all earlier history'}`),
      h('p', {class: 'lede'}, flagged.length
        ? [h('b', {}, `${flagged.length} ${plural(flagged.length, 'model shows', 'models show')} a capacity shift. `), say(flagged[0])]
        : [h('b', {}, 'No clear capacity change. '), say(lead)]),
      h('p', {class: 'muted small'}, 'Comparisons stay within one model, because models draw on the quota at different rates. Mann–Whitney test on individual windows; p < 0.05 with at least an 8% shift counts as a change.'))));

  // ---------- verdict cards ----------
  const weeks = [];
  for (let d = periodStart('week', c.day(now)) - 7 * 11; d <= c.day(now); d += 7) weeks.push(period('week', d));
  const weekly = g => weeks.map(p => { const v = g.xs.filter(x => x.w.start >= p.a && x.w.start < p.b).map(x => x.v); return v.length ? median(v) : null; });
  const ordered = [...real].sort((p, q) => (q.recent.length > 0) - (p.recent.length > 0) || MIXED.has(p.model) - MIXED.has(q.model) || q.xs.length - p.xs.length);
  const verdictCards = h('div', {class: 'verdicts'}, [...ordered, groups.find(g => g.model === '__all__')].filter(Boolean)
    .sort((p, q) => (q.recent.length > 0) - (p.recent.length > 0) || MIXED.has(p.model) - MIXED.has(q.model)).map(g => {
    const v = g.v;
    return h('div', {class: ['verdict', v.code]},
      h('div', {class: 'verdict-top'}, g.model === '__all__' ? h('span', {class: 'model'}, h('i', {class: 'swatch', style: {background: groupColor(g.model)}}), 'All windows · mixed workload') : modelDot(g.model),
        h('span', {class: ['chip', v.chip]}, v.text)),
      h('div', {class: 'verdict-main'},
        h('div', {}, h('div', {class: 'verdict-value'}, v.ratio != null ? changeText(v.ratio) : '—'),
          h('div', {class: 'muted small'}, g.recent.length && g.base.length ? `${fmtV(median(g.base))} → ${fmtV(median(g.recent))} ${unitLabel}`
            : g.recent.length ? `${fmtV(median(g.recent))} ${unitLabel}` : `${g.xs.length} ${plural(g.xs.length, 'window', 'windows')} · last ${c.date(g.last)}`)),
        sparkline(weekly(g), {color: groupColor(g.model), width: 120, height: 40})),
      h('div', {class: 'verdict-foot muted small'}, `${g.recent.length} recent · ${g.base.length} baseline`, v.p != null ? ` · ${pText(v.p)}` : '',
        v.code === 'mixed' ? ' · compare single models instead' : ''));
  }));

  // ---------- scatter over time ----------
  const firstStart = Math.min(...st.all.map(x => x.w.start));
  const a = Math.max(firstStart - 86400, W.baseline ? baseA - 86400 * 3 : firstStart - 86400), b = now + 3600 * 6;
  const shown = st.all.filter(x => x.w.start >= a);
  const points = shown.map(({w, v}) => ({t: w.start, v, color: color(w.classification), w,
    faded: w.start < (Number.isFinite(baseA) ? baseA : -Infinity),
    title: `${c.dateTime(w.start)} · ${modelName(w.classification)}`,
    rows: [{label: unitLabel, value: fmtV(v)}, {label: 'usage', value: `${num(w.first_used)}% → ${num(w.max_used)}%`},
      {label: metricLabel(state.metric), value: compact(basisValue(w))}, {label: 'cache share', value: share(w.metrics.cached_input_tokens || 0, w.metrics.input_tokens || 0, 0)}],
    note: 'Click for the window breakdown'}));
  const trends = ordered.filter(g => g.xs.length >= 6 && !MIXED.has(g.model)).map(g => {
    const xs = g.xs.filter(x => x.w.start >= a).sort((p, q) => p.w.start - q.w.start);
    return {color: color(g.model), pts: xs.map((x, i) => [x.w.start, median(xs.slice(Math.max(0, i - 3), i + 4).map(y => y.v))])};
  });
  const bands = [
    Number.isFinite(baseA) ? {a: baseA, b: recentA, label: 'baseline', cls: 'base'} : {a, b: recentA, label: 'baseline', cls: 'base'},
    {a: recentA, b: now, label: 'recent', cls: 'recent'}];
  const present = [...new Set(shown.map(x => x.w.classification))];
  const scatterCard = card(`Every ${qname} window`, {
    sub: `Each dot is one window: ${metricLabel(state.metric).toLowerCase()} ${unitLabel}. Lines are rolling medians per model. A step down that persists across many windows is what a stricter quota would look like.`},
  chartBox(el => timeScatter(el, {points, trends, bands, a, b, clock: c, fmt: fmtV, height: 320, onClick: p => windowDetail(p.w)})),
  legend(present.map(m => ({label: modelName(m), color: color(m)}))));

  // ---------- model × week matrix ----------
  const ref = new Map(real.map(g => [g.model, median((g.base.length ? g.base : g.xs.map(x => x.v)))]));
  const matrix = card('Model × week', {sub: `Median ${unitLabel} per week. Blue cells are above that model's baseline median, orange cells below; small numbers are window counts.`},
    chartBox(el => heatTable(el, {rows: ordered.map(g => ({key: g.model, label: modelName(g.model), color: color(g.model), g})), cols: weeks.map(p => ({key: p.key, label: c.date(p.a), title: p.label, p})),
      corner: 'Model', cell: (r, col) => {
        const vs = r.g.xs.filter(x => x.w.start >= col.p.a && x.w.start < col.p.b).map(x => x.v);
        if (!vs.length) return null;
        const m = median(vs), base = ref.get(r.key);
        return {value: m, text: fmtV(m), sub: vs.length, tone: base && !MIXED.has(r.key) ? (m / base - 1) / .3 : null,
          tip: {title: `${r.label} · ${col.p.label}`, rows: [{label: 'median', value: fmtV(m)}, {label: 'windows', value: num(vs.length)},
            {label: 'vs baseline', value: base ? changeText(m / base - 1) : '—'}, {label: 'range', value: `${fmtV(Math.min(...vs))} – ${fmtV(Math.max(...vs))}`}]}};
      }})));

  // ---------- weekly vs five-hour ----------
  const {five, week} = quotaKeys();
  let ratioCard = null;
  if (five && week && sample === 'per') {
    const fives = D.windows.filter(w => w.minutes === 300).map(w => ({w, v: sampleValue(w, 'per')})).filter(x => x.v != null);
    const weeksW = D.windows.filter(w => w.minutes === 10080).map(w => ({w, v: sampleValue(w, 'per')})).filter(x => x.v != null);
    const rowsR = weeksW.map(({w, v}) => {
      const inside = fives.filter(x => x.w.start >= w.start && x.w.start < w.end).map(x => x.v);
      return inside.length >= 2 ? {w, ratio: v / median(inside), n: inside.length} : null;
    }).filter(Boolean);
    if (rowsR.length) {
      const labels = rowsR.map(r => ({label: `Week from ${c.dateY(r.w.start)}`, short: c.date(r.w.start), note: `${r.n} five-hour windows inside · ${modelName(r.w.classification)}`}));
      const latest = rowsR[rowsR.length - 1].ratio, firstR = rowsR[0].ratio;
      ratioCard = card('How many five-hour windows fit in a week', {
        sub: `Tokens per 1% of the weekly quota ÷ tokens per 1% of the five-hour quota, measured inside each weekly window. Latest: ${num(latest, 1)} windows${rowsR.length > 1 ? `; first observed: ${num(firstR, 1)}` : ''}. A change here means OpenAI moved one limit relative to the other.`},
      chartBox(el => lines(el, {labels, series: [{key: 'r', label: 'five-hour windows per week', color: 'var(--s3)', values: rowsR.map(r => r.ratio)}], fmt: v => num(v, 1), height: 220})));
    }
  }

  // ---------- context: things that moved at the same time ----------
  if (!D.modelFirst) {
    D.modelFirst = new Map();
    for (const e of D.events) if (!D.modelFirst.has(e[1])) D.modelFirst.set(e[1], e[0]);
  }
  const [limitId] = qkey.split('|');
  const notes = [
    ...[...D.modelFirst.entries()].filter(([, t]) => t >= a).map(([m, t]) => ({t, kind: 'model', text: `First response from ${D.models[m]}`, color: color(D.models[m])})),
    ...D.resets.filter(r => r.early && r.ts >= a && r.limit_id === limitId && r.minutes === minutes).map(r => ({t: r.ts, kind: 'reset', text: `Early ${qname} reset at ${num(r.used_before)}%`})),
  ].sort((p, q) => q.t - p.t).slice(0, 14);
  const notesCard = card('Things that changed at the same time', {sub: 'New models and early resets in the charted range often explain a step in capacity.'},
    notes.length ? h('ul', {class: 'notes'}, notes.map(n => h('li', {},
      h('span', {class: 'muted small mono'}, c.dateTime(n.t)), n.color ? h('i', {class: 'swatch', style: {background: n.color}}) : h('span', {class: 'chip warn'}, 'reset'), n.text)))
      : h('div', {class: 'empty'}, 'Nothing notable in this range'));

  // ---------- token mix of sampled windows ----------
  const mixRows = weeks.map(p => {
    const ws = shown.filter(x => x.w.start >= p.a && x.w.start < p.b).map(x => x.w);
    const inp = ws.reduce((n, w) => n + (w.metrics.input_tokens || 0), 0), cached = ws.reduce((n, w) => n + (w.metrics.cached_input_tokens || 0), 0);
    const tot = ws.reduce((n, w) => n + (w.metrics.total_tokens || 0), 0), out = ws.reduce((n, w) => n + (w.metrics.output_tokens || 0), 0);
    return {cache: inp ? 100 * cached / inp : null, out: tot ? 100 * out / tot : null};
  });
  const mixCard = card('Workload mix of these windows', {sub: 'Cache share and output share per week. Capacity in total tokens rises with caching, so check these before blaming the quota.'},
    chartBox(el => lines(el, {labels: weeks.map(p => ({label: p.label, short: c.date(p.a)})), height: 220, fmt: v => num(v, 1) + '%', series: [
      {key: 'cache', label: 'Cached share of input', color: 'var(--c2)', values: mixRows.map(r => r.cache)},
      {key: 'out', label: 'Output share of total', color: 'var(--c3)', values: mixRows.map(r => r.out)}]})),
    legend([{label: 'Cached share of input', color: 'var(--c2)', line: true}, {label: 'Output share of total', color: 'var(--c3)', line: true}]));

  return [headline, verdictCards, scatterCard, matrix, h('div', {class: 'grid'}, ratioCard || mixCard, ratioCard ? mixCard : notesCard), ratioCard ? notesCard : null];
}

// ======================================================================
// Spend anatomy
// ======================================================================
function dimensions() {
  const D = ctx.D, c = ctx.clock, v = view(), gran = granularity(v), key = bucketer(gran), bs = buckets(v, gran);
  const projectOf = i => projectKey(D.sessions[i].cwd);
  const kindNames = {main: 'Main conversations', subagent: 'Subagents', review: 'Auto-reviews'};
  return {
    model: {label: 'Model', of: e => e[1], name: k => D.models[k], color: k => color(D.models[k]), order: k => k},
    context: {label: 'Context size', of: e => contextBucket(e[6]), name: k => CONTEXT_BUCKETS[k][2], order: k => k},
    effort: {label: 'Reasoning effort', of: e => e[4], name: k => D.efforts[k] === '—' ? 'unspecified' : D.efforts[k], order: k => ['low', 'medium', 'high', 'xhigh'].indexOf(D.efforts[k]) + 1 || 9},
    project: {label: 'Project', of: e => projectOf(e[3]), name: k => k ? projectName(k.startsWith('worktree:') ? '/' + k.slice(9) : k) : 'No directory', top: 10},
    kind: {label: 'Session type', of: e => sessionKind(D.sessions[e[3]]), name: k => kindNames[k] || k, order: k => Object.keys(kindNames).indexOf(k)},
    weekday: {label: 'Weekday', of: e => c.weekday(e[0]), name: k => new Intl.DateTimeFormat(locales, {weekday: 'short', timeZone: 'UTC'}).format(new Date(Date.UTC(2024, 0, 1 + k))), order: k => k},
    hour: {label: 'Hour of day', of: e => Math.floor(c.hour(e[0]) / 3), name: k => `${String(k * 3).padStart(2, '0')}–${String(k * 3 + 3).padStart(2, '0')}`, order: k => k},
    time: {label: 'Period', of: e => key(e[0]), name: k => bs.find(b => b.key === k)?.short || '', order: k => k},
  };
}

export function anatomy() {
  const D = ctx.D, v = view(), mi = D.mi[state.metric], A = state.anatomy, c = ctx.clock;
  const ev = v.events, T = D.mi.total_tokens;
  const total = sum(ev, mi), allTokens = sum(ev, T);
  const inp = sum(ev, D.mi.input_tokens), cached = sum(ev, D.mi.cached_input_tokens), out = sum(ev, D.mi.output_tokens);
  let big = 0, bigResp = 0;
  for (const e of ev) if (e[6] >= 128e3) { big += e[5][T] || 0; bigResp++; }

  // ---------- headline ----------
  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'},
    h('div', {class: 'headline-text'},
      h('div', {class: 'eyebrow'}, `${v.days} ${plural(v.days, 'day', 'days')} · ${c.dateY(v.a)} – ${c.dateY(v.b - 1)}`),
      h('p', {class: 'lede'}, h('b', {}, compact(allTokens)), ' tokens in ', h('b', {}, num(ev.length)), ' responses. ',
        h('b', {}, share(cached, inp, 0)), ' of input was re-read from cache; the costly part — ', h('b', {}, compact(inp - cached + out)),
        ' uncached input and output — is ', share(inp - cached + out, allTokens, 1), ' of the total.'),
      h('ul', {class: 'facts'},
        h('li', {}, 'Responses with ≥ 128K context: ', h('b', {}, share(bigResp, ev.length, 0)), ' of responses, ', h('b', {}, share(big, allTokens, 0)), ' of tokens'),
        h('li', {}, 'Average context per response: ', h('b', {}, compact(ev.length ? inp / ev.length : 0)), ' tokens'),
        h('li', {}, 'Output per response: ', h('b', {}, compact(ev.length ? out / ev.length : 0)), ' tokens')))));

  // ---------- drivers ----------
  const pv = v.previous, R0 = pv.length, R1 = ev.length;
  const I0 = R0 ? sum(pv, D.mi.input_tokens) / R0 : 0, I1 = R1 ? inp / R1 : 0;
  const O0 = R0 ? sum(pv, D.mi.output_tokens) / R0 : 0, O1 = R1 ? out / R1 : 0;
  const T0 = sum(pv, T);
  const vsNote = `vs previous ${v.days} ${plural(v.days, 'day', 'days')}`;
  const driverTiles = h('div', {class: 'tiles'},
    tile('Total tokens', compact(allTokens), null, {delta: change(allTokens, T0), deltaNote: vsNote, class: 'hero'}),
    tile('Responses', num(R1), 'how much work was done', {delta: change(R1, R0), deltaNote: vsNote}),
    tile('Context per response', compact(I1), 'input tokens read at each step', {delta: change(I1, I0), deltaNote: vsNote}),
    tile('Output per response', compact(O1), 'written and reasoned tokens', {delta: change(O1, O0), deltaNote: vsNote}));
  // Exact midpoint decomposition of T = R × (I + O).
  const dR = (R1 - R0) * ((I0 + O0) + (I1 + O1)) / 2, dI = (I1 - I0) * (R0 + R1) / 2, dO = (O1 - O0) * (R0 + R1) / 2;
  const driverCard = card('What drove the change', {
    sub: `Total tokens = responses × (context + output per response). The change ${vsNote} is split exactly between the three factors.`},
  R0 ? chartBox(el => waterfall(el, [
    {label: 'Before', value: T0, kind: 'total', note: vsNote},
    {label: 'More responses', value: dR, note: `${changeText(change(R1, R0))} responses`},
    {label: 'Larger context', value: dI, note: `${changeText(change(I1, I0))} context per response`},
    {label: 'More output', value: dO, note: `${changeText(change(O1, O0))} output per response`},
    {label: 'Now', value: allTokens, kind: 'total'}])) : h('div', {class: 'empty'}, 'No activity in the previous period to compare with'));

  // ---------- pivot ----------
  const dims = dimensions();
  if (!dims[A.rows]) A.rows = 'model';
  if (!dims[A.cols]) A.cols = 'context';
  const dr = dims[A.rows], dc = dims[A.cols];
  const cells = new Map(), rowSum = new Map(), colSum = new Map();
  for (const e of ev) {
    const r = dr.of(e), col = dc.of(e), x = e[5][mi] || 0, k = r + '\u0000' + col;
    const cell = cells.get(k) || {value: 0, n: 0, ctx: 0}; cell.value += x; cell.n++; cell.ctx += e[6] || 0; cells.set(k, cell);
    rowSum.set(r, (rowSum.get(r) || 0) + x); colSum.set(col, (colSum.get(col) || 0) + x);
  }
  const keysOf = (d, sums) => {
    let ks = [...sums.keys()];
    ks.sort(d.order ? (p, q) => d.order(p) - d.order(q) : (p, q) => sums.get(q) - sums.get(p));
    return d.top ? ks.slice(0, d.top) : ks;
  };
  const rowKeys = keysOf(dr, rowSum), colKeys = keysOf(dc, colSum);
  const maxCell = Math.max(1, ...[...cells.values()].map(x => x.value));
  const sel = A.sel && A.sel.rows === A.rows && A.sel.cols === A.cols ? A.sel : null;
  const dimOptions = Object.entries(dims).map(([k, d]) => [k, d.label]);
  const pickRows = select(dimOptions, A.rows, x => { A.rows = x; A.sel = null; saveState(); ctx.render(); }, {'aria-label': 'Rows'});
  const pickCols = select(dimOptions, A.cols, x => { A.cols = x; A.sel = null; saveState(); ctx.render(); }, {'aria-label': 'Columns'});
  const pivot = card('Where the tokens went', {
    sub: `${metricLabel(state.metric)} split by two dimensions at once. Small numbers are the share of the total. Click a cell to list the sessions behind it.`,
    actions: h('div', {class: 'pivot-pick'}, h('span', {class: 'muted small'}, 'Rows'), pickRows, h('button', {type: 'button', class: 'ghost small', title: 'Swap rows and columns',
      onclick: () => { [A.rows, A.cols] = [A.cols, A.rows]; A.sel = null; saveState(); ctx.render(); }}, '⇄'), h('span', {class: 'muted small'}, 'Columns'), pickCols)},
  chartBox(el => heatTable(el, {
    rows: rowKeys.map(k => ({key: k, label: dr.name(k), color: dr.color?.(k)})), cols: colKeys.map(k => ({key: k, label: dc.name(k)})), corner: `${dr.label} \\ ${dc.label}`,
    cell: (r, col) => {
      const x = cells.get(r.key + '\u0000' + col.key);
      if (!x) return null;
      const on = sel && sel.r === String(r.key) && sel.c === String(col.key);
      return {value: x.value, text: fmtMetric(x.value), sub: share(x.value, total, 1), level: Math.sqrt(x.value / maxCell) * (on ? 1.3 : 1),
        tip: {title: `${r.label} · ${col.label}`, rows: [{label: metricLabel(state.metric), value: fmtMetric(x.value)}, {label: 'of total', value: share(x.value, total, 1)},
          {label: 'of row', value: share(x.value, rowSum.get(r.key), 1)}, {label: 'responses', value: num(x.n)}, {label: 'avg context', value: compact(x.ctx / x.n)}], note: 'Click to list sessions'}};
    },
    rowTotal: r => r ? fmtMetric(rowSum.get(r.key) || 0) : fmtMetric(total),
    colTotal: col => fmtMetric(colSum.get(col.key) || 0),
    onCell: (r, col) => { A.sel = on(r, col) ? null : {rows: A.rows, cols: A.cols, r: String(r.key), c: String(col.key), label: `${r.label} · ${col.label}`}; saveState(); ctx.render(); }})));
  function on(r, col) { return sel && sel.r === String(r.key) && sel.c === String(col.key); }

  // ---------- context distribution ----------
  const ctxValues = new Map(), ctxResp = new Map(), ctxPresent = new Set();
  for (const e of ev) {
    const k = contextBucket(e[6]), m = D.models[e[1]];
    let row = ctxValues.get(k); if (!row) ctxValues.set(k, row = {});
    row[m] = (row[m] || 0) + (e[5][mi] || 0); ctxPresent.add(m);
    ctxResp.set(k, (ctxResp.get(k) || 0) + 1);
  }
  const ctxBuckets = CONTEXT_BUCKETS.map(([, , label], i) => ({key: i, label: `${label} context · ${num(ctxResp.get(i) || 0)} responses`, short: label}));
  const ctxSeries = D.models.filter(m => ctxPresent.has(m)).map(m => ({key: m, label: m, color: color(m)}));
  const ctxCard = card('Spend by context size', {sub: 'Every response re-reads its whole context, so long conversations cost more per step even when the cache absorbs most of it.'},
    chartBox(el => columns(el, {buckets: ctxBuckets, series: ctxSeries, values: ctxValues, fmt: fmtMetric, height: 250})), ctxSeries.length > 1 ? legend(ctxSeries) : null);

  // ---------- context over time ----------
  const gran = granularity(v), key = bucketer(gran), bs = buckets(v, gran);
  const acc = new Map();
  for (const e of ev) {
    const k = key(e[0]) + '\u0000' + e[1], x = acc.get(k) || [0, 0];
    x[0] += e[6] || 0; x[1]++; acc.set(k, x);
  }
  const top = [...new Set(ev.map(e => e[1]))].sort((p, q) => p - q).slice(0, 6);
  const ctxTime = card('Context per response over time', {sub: 'Average input tokens per response for each model. A rising line means conversations are carrying more context into every step.'},
    chartBox(el => lines(el, {labels: bs, height: 240, series: top.map(m => ({key: m, label: D.models[m], color: color(D.models[m]),
      values: bs.map(b => { const x = acc.get(b.key + '\u0000' + m); return x ? x[0] / x[1] : null; })}))})),
    top.length > 1 ? legend(top.map(m => ({label: D.models[m], color: color(D.models[m]), line: true}))) : null);

  // ---------- sessions behind the selection ----------
  const picked = sel ? ev.filter(e => String(dr.of(e)) === sel.r && String(dc.of(e)) === sel.c) : ev;
  const stats = [...sessionStats(picked, mi).values()];
  const bigBy = new Map();
  for (const e of picked) if (e[6] >= 128e3) bigBy.set(e[3], (bigBy.get(e[3]) || 0) + (e[5][mi] || 0));
  const ctxSum = new Map();
  for (const e of picked) ctxSum.set(e[3], (ctxSum.get(e[3]) || 0) + (e[6] || 0));
  const sessCard = card(sel ? `Sessions behind “${sel.label}”` : 'Sessions driving the spend', {
    sub: sel ? `Only the responses inside the selected cell are counted.` : 'Sorted by usage; avg context shows how heavy each step was.',
    actions: sel ? h('button', {type: 'button', class: 'ghost small', onclick: () => { A.sel = null; saveState(); ctx.render(); }}, 'Clear selection ✕') : null},
  table({rows: stats, sortKey: 'value', pageSize: 12, csvName: 'anatomy-sessions', onRow: st => sessionDetail(st.session.id), columns: [
    {key: 'title', label: 'Session', value: st => sessionTitle(st.session), render: st => h('div', {class: 'cell-main'},
      h('div', {class: 'ellipsis'}, sessionTitle(st.session)), h('div', {class: 'muted small ellipsis'}, projectName(st.session.cwd)))},
    {key: 'model', label: 'Model', value: st => D.models[st.mainModel], render: st => modelDot(D.models[st.mainModel])},
    {key: 'value', label: metricLabel(state.metric), num: true, value: st => st.value, fmt: fmtMetric},
    {key: 'share', label: 'Share', num: true, value: st => total ? st.value / total : 0, fmt: x => pct(x * 100, 1)},
    {key: 'resp', label: 'Responses', num: true, value: st => st.responses},
    {key: 'ctx', label: 'Avg context', num: true, value: st => (ctxSum.get(st.index) || 0) / st.responses, compact: true},
    {key: 'peak', label: 'Peak context', num: true, value: st => st.window ? st.peakContext / st.window : null, fmt: x => pct(x * 100), title: 'Largest context as a share of the model context window'},
    {key: 'big', label: '≥ 128K share', num: true, value: st => st.value ? (bigBy.get(st.index) || 0) / st.value : 0, fmt: x => pct(x * 100), title: 'Share of this session’s usage at 128K+ context'},
  ]}));

  return [headline, driverTiles, driverCard, pivot, sessCard, h('div', {class: 'grid'}, ctxCard, ctxTime)];
}

// ======================================================================
// Signals shown on the overview
// ======================================================================
// One line of signal per focus page, shown as a list on the overview.
export function signals() {
  const D = ctx.D, c = ctx.clock, mi = D.mi[state.metric], now = Date.now() / 1000;
  const wk = period('week', periodStart('week', c.today())), prevWk = period('week', wk.startDay - 7);
  const tw = sum(eventsBetween(wk.a, now), mi), lw = sum(eventsBetween(prevWk.a, prevWk.a + (now - wk.a)), mi);
  let watchLine = 'Track observed capacity per model';
  const {five} = quotaKeys();
  if (five) {
    const st = watchStats(five, 'per');
    const lead = st.groups.filter(g => !MIXED.has(g.model)).sort((p, q) => q.recent.length - p.recent.length)[0];
    const flagged = st.groups.filter(g => ['down', 'up', 'maybe'].includes(g.v.code));
    if (flagged.length) watchLine = `${modelName(flagged[0].model)}: ${flagged[0].v.text.toLowerCase()} (${changeText(flagged[0].v.ratio)})`;
    else if (lead && lead.v.code !== 'thin') watchLine = `${modelName(lead.model)}: no clear change (${changeText(lead.v.ratio)})`;
  }
  const v = view();
  let big = 0; for (const e of v.events) if (e[6] >= 128e3) big += e[5][D.mi.total_tokens] || 0;
  const items = [
    {page: 'review', i: 0, title: 'Review this week', line: `${fmtMetric(tw)} so far · ${lw ? changeText(change(tw, lw)) + ' vs last week' : 'no data last week'}`},
    {page: 'watch', i: 1, title: 'Watch quota capacity', line: watchLine},
    {page: 'anatomy', i: 2, title: 'Break down the spend', line: `${share(big, sum(v.events, D.mi.total_tokens), 0)} of tokens at ≥ 128K context`},
    {page: 'context', i: 16, title: 'Trace context growth', line: contextLine()},
  ];
  return h('div', {class: 'signals'}, items.map(it => h('a', {class: 'signal', href: '#/' + it.page},
    h('span', {class: 'signal-icon'}, icon(it.i)),
    h('div', {class: 'signal-body'}, h('div', {class: 'signal-title'}, it.title), h('div', {class: 'signal-line'}, it.line)),
    icon(15))));
}
