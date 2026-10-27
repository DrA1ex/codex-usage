// Focus page "Work per quota": whether a larger context (fewer compactions, more cached re-reads) makes the
// quota look more generous in total tokens while less new input and output fits into each percent of it.
import {h, num, compact, share, plural, median, quantile, mannWhitney} from './util.js';
import {columns, lines, timeScatter, legend} from './charts.js';
import {ctx, state, saveState, view, sessionContext, windowChanges, workRates, granularity, buckets, card, tile, chartBox,
  segmented, select, table, color, modelName, modelDot, info} from './core.js';
import {windowDetail} from './pages.js';

const WEIGHTS = [['0.1:8', '1 : 0.1 : 8'], ['0.25:4', '1 : 0.25 : 4'], ['0.5:4', '1 : 0.5 : 4'], ['1:1', '1 : 1 : 1']];
export const KINDS = [
  {key: 'total', label: 'Total tokens', short: 'Total', color: 'var(--ink-2)'},
  {key: 'cached', label: 'Cached input (re-read context)', short: 'Cached input', color: 'var(--c2)'},
  {key: 'uncached', label: 'Uncached input', short: 'Uncached input', color: 'var(--c1)'},
  {key: 'output', label: 'Output', short: 'Output', color: 'var(--c3)'},
  {key: 'fresh', label: 'Fresh work: uncached input + output', short: 'Fresh work', color: 'var(--s2)'},
  {key: 'weighted', label: 'Cost-weighted tokens', short: 'Cost-weighted', color: 'var(--s4)'},
  {key: 'responses', label: 'Responses', short: 'Responses', color: 'var(--s7)'},
];
const kindOf = k => KINDS.find(x => x.key === k) || KINDS[4];
const MIN_USED = 10;
const signed = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), digits);
const changeText = x => Number.isFinite(x) ? signed(x * 100, Math.abs(x) < .1 ? 1 : 0) + '%' : 'n/a';
const pText = p => !Number.isFinite(p) ? '' : p < .001 ? 'p < 0.001' : `p = ${num(p, p < .01 ? 3 : 2)}`;
const fmtKind = k => v => v == null ? '—' : k === 'responses' ? num(v, v < 10 ? 2 : 1) : compact(v);
const ratio = x => Number.isFinite(x) ? num(x, x < 10 ? 1 : 0) : '—';

function weights() {
  const [cachedW, outputW] = String(state.work.weights).split(':').map(Number);
  return {cached: Number.isFinite(cachedW) ? cachedW : .1, output: Number.isFinite(outputW) ? outputW : 8};
}

function counterKey() {
  const D = ctx.D, k = state.work.key;
  return D.quotaKeys.includes(k) ? k : D.quotaKeys.find(x => x.endsWith('|300')) || D.quotaKeys[0];
}

// Usage of one side of the split: what each response looked like and how often context was cut back.
function drivers(events, sessionsCut) {
  const D = ctx.D, mi = D.mi;
  let input = 0, cached = 0, output = 0, big = 0, window = 0;
  const contexts = [];
  for (const e of events) {
    input += e[5][mi.input_tokens] || 0; cached += e[5][mi.cached_input_tokens] || 0; output += e[5][mi.output_tokens] || 0;
    if (e[6]) { contexts.push(e[6]); if (e[6] >= 128e3) big++; }
    if (e[7] > window) window = e[7];
  }
  const n = events.length;
  return {n, input, cached, output, window, contextMedian: median(contexts), contextP90: contexts.length ? quantile(contexts, .9) : NaN,
    contextMean: n ? input / n : NaN, cacheShare: input ? cached / input : NaN, rereadPerOutput: output ? cached / output : NaN,
    outputPer: n ? output / n : NaN, bigShare: contexts.length ? big / contexts.length : NaN,
    cutsPer100: n ? 100 * sessionsCut / n : NaN};
}

// Everything the page needs; the overview signal reuses it.
export function analyseWork() {
  const D = ctx.D, W = state.work, v = view(), c = ctx.clock;
  if (!D.quotaKeys.length) return null;
  const qkey = counterKey(), [limitId, minutesText] = qkey.split('|'), minutes = Number(minutesText), wts = weights();
  D.windowChanges ??= windowChanges(D.events);
  const changes = D.windowChanges;

  // ---------- where to split ----------
  let split, why, trigger = null;
  const inRange = changes.filter(x => x.t > v.a + 86400 && x.t < v.b - 86400);
  if (W.split) { split = c.dayStart(c.fromIso(W.split)); why = 'chosen'; }
  else if (inRange.length) {
    // Models switch on different days; take the first change of the latest group (changes less than a week apart).
    let k = inRange.length - 1;
    while (k > 0 && inRange[k].t - inRange[k - 1].t < 7 * 86400) k--;
    split = inRange[k].t; why = 'change'; trigger = inRange[k];
  }
  else { split = c.dayStart(v.fromDay + Math.floor(v.days / 2)); why = 'middle'; }
  if (split <= v.a || split >= v.b) { split = c.dayStart(v.fromDay + Math.floor(v.days / 2)); why = 'middle'; }

  // ---------- quota windows: tokens per 1% ----------
  const models = state.models.length ? new Set(state.models) : null;
  const merged = w => {
    if (!state.internal) return w.metrics;
    const m = {...w.metrics};
    for (const [k, x] of Object.entries(w.internal_metrics || {})) m[k] = (m[k] || 0) + x;
    return m;
  };
  const windows = D.windows.filter(w => w.limit_id === limitId && w.minutes === minutes && w.start >= v.a && w.start < v.b
      && (!models || models.has(w.classification)) && w.exclusion_code !== 'too_long' && w.exclusion_code !== 'no_usage'
      && w.max_used - w.first_used >= MIN_USED)
    .map(w => { const m = merged(w), used = w.max_used - w.first_used; return {w, m, used, r: workRates(m, used, wts), after: w.start >= split}; });
  const before = windows.filter(x => !x.after), after = windows.filter(x => x.after);
  const pooled = list => {
    const m = {}; let used = 0;
    for (const x of list) { used += x.used; for (const k of ['total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'responses']) m[k] = (m[k] || 0) + (x.m[k] || 0); }
    return workRates(m, used, wts);
  };
  const cmp = Object.fromEntries(KINDS.map(({key}) => {
    const b = before.map(x => x.r[key]).filter(x => x != null), a = after.map(x => x.r[key]).filter(x => x != null);
    const mb = median(b), ma = median(a);
    return [key, {before: b.length ? mb : null, after: a.length ? ma : null, change: b.length && a.length && mb ? ma / mb - 1 : NaN,
      p: b.length >= 3 && a.length >= 3 ? mannWhitney(a, b).p : NaN}];
  }));
  const base = pooled(before);

  // ---------- responses: context, cache and compactions ----------
  const bySession = new Map();
  for (const e of v.events) { let list = bySession.get(e[3]); if (!list) bySession.set(e[3], list = []); list.push(e); }
  const cutTimes = [];
  for (const list of bySession.values()) if (list.length >= 3) for (const cp of sessionContext(list, D.mi).compactions) cutTimes.push(cp.t);
  const evBefore = v.events.filter(e => e[0] < split), evAfter = v.events.filter(e => e[0] >= split);
  const dBefore = drivers(evBefore, cutTimes.filter(t => t < split).length), dAfter = drivers(evAfter, cutTimes.filter(t => t >= split).length);

  // ---------- verdict ----------
  const t = cmp.total.change, f = cmp.fresh.change, o = cmp.output.change;
  let verdict;
  if (before.length < 3 || after.length < 3) verdict = {code: 'thin', chip: 'neutral', text: 'Not enough windows'};
  else if (t > .05 && (f < -.05 || o < -.05)) verdict = {code: 'illusion', chip: 'bad', text: 'Looks more generous, less work fits'};
  else if (f < -.05) verdict = {code: 'less', chip: 'bad', text: 'Less work per 1%'};
  else if (f > .05) verdict = {code: 'more', chip: 'ok', text: 'More work per 1%'};
  else verdict = {code: 'stable', chip: 'neutral', text: 'No clear change'};

  return {v, qkey, minutes, split, why, trigger, changes, inRange, windows, before, after, cmp, base, dBefore, dAfter, cutTimes, verdict, wts};
}

export function workPage() {
  const D = ctx.D, c = ctx.clock, W = state.work;
  if (!D.quotaKeys.length) return [card('Work per quota', {}, h('div', {class: 'empty'}, 'No quota snapshots in the history of this profile.'))];
  const set = patch => { Object.assign(W, patch); saveState(); ctx.render(); };
  const A = analyseWork();
  const {v, minutes, split, why, cmp, before, after, dBefore, dAfter, verdict, wts} = A;
  const qname = minutes === 300 ? 'five-hour' : minutes === 10080 ? 'weekly' : 'quota';

  ctx.bar = h('div', {class: 'bar-group'},
    segmented(D.quotaKeys.map(k => [k, Number(k.split('|')[1]) === 300 ? '5-hour' : Number(k.split('|')[1]) === 10080 ? 'Weekly' : k]), A.qkey, k => set({key: k}), {class: 'small', label: 'Counter'}),
    h('label', {class: 'inline-field'}, h('span', {}, 'Split at'),
      h('input', {type: 'date', value: W.split || c.iso(c.day(split)), min: c.iso(v.fromDay + 1), max: c.iso(v.toDay), onchange: e => set({split: e.target.value})})),
    W.split ? h('button', {type: 'button', class: 'ghost small', onclick: () => set({split: ''}), title: 'Split at the latest detected context-window change, or the middle of the range'}, 'Auto') : null,
    h('label', {class: 'inline-field', title: 'Weights of uncached input : cached input : output for the cost-weighted measure'},
      h('span', {}, 'Weights'), select(WEIGHTS, W.weights, x => set({weights: x}))));

  // ---------- headline ----------
  const splitText = c.dateY(split);
  const whyText = why === 'change' ? `the context window of ${D.models[A.trigger.model]} changed from ${compact(A.trigger.from)} to ${compact(A.trigger.to)}`
    : why === 'chosen' ? 'the date you chose' : 'the middle of the range (no context-window change detected)';
  const moves = verdict.code === 'thin'
    ? [`Not enough ${qname} windows with at least ${MIN_USED}% used on both sides of ${splitText} (${before.length} before, ${after.length} after). Widen the date range or move the split.`]
    : [
      'Per 1% of the ', qname, ' quota, total tokens moved ', h('b', {}, changeText(cmp.total.change)), ', cached re-reads ', h('b', {}, changeText(cmp.cached.change)),
      ', but fresh work (uncached input + output) moved ', h('b', {}, changeText(cmp.fresh.change)), ' and output ', h('b', {}, changeText(cmp.output.change)), '. ',
      verdict.code === 'illusion' ? 'The quota looks more generous only because more of each percent is spent re-reading cached context; less new work fits into it.'
        : verdict.code === 'less' ? 'Less new work fits into each percent of the quota.'
          : verdict.code === 'more' ? 'More new work fits into each percent of the quota.' : 'The amount of new work per percent is about the same.'];
  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'}, h('div', {class: 'headline-text'},
    h('div', {class: 'eyebrow'}, `${minutes === 300 ? 'Five-hour' : 'Weekly'} quota · before vs after ${splitText} · split at ${whyText}`),
    h('p', {class: 'lede'}, h('span', {class: ['chip', verdict.chip]}, verdict.text), ' ', moves),
    h('ul', {class: 'facts'},
      h('li', {}, 'Median context per response: ', h('b', {}, `${compact(dBefore.contextMedian || 0)} → ${compact(dAfter.contextMedian || 0)}`)),
      h('li', {}, 'Cached tokens re-read per output token: ', h('b', {}, `${ratio(dBefore.rereadPerOutput)} → ${ratio(dAfter.rereadPerOutput)}`)),
      h('li', {}, 'Compactions per 100 responses: ', h('b', {}, `${num(dBefore.cutsPer100 || 0, 1)} → ${num(dAfter.cutsPer100 || 0, 1)}`)),
      h('li', {}, 'Largest context window seen: ', h('b', {}, `${compact(dBefore.window)} → ${compact(dAfter.window)}`)),
      h('li', {}, 'Responses per 1%: ', h('b', {}, `${fmtKind('responses')(cmp.responses.before)} → ${fmtKind('responses')(cmp.responses.after)}`), ` (${changeText(cmp.responses.change)})`)))));

  // ---------- tiles ----------
  const kt = (key, note) => tile(`${kindOf(key).short} per 1%`, fmtKind(key)(cmp[key].after), note, {delta: cmp[key].change, deltaNote: `vs before · ${pText(cmp[key].p)}`});
  const tiles = h('div', {class: 'tiles'},
    kt('total', 'what the quota seems to give'),
    kt('fresh', 'new input + output: the real work'),
    kt('output', 'what the model wrote'),
    kt('cached', 're-read context'),
    kt('weighted', `weights ${W.weights.replace(':', ' : ')} on cached : output`),
    kt('responses', 'model steps'));

  // ---------- comparison table ----------
  const rows = KINDS.map(k => ({...k, ...cmp[k.key]}));
  const cmpCard = card('Tokens per 1% of the quota, before and after', {
    sub: `Medians over ${before.length} ${plural(before.length, 'window', 'windows')} before and ${after.length} after ${splitText}; each window is weighed equally. Mann–Whitney test on individual windows.`,
    actions: info('Cost-weighted tokens count uncached input as 1, cached input and output by the selected weights. The default 1 : 0.1 : 8 mirrors typical API price ratios, where cached input is ten times cheaper than new input. It is an estimate of relative cost, not a price.')},
  table({rows, pageSize: 10, csvName: 'work-per-quota', columns: [
    {key: 'label', label: 'Per 1% of quota', value: r => r.label, render: r => h('span', {class: 'model'}, h('i', {class: 'swatch', style: {background: r.color}}), r.label)},
    {key: 'before', label: 'Before', num: true, value: r => r.before, render: r => fmtKind(r.key)(r.before)},
    {key: 'after', label: 'After', num: true, value: r => r.after, render: r => fmtKind(r.key)(r.after)},
    {key: 'change', label: 'Change', num: true, value: r => Number.isFinite(r.change) ? r.change : null, render: r => Math.abs(r.change) > .05 ? h('b', {}, changeText(r.change)) : changeText(r.change)},
    {key: 'p', label: 'p-value', num: true, value: r => Number.isFinite(r.p) ? r.p : null, render: r => pText(r.p) || '—'},
  ]}));

  // ---------- trend, indexed to before ----------
  const gran = granularity(v) === 'hour' ? 'day' : granularity(v), bs = buckets(v, gran);
  const at = t => bs.findIndex(b => t >= b.start && t < b.end);
  const perBucket = bs.map(() => []);
  for (const x of A.windows) { const i = at(x.w.start); if (i >= 0) perBucket[i].push(x); }
  const pooledRates = list => {
    if (!list.length) return null;
    const m = {}; let used = 0;
    for (const x of list) { used += x.used; for (const k of ['total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'responses']) m[k] = (m[k] || 0) + (x.m[k] || 0); }
    return workRates(m, used, wts);
  };
  const rates = perBucket.map(pooledRates);
  const si = at(split), splitMark = si >= 0 ? [{i: si - .5 + (split - bs[si].start) / (bs[si].end - bs[si].start), label: `split · ${c.date(split)}`}] : [];
  const indexed = ['total', 'cached', 'fresh', 'output', 'responses'].map(kindOf);
  const labels = bs.map((b, i) => ({label: b.label, short: b.short, note: perBucket[i].length ? `${perBucket[i].length} ${plural(perBucket[i].length, 'window', 'windows')}` : 'no windows'}));
  const indexCard = card('Per 1% of the quota, indexed to the period before the split', {
    sub: `100 = the pooled value before ${splitText}. If total tokens climb while fresh work and output fall, the quota only looks more generous: the extra tokens are cached re-reads of a longer context.`},
  chartBox(el => lines(el, {labels, height: 300, fmt: x => num(x), marks: splitMark, ref: {value: 100, label: 'before = 100'},
    series: indexed.map(k => ({key: k.key, label: k.label, color: k.color, values: rates.map(r => r && A.base[k.key] ? 100 * r[k.key] / A.base[k.key] : null)}))})),
  legend(indexed.map(k => ({label: k.label, color: k.color, line: true}))));

  // ---------- composition per 1% ----------
  const parts = [{key: 'uncached', label: 'Uncached input', color: 'var(--c1)'}, {key: 'output', label: 'Output', color: 'var(--c3)'}, {key: 'cached', label: 'Cached input (re-read context)', color: 'var(--c2)'}];
  const values = new Map(bs.map((b, i) => [b.key, rates[i] ? {uncached: rates[i].uncached, output: rates[i].output, cached: rates[i].cached} : {}]));
  const mixCard = card('What one percent of the quota buys', {
    sub: 'Tokens per 1% by kind, pooled over the windows that started in each period. A taller bar made of cached input is not more work.'},
  chartBox(el => columns(el, {buckets: bs, series: parts, values, fmt: compact, height: 260})),
  legend(parts));

  // ---------- every window ----------
  const kind = kindOf(W.measure);
  const pts = A.windows.map(x => ({t: x.w.start, v: x.r[kind.key], color: color(x.w.classification), w: x.w,
    title: `${c.dateTime(x.w.start)} · ${modelName(x.w.classification)}`,
    rows: [{label: `${kind.short.toLowerCase()} per 1%`, value: fmtKind(kind.key)(x.r[kind.key])}, {label: 'total per 1%', value: compact(x.r.total)},
      {label: 'output per 1%', value: compact(x.r.output)}, {label: 'usage', value: `${num(x.w.first_used)}% → ${num(x.w.max_used)}%`}],
    note: 'Click for the window breakdown'})).filter(p => p.v != null);
  const trend = list => {
    const xs = list.filter(x => x.r[kind.key] != null).sort((p, q) => p.w.start - q.w.start);
    return xs.map((x, i) => [x.w.start, median(xs.slice(Math.max(0, i - 3), i + 4).map(y => y.r[kind.key]))]);
  };
  const scatterCard = card(`Every ${qname} window`, {
    sub: `Each dot is one window with at least ${MIN_USED}% used: ${kind.label.toLowerCase()} per 1%. The line is a rolling median. Switch the measure to compare total tokens with fresh work.`,
    actions: segmented([['fresh', 'Fresh'], ['output', 'Output'], ['total', 'Total'], ['cached', 'Cached'], ['weighted', 'Weighted']], kind.key, x => set({measure: x}), {class: 'small', label: 'Measure'})},
  chartBox(el => timeScatter(el, {points: pts, trends: [{color: kind.color, pts: trend(A.windows)}], a: v.a, b: v.b, clock: c, fmt: fmtKind(kind.key), height: 300,
    bands: [{a: v.a, b: split, label: 'before', cls: 'base'}, {a: split, b: v.b, label: 'after', cls: 'recent'}], onClick: p => windowDetail(p.w),
    emptyText: `No ${qname} windows with at least ${MIN_USED}% used in this range`})));

  // ---------- context drivers over time ----------
  const evBuckets = bs.map(() => []), cutsBy = bs.map(() => 0);
  for (const e of v.events) { const i = at(e[0]); if (i >= 0) evBuckets[i].push(e); }
  for (const t of A.cutTimes) { const i = at(t); if (i >= 0) cutsBy[i]++; }
  const dd = evBuckets.map((list, i) => list.length ? drivers(list, cutsBy[i]) : null);
  const ctxCard = card('Context per response', {
    sub: 'Median and 90th-percentile input context of each response, and the largest context window the models reported. A higher window lets context grow further before a compaction.'},
  chartBox(el => lines(el, {labels: bs.map(b => ({label: b.label, short: b.short})), height: 240, marks: splitMark, series: [
    {key: 'median', label: 'Median context', color: 'var(--s1)', values: dd.map(d => d && Number.isFinite(d.contextMedian) ? d.contextMedian : null)},
    {key: 'p90', label: '90th percentile', color: 'var(--s2)', values: dd.map(d => d && Number.isFinite(d.contextP90) ? d.contextP90 : null)},
    {key: 'window', label: 'Context window', color: 'var(--muted)', values: dd.map(d => d?.window || null)}]})),
  legend([{label: 'Median context', color: 'var(--s1)', line: true}, {label: '90th percentile', color: 'var(--s2)', line: true}, {label: 'Context window', color: 'var(--muted)', line: true}]));
  const rereadCard = card('Re-reads per unit of work', {
    sub: 'Cached tokens re-read for every output token, and compactions per 100 responses. Fewer compactions with a larger window mean each step carries more context.'},
  chartBox(el => lines(el, {labels: bs.map(b => ({label: b.label, short: b.short})), height: 240, marks: splitMark, fmt: x => num(x, x < 10 ? 1 : 0), series: [
    {key: 'reread', label: 'Cached tokens per output token', color: 'var(--c2)', values: dd.map(d => d && Number.isFinite(d.rereadPerOutput) ? d.rereadPerOutput : null)},
    {key: 'cuts', label: 'Compactions per 100 responses', color: 'var(--s3)', values: dd.map(d => d && Number.isFinite(d.cutsPer100) ? d.cutsPer100 : null)}]})),
  legend([{label: 'Cached tokens per output token', color: 'var(--c2)', line: true}, {label: 'Compactions per 100 responses', color: 'var(--s3)', line: true}]));

  // ---------- per model ----------
  const byModel = new Map();
  for (const e of v.events) {
    let m = byModel.get(e[1]);
    if (!m) byModel.set(e[1], m = {model: D.models[e[1]], b: [], a: []});
    (e[0] < split ? m.b : m.a).push(e);
  }
  const modelRows = [...byModel.values()].map(m => ({...m, db: drivers(m.b, 0), da: drivers(m.a, 0)})).sort((p, q) => q.db.n + q.da.n - p.db.n - p.da.n);
  const pair = (bv, av, fmt) => [fmt(bv), h('span', {class: 'muted'}, ' → '), fmt(av)];
  const modelCard = card('By model', {sub: `Responses before and after ${splitText} under the current filters.`},
    table({rows: modelRows, pageSize: 10, csvName: 'work-per-quota-models', columns: [
      {key: 'model', label: 'Model', value: r => r.model, render: r => modelDot(r.model)},
      {key: 'n', label: 'Responses', num: true, value: r => r.da.n, render: r => pair(r.db.n, r.da.n, x => num(x)), csv: r => `${r.db.n} → ${r.da.n}`},
      {key: 'window', label: 'Context window', num: true, value: r => r.da.window, render: r => pair(r.db.window, r.da.window, x => x ? compact(x) : '—'), csv: r => `${r.db.window} → ${r.da.window}`},
      {key: 'ctx', label: 'Median context', num: true, value: r => r.da.contextMedian, render: r => pair(r.db.contextMedian, r.da.contextMedian, x => Number.isFinite(x) ? compact(x) : '—'), csv: r => `${r.db.contextMedian} → ${r.da.contextMedian}`},
      {key: 'big', label: '≥ 128K context', num: true, value: r => r.da.bigShare, render: r => pair(r.db.bigShare, r.da.bigShare, x => Number.isFinite(x) ? share(x, 1, 0) : '—'), csv: r => `${r.db.bigShare} → ${r.da.bigShare}`},
      {key: 'reread', label: 'Re-read / output', num: true, value: r => r.da.rereadPerOutput, render: r => pair(r.db.rereadPerOutput, r.da.rereadPerOutput, ratio), csv: r => `${r.db.rereadPerOutput} → ${r.da.rereadPerOutput}`},
      {key: 'out', label: 'Output / response', num: true, value: r => r.da.outputPer, render: r => pair(r.db.outputPer, r.da.outputPer, x => Number.isFinite(x) ? compact(x) : '—'), csv: r => `${r.db.outputPer} → ${r.da.outputPer}`},
    ]}));

  // ---------- detected changes ----------
  const changes = [...A.changes].sort((p, q) => q.t - p.t);
  const changeCard = card('Context-window changes', {sub: 'A model counts as switched once 20 responses in a row report the new window. Use one as the split to compare before and after.'},
    changes.length ? h('ul', {class: 'notes'}, changes.slice(0, 12).map(x => h('li', {},
      h('span', {class: 'muted small mono'}, c.dateTime(x.t)), h('i', {class: 'swatch', style: {background: color(D.models[x.model])}}),
      h('span', {}, `${D.models[x.model]}: ${compact(x.from)} → ${compact(x.to)} `,
        h('button', {type: 'button', class: 'link small', onclick: () => set({split: c.iso(c.day(x.t))})}, 'split here')))))
      : h('div', {class: 'empty'}, 'No change of the reported context window in this history'));

  return [headline, tiles, indexCard, cmpCard, scatterCard, h('div', {class: 'grid'}, mixCard, rereadCard), h('div', {class: 'grid'}, ctxCard, changeCard), modelCard];
}

// One line for the overview signals.
export function workLine() {
  const A = analyseWork();
  if (!A || A.verdict.code === 'thin') return 'Not enough quota windows to compare';
  const {cmp} = A;
  return `Since ${ctx.clock.date(A.split)}: fresh work per 1% ${changeText(cmp.fresh.change)}, total ${changeText(cmp.total.change)}`;
}
