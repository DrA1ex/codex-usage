// Focus page "Task speed": whether tasks take longer because the model generates more slowly, or because more of
// each task goes to tools, auto-review, subagents and compactions.
// Events carry e[8] generation seconds, e[9] seconds spent on the tools the response called, e[10] = 1 for a
// compaction call and e[11] the index of its turn in D.turns ([start, duration, session, ttft, aborted]).
import {h, num, compact, share, plural, median, duration, projectKey, projectName} from './util.js';
import {columns, lines, waterfall, legend, sparkline} from './charts.js';
import {ctx, state, saveState, view, CONTEXT_BUCKETS, contextBucket, granularity, buckets, card, tile, chartBox, segmented,
  table, color, modelDot, info, PARTS, MIN_CELL, cellKey, timed, genSpeed, speedCells, speedIndex, changePoints, turnBreakdown, pool} from './core.js';
import {toggleProject, toggleModel} from './pages.js';

const SECONDARY = ['compaction', 'review', 'subagent', 'tools', 'other'];
const MIN_BUCKET = 10;
const signed = (v, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v), digits);
const changeText = x => Number.isFinite(x) ? signed(x * 100, Math.abs(x) < .1 ? 1 : 0) + '%' : 'n/a';
const ppText = x => Number.isFinite(x) ? signed(x * 100, Math.abs(x) < .1 ? 1 : 0) + ' pp' : 'n/a';
const tps = x => x == null || !Number.isFinite(x) ? '—' : `${num(x, x < 10 ? 1 : 0)} tok/s`;
const secs = x => x == null || !Number.isFinite(x) ? '—' : x < 60 ? `${num(x, x < 10 ? 1 : 0)} s` : duration(x);
const change = (now, before) => Number.isFinite(now) && before ? now / before - 1 : NaN;

// Daily like-for-like speed against the whole range, for the change point and the trend line.
function dailyIndex(events, mi, bs, at) {
  const base = speedCells(events, mi), per = bs.map(() => ({expected: 0, actual: 0, n: 0}));
  for (const e of events) {
    if (!timed(e)) continue;
    const c = base.get(cellKey(e)), i = at(e[0]);
    if (i < 0 || !c || c.n < MIN_CELL || !c.out) continue;
    per[i].expected += (e[5][mi.output_tokens] || 0) * c.gen / c.out; per[i].actual += e[8]; per[i].n++;
  }
  return per.map(x => x.n >= MIN_BUCKET && x.actual ? x.expected / x.actual : null);
}

// Everything the page needs; the overview signal reuses it.
export function analyseSpeed() {
  const D = ctx.D, v = view(), c = ctx.clock, S = state.speed, mi = D.mi;
  D.hasTiming ??= D.events.some(e => e[8] != null);
  if (!D.hasTiming) return null;
  const events = v.events;

  // ---------- where to split ----------
  const days = buckets(v, 'day'), dayAt = t => c.day(t) - v.fromDay;
  const daily = dailyIndex(events, mi, days, dayAt);
  const middle = c.dayStart(v.fromDay + Math.floor(v.days / 2));
  // Auto: the latest step in daily speed, compared with the level since the step before it, so that an older
  // change does not blur the baseline. A chosen date compares with everything before it.
  const stepsFound = changePoints(days.map((d, i) => ({t: d.start, value: daily[i]})).filter(d => d.value != null));
  let split = middle, from = v.a, why = 'middle', step = null;
  if (S.split) { split = c.dayStart(c.fromIso(S.split)); why = 'chosen'; }
  else if (stepsFound.length) { step = stepsFound.at(-1); split = step.t; from = stepsFound.at(-2)?.t ?? v.a; why = 'detected'; }
  if (split <= v.a || split >= v.b) { split = middle; from = v.a; why = 'middle'; }

  const before = events.filter(e => e[0] >= from && e[0] < split), after = events.filter(e => e[0] >= split);
  const sb = genSpeed(before, mi), sa = genSpeed(after, mi), index = speedIndex(before, after, mi);
  const turns = turnBreakdown(events, mi);
  const tb = turns.filter(t => t.start >= from && t.start < split), ta = turns.filter(t => t.start >= split);
  const pb = pool(tb), pa = pool(ta), all = pool(turns);
  const ttft = list => { const xs = list.map(t => t.ttft).filter(x => x != null); return xs.length ? median(xs) : null; };
  const durB = tb.length ? median(tb.map(t => t.total)) : null, durA = ta.length ? median(ta.map(t => t.total)) : null;

  // ---------- why the mean task time changed ----------
  const mean = (p, k) => p.n ? p[k] / p.n : 0;
  const L = Number.isFinite(index.change) ? index.change : 0;
  const modelA = mean(pa, 'model'), atOld = modelA * (1 + L); // later generation time at the earlier speed
  const steps = [
    {key: 'before', label: 'Before', kind: 'total', value: mean(pb, 'total'), note: `${num(pb.n)} ${plural(pb.n, 'task', 'tasks')} before the split`},
    {key: 'speed', label: 'Speed', value: modelA - atOld, note: 'Generation time from a slower or faster model, like for like by model and context size'},
    {key: 'volume', label: 'Output', value: atOld - mean(pb, 'model'), note: 'Generation time from more or less output and context per task, at the earlier speed'},
    ...SECONDARY.map(k => ({key: k, label: PARTS.find(p => p.key === k).label.split(',')[0], value: mean(pa, k) - mean(pb, k)})),
    {key: 'after', label: 'After', kind: 'total', value: mean(pa, 'total'), note: `${num(pa.n)} ${plural(pa.n, 'task', 'tasks')} after the split`},
  ];

  // ---------- verdict ----------
  const outsideB = pb.total ? 1 - pb.model / pb.total : NaN, outsideA = pa.total ? 1 - pa.model / pa.total : NaN;
  const findings = [];
  if (sb.n < 30 || sa.n < 30 || tb.length < 5 || ta.length < 5) findings.push({code: 'thin', chip: 'neutral', text: 'Not enough timed responses'});
  else {
    if (index.change < -.1) findings.push({code: 'slower', chip: 'bad', text: 'Generation slowed'});
    else if (index.change > .1) findings.push({code: 'faster', chip: 'ok', text: 'Generation sped up'});
    if (outsideA - outsideB > .05) findings.push({code: 'outside', chip: 'warn', text: 'More time outside the model'});
    if (change(pa.out / pa.n, pb.out / pb.n) > .15) findings.push({code: 'more', chip: 'neutral', text: 'More output per task'});
    if (!findings.length) findings.push({code: 'stable', chip: 'neutral', text: 'No clear change'});
  }
  return {v, split, from, why, step, stepsFound, daily, days, before, after, sb, sa, index, turns, tb, ta, pb, pa, all, durB, durA,
    ttftB: ttft(tb), ttftA: ttft(ta), steps, outsideB, outsideA, findings};
}

// Per project: speed and how task time splits, before and after the split.
function projectRows(A) {
  const D = ctx.D, mi = D.mi, rows = new Map();
  const row = idx => {
    const cwd = D.sessions[idx]?.cwd || '', key = projectKey(cwd);
    let r = rows.get(key);
    if (!r) rows.set(key, r = {key, name: cwd ? projectName(cwd) : 'No directory', b: [], a: [], turns: []});
    return r;
  };
  for (const e of A.before) row(e[3]).b.push(e);
  for (const e of A.after) row(e[3]).a.push(e);
  for (const t of A.turns) row(t.session).turns.push(t);
  return [...rows.values()].filter(r => r.turns.length || r.a.length + r.b.length >= MIN_CELL).map(r => {
    const p = pool(r.turns), tb = r.turns.filter(t => t.start >= A.from && t.start < A.split), ta = r.turns.filter(t => t.start >= A.split);
    const s = genSpeed([...r.b, ...r.a], mi);
    return {...r, p, speed: s.speed, timed: s.n, index: speedIndex(r.b, r.a, mi).change,
      task: r.turns.length ? median(r.turns.map(t => t.total)) : null,
      taskChange: tb.length >= 3 && ta.length >= 3 ? median(ta.map(t => t.total)) / median(tb.map(t => t.total)) - 1 : NaN,
      share: k => p.total ? p[k] / p.total : null,
      effective: p.total ? p.out / p.total : null, burn: p.total ? p.tokens / (p.total / 60) : null};
  }).sort((p, q) => q.p.total - p.p.total || q.timed - p.timed);
}

export function speedPage() {
  const D = ctx.D, c = ctx.clock, S = state.speed, mi = D.mi;
  const A = analyseSpeed();
  if (!A) return [card('Task speed', {}, h('div', {class: 'empty'},
    'No timing in the history of this profile. Response times come from turn records, which Codex writes since mid-2026; rescan after updating Codex.'))];
  const set = patch => { Object.assign(S, patch); saveState(); ctx.render(); };
  const {v, split, from, why, sb, sa, index, pb, pa, all} = A;
  const splitText = c.dateY(split), baseText = from > v.a ? `${c.date(from)} – ${c.date(split - 1)}` : `before ${c.date(split)}`;

  ctx.bar = h('div', {class: 'bar-group'},
    h('label', {class: 'inline-field'}, h('span', {}, 'Split at'),
      h('input', {type: 'date', value: S.split || c.iso(c.day(split)), min: c.iso(v.fromDay + 1), max: c.iso(v.toDay), onchange: e => set({split: e.target.value})})),
    S.split ? h('button', {type: 'button', class: 'ghost small', onclick: () => set({split: ''}), title: 'Split where the generation speed changed, or in the middle of the range'}, 'Auto') : null);

  // ---------- headline ----------
  const whyText = why === 'detected' ? `the latest step in generation speed (${changeText(A.step.change)})` : why === 'chosen' ? 'the date you chose' : 'the middle of the range (no clear step in speed)';
  const thin = A.findings[0].code === 'thin';
  const drivers = A.steps.filter(st => !st.kind).sort((p, q) => Math.abs(q.value) - Math.abs(p.value)).filter(st => Math.abs(st.value) >= .5).slice(0, 3);
  const taskDelta = A.steps.at(-1).value - A.steps[0].value;
  const lede = thin
    ? [`Not enough timed responses on both sides of ${splitText} (${num(sb.n)} before, ${num(sa.n)} after). Widen the date range or move the split.`]
    : ['An average task took ', h('b', {}, secs(A.steps[0].value)), ' before and ', h('b', {}, secs(A.steps.at(-1).value)), ` after (${changeText(change(A.steps.at(-1).value, A.steps[0].value))}). `,
      drivers.length ? [`Of the ${taskDelta >= 0 ? '+' : '−'}${secs(Math.abs(taskDelta))}: `, drivers.map((st, i) => [i ? ', ' : '',
        h('b', {}, `${st.value >= 0 ? '+' : '−'}${secs(Math.abs(st.value))}`), ` ${st.key === 'speed' ? 'from generation speed' : st.key === 'volume' ? 'from more or less output' : st.label.toLowerCase()}`]), '.'] : null];
  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'}, h('div', {class: 'headline-text'},
    h('div', {class: 'eyebrow'}, `${from > v.a ? baseText : 'Before'} vs since ${splitText} · split at ${whyText}`),
    h('p', {class: 'lede'}, A.findings.map(f => [h('span', {class: ['chip', f.chip]}, f.text), ' ']), lede),
    h('ul', {class: 'facts'},
      h('li', {}, 'Generation speed: ', h('b', {}, `${tps(sb.speed)} → ${tps(sa.speed)}`),
        `; like for like (same model and context size) ${changeText(index.change)}`, index.coverage < .8 ? h('span', {class: 'muted'}, ` · compares ${share(index.coverage, 1, 0)} of the later generation time`) : null),
      h('li', {}, 'Time to first token, median per task: ', h('b', {}, `${secs(A.ttftB)} → ${secs(A.ttftA)}`)),
      h('li', {}, 'Share of task time outside the model: ', h('b', {}, `${share(A.outsideB, 1, 0)} → ${share(A.outsideA, 1, 0)}`), ` (${ppText(A.outsideA - A.outsideB)})`),
      h('li', {}, 'Median task: ', h('b', {}, `${secs(A.durB)} → ${secs(A.durA)}`), `; responses per task ${num(pb.n ? pb.responses / pb.n : 0, 1)} → ${num(pa.n ? pa.responses / pa.n : 0, 1)}`),
      A.stepsFound.length ? h('li', {}, 'Steps in like-for-like daily speed: ', A.stepsFound.map((st, i) => [i ? ', ' : '', h('b', {}, `${c.date(st.t)} ${changeText(st.change)}`), ' ',
        h('button', {type: 'button', class: 'link small', onclick: () => set({split: c.iso(c.day(st.t))})}, 'split here')])) : null))));

  // ---------- tiles ----------
  const vsNote = `vs ${baseText}`;
  const tiles = h('div', {class: 'tiles'},
    tile('Generation speed', tps(sa.speed), 'output tokens per second of generation', {delta: index.change, deltaNote: 'like for like ' + vsNote, class: 'hero'}),
    tile('Time to first token', secs(A.ttftA), 'median per task', {delta: change(A.ttftA, A.ttftB), deltaNote: vsNote}),
    tile('Median task', secs(A.durA), `${num(pa.n)} ${plural(pa.n, 'task', 'tasks')} after the split`, {delta: change(A.durA, A.durB), deltaNote: vsNote}),
    tile('Model share of task time', share(pa.model, pa.total, 0), `${ppText((pa.total ? pa.model / pa.total : NaN) - (pb.total ? pb.model / pb.total : NaN))} ${vsNote}`),
    tile('Effective speed', tps(pa.total ? pa.out / pa.total : null), 'output per second of task time', {delta: change(pa.total ? pa.out / pa.total : NaN, pb.total ? pb.out / pb.total : NaN), deltaNote: vsNote}),
    tile('Token burn', pa.total ? `${compact(pa.tokens / (pa.total / 60))}/min` : '—', 'all tokens per minute of task time', {delta: change(pa.total ? pa.tokens / pa.total : NaN, pb.total ? pb.tokens / pb.total : NaN), deltaNote: vsNote}));

  // ---------- trends ----------
  const gran = granularity(v) === 'hour' ? 'day' : granularity(v), bs = buckets(v, gran);
  const at = t => bs.findIndex(b => t >= b.start && t < b.end);
  const si = at(split), marks = si >= 0 ? [{i: si - .5 + (split - bs[si].start) / (bs[si].end - bs[si].start), label: `split · ${c.date(split)}`}] : [];
  const labels = bs.map(b => ({label: b.label, short: b.short}));
  const perModel = new Map();
  for (const e of v.events) {
    if (!timed(e)) continue;
    const i = at(e[0]); if (i < 0) continue;
    let m = perModel.get(e[1]);
    if (!m) perModel.set(e[1], m = bs.map(() => ({out: 0, gen: 0, n: 0})));
    m[i].out += e[5][mi.output_tokens] || 0; m[i].gen += e[8]; m[i].n++;
  }
  const speedSeries = [...perModel.entries()].sort((p, q) => p[0] - q[0]).map(([m, xs]) => ({key: m, label: D.models[m], color: color(D.models[m]),
    values: xs.map(x => x.n >= MIN_BUCKET && x.gen ? x.out / x.gen : null)}));
  const speedCard = card('Generation speed by model', {
    sub: `Output tokens per second of generation, pooled over the responses of each ${gran}; at least ${MIN_BUCKET} responses per point. Generation time runs from the moment the request is complete to the end of the response, so it includes the time to first token.`,
    actions: info('Each response is timed from its last input (the user message, tool output or previous response) to the usage record the model returns. Compaction calls are left out. A larger uncached context makes the start of a response slower, so the like-for-like index below compares responses of the same model and context size.')},
  chartBox(el => lines(el, {labels, series: speedSeries, height: 280, marks, fmt: x => num(x, x < 10 ? 1 : 0), emptyText: 'No timed responses in this range'})),
  legend(speedSeries.map(sr => ({label: sr.label, color: sr.color, line: true}))));

  const daily = dailyIndex(v.events, mi, bs, at);
  const ttftBy = bs.map(() => []), parts = bs.map(() => Object.fromEntries(PARTS.map(p => [p.key, 0])));
  for (const t of A.turns) {
    const i = at(t.start); if (i < 0) continue;
    if (t.ttft != null) ttftBy[i].push(t.ttft);
    for (const p of PARTS) parts[i][p.key] += t[p.key];
  }
  const latencyCard = card('Like-for-like speed and first token', {
    sub: 'Speed index: generation speed against the whole range for the same model and context size (100 = range average). Time to first token: median per task, as Codex reports it.'},
  chartBox(el => lines(el, {labels, height: 240, marks, ref: {value: 100, label: 'range = 100'}, fmt: x => num(x), series: [
    {key: 'index', label: 'Speed index', color: 'var(--s1)', values: daily.map(x => x == null ? null : 100 * x)}]})),
  chartBox(el => lines(el, {labels, height: 160, marks, fmt: x => secs(x), series: [
    {key: 'ttft', label: 'Time to first token', color: 'var(--s2)', values: ttftBy.map(xs => xs.length >= 3 ? median(xs) : null)}]})),
  legend([{label: 'Speed index', color: 'var(--s1)', line: true}, {label: 'Time to first token (median)', color: 'var(--s2)', line: true}]));

  const showShare = S.view === 'share';
  const values = new Map(bs.map((b, i) => {
    const total = PARTS.reduce((n, p) => n + parts[i][p.key], 0);
    return [b.key, Object.fromEntries(PARTS.map(p => [p.key, showShare ? (total ? parts[i][p.key] / total : 0) : parts[i][p.key] / 3600]))];
  }));
  const timeCard = card('Where task time goes', {
    sub: `Wall-clock time of tasks (turns of main sessions) by when they started. Tool time counts as auto-review or subagent time while such a session was busy. Parallel sessions add up, so a day can hold more than 24 agent-hours.`,
    actions: segmented([['hours', 'Hours'], ['share', 'Share']], showShare ? 'share' : 'hours', x => set({view: x}), {class: 'small', label: 'Scale'})},
  chartBox(el => columns(el, {buckets: bs, series: PARTS, values, height: 260, fmt: showShare ? x => share(x, 1, 0) : x => `${num(x, x < 10 ? 1 : 0)} h`, emptyText: 'No timed tasks in this range'})),
  legend(PARTS));

  const fallCard = card('Why the average task changed', {
    sub: `Mean task time ${baseText} and since ${splitText}, and what each part added. Speed and output split the change in generation time: at the earlier speed, more output would have taken this much longer anyway.`},
  chartBox(el => waterfall(el, A.steps, {fmt: secs, height: 260})));

  // ---------- by context size ----------
  const byBucket = (events, k) => { const s = {out: 0, gen: 0, n: 0}; for (const e of events) if (timed(e) && contextBucket(e[6] || 0) === k) { s.out += e[5][mi.output_tokens] || 0; s.gen += e[8]; s.n++; } return s; };
  const ctxRows = CONTEXT_BUCKETS.map(([, , label], k) => {
    const b = byBucket(A.before, k), a = byBucket(A.after, k);
    return {k, label, b, a, sb: b.gen ? b.out / b.gen : null, sa: a.gen ? a.out / a.gen : null};
  }).filter(r => r.b.n + r.a.n);
  const pair = (bv, av, fmt) => [fmt(bv), h('span', {class: 'muted'}, ' → '), fmt(av)];
  const ctxCard = card('Speed by context size', {sub: 'If the speed fell in every row, inference got slower; if only the mix moved to bigger contexts, the prefill did.'},
    table({rows: ctxRows, pageSize: 10, csvName: 'speed-by-context', columns: [
      {key: 'k', label: 'Context', value: r => r.k, render: r => r.label, csv: r => r.label},
      {key: 'n', label: 'Responses', num: true, value: r => r.a.n, render: r => pair(r.b.n, r.a.n, x => num(x)), csv: r => `${r.b.n} → ${r.a.n}`},
      {key: 'sa', label: 'Speed', num: true, value: r => r.sa, render: r => pair(r.sb, r.sa, tps), csv: r => `${r.sb} → ${r.sa}`},
      {key: 'change', label: 'Change', num: true, value: r => change(r.sa, r.sb), render: r => r.b.n >= MIN_CELL && r.a.n >= MIN_CELL ? changeText(change(r.sa, r.sb)) : '—'},
      {key: 'gen', label: 'Per response', num: true, value: r => r.a.n ? r.a.gen / r.a.n : null, render: r => pair(r.b.n ? r.b.gen / r.b.n : null, r.a.n ? r.a.gen / r.a.n : null, secs), title: 'Mean generation time per response'},
    ]}));

  // ---------- by model ----------
  const models = new Map();
  for (const e of [...A.before, ...A.after]) { if (!timed(e)) continue; let m = models.get(e[1]); if (!m) models.set(e[1], m = {model: D.models[e[1]], i: e[1], b: [], a: []}); (e[0] < split ? m.b : m.a).push(e); }
  const ttftOf = (m, list) => { const xs = list.filter(t => t.mainModel === m && t.ttft != null).map(t => t.ttft); return xs.length ? median(xs) : null; };
  const modelRows = [...models.values()].map(m => ({...m, sb: genSpeed(m.b, mi), sa: genSpeed(m.a, mi), index: speedIndex(m.b, m.a, mi).change,
    tb: ttftOf(m.i, A.tb), ta: ttftOf(m.i, A.ta)})).sort((p, q) => q.sb.n + q.sa.n - p.sb.n - p.sa.n);
  const modelCard = card('By model', {sub: 'Like for like compares each model with itself at the same context size.'},
    table({rows: modelRows, pageSize: 10, csvName: 'speed-by-model', onRow: r => toggleModel(r.model), columns: [
      {key: 'model', label: 'Model', value: r => r.model, render: r => modelDot(r.model)},
      {key: 'n', label: 'Responses', num: true, value: r => r.sa.n, render: r => pair(r.sb.n, r.sa.n, x => num(x)), csv: r => `${r.sb.n} → ${r.sa.n}`},
      {key: 'speed', label: 'Speed', num: true, value: r => r.sa.speed, render: r => pair(r.sb.speed, r.sa.speed, tps), csv: r => `${r.sb.speed} → ${r.sa.speed}`},
      {key: 'index', label: 'Like for like', num: true, value: r => Number.isFinite(r.index) ? r.index : null, render: r => Math.abs(r.index) > .1 ? h('b', {}, changeText(r.index)) : changeText(r.index)},
      {key: 'ttft', label: 'First token', num: true, value: r => r.ta, render: r => pair(r.tb, r.ta, secs), csv: r => `${r.tb} → ${r.ta}`, title: 'Median time to first token of tasks run mainly on this model'},
    ]}));

  // ---------- by project ----------
  const projects = projectRows(A);
  const pct0 = x => x == null ? '—' : share(x, 1, 0);
  const projCard = card('By project', {
    sub: `Over the whole range. Effective speed is output per second of task time; token burn is how fast tokens go per minute of task time. Change columns compare since ${c.date(split)} with ${baseText}. Click a row to filter every page to that project.`},
  table({rows: projects, pageSize: 15, csvName: 'speed-by-project', onRow: r => toggleProject(r.key), columns: [
    {key: 'name', label: 'Project', value: r => r.name},
    {key: 'turns', label: 'Tasks', num: true, value: r => r.turns.length},
    {key: 'task', label: 'Median task', num: true, value: r => r.task, render: r => secs(r.task), csv: r => r.task},
    {key: 'taskChange', label: 'Task Δ', num: true, value: r => Number.isFinite(r.taskChange) ? r.taskChange : null, render: r => changeText(r.taskChange), title: 'Median task time after the split against before'},
    {key: 'speed', label: 'Speed', num: true, value: r => r.speed, render: r => tps(r.speed), csv: r => r.speed},
    {key: 'index', label: 'Speed Δ', num: true, value: r => Number.isFinite(r.index) ? r.index : null, render: r => Math.abs(r.index) > .1 ? h('b', {}, changeText(r.index)) : changeText(r.index), title: 'Like-for-like generation speed after the split against before'},
    {key: 'model', label: 'Model', num: true, value: r => r.share('model'), render: r => pct0(r.share('model')), title: 'Share of task time the model was generating'},
    {key: 'tools', label: 'Tools', num: true, value: r => r.share('tools'), render: r => pct0(r.share('tools'))},
    {key: 'secondary', label: 'Review + sub + compact', num: true, value: r => r.p.total ? (r.p.review + r.p.subagent + r.p.compaction) / r.p.total : null,
      render: r => pct0(r.p.total ? (r.p.review + r.p.subagent + r.p.compaction) / r.p.total : null), title: 'Auto-review, subagents and compaction'},
    {key: 'effective', label: 'Effective', num: true, value: r => r.effective, render: r => tps(r.effective), csv: r => r.effective},
    {key: 'burn', label: 'Tokens / min', num: true, value: r => r.burn, render: r => r.burn == null ? '—' : compact(r.burn), csv: r => r.burn},
  ]}));

  // ---------- slowest tasks ----------
  const slow = [...A.turns].sort((p, q) => q.total - p.total);
  const taskCard = card('Longest tasks', {sub: `Every task in the range by wall-clock time (${num(all.n)} ${plural(all.n, 'task', 'tasks')}, ${duration(all.total)} in total).`},
    table({rows: slow, pageSize: 10, csvName: 'tasks', columns: [
      {key: 'start', label: 'Started', value: t => t.start, render: t => c.dateTime(t.start)},
      {key: 'project', label: 'Project', value: t => projectName(D.sessions[t.session]?.cwd || '') || '—'},
      {key: 'mainModel', label: 'Model', value: t => D.models[t.mainModel], render: t => modelDot(D.models[t.mainModel])},
      {key: 'total', label: 'Time', num: true, value: t => t.total, render: t => secs(t.total)},
      {key: 'responses', label: 'Responses', num: true, value: t => t.responses},
      {key: 'speed', label: 'Speed', num: true, value: t => t.model ? t.out / t.model : null, render: t => tps(t.model ? t.out / t.model : null)},
      {key: 'model', label: 'Model time', num: true, value: t => t.total ? t.model / t.total : null, render: t => share(t.model, t.total, 0)},
      {key: 'outside', label: 'Outside the model', num: true, value: t => t.total - t.model, render: t => secs(t.total - t.model),
        title: 'Tools, approvals, auto-review, subagents, compaction and other time'},
    ]}));

  return [headline, tiles, speedCard, h('div', {class: 'grid'}, latencyCard, fallCard), timeCard, h('div', {class: 'grid'}, ctxCard, modelCard), projCard, taskCard];
}

// ---------- overview ----------
// One line for the overview signals.
export function speedLine() {
  const A = analyseSpeed();
  if (!A) return 'No response timing in this history';
  if (A.findings[0].code === 'thin') return `Generation ${tps(A.sa.speed ?? A.sb.speed)}; not enough data to compare`;
  return `Since ${ctx.clock.date(A.split)}: generation ${changeText(A.index.change)} like for like, model ${share(A.pa.model, A.pa.total, 0)} of task time`;
}

// Overview tile: generation speed of the selected period, like for like against the previous one.
export function speedTile(v, n) {
  const D = ctx.D, c = ctx.clock, mi = D.mi;
  D.hasTiming ??= D.events.some(e => e[8] != null);
  if (!D.hasTiming) return null;
  const s = genSpeed(v.events, mi), index = speedIndex(v.previous, v.events, mi);
  const out = Array(n).fill(0), gen = Array(n).fill(0);
  for (const e of v.events) { if (!timed(e)) continue; const i = c.day(e[0]) - v.fromDay; if (i >= 0 && i < n) { out[i] += e[5][mi.output_tokens] || 0; gen[i] += e[8]; } }
  const spark = n >= 2 ? sparkline(gen.map((g, i) => g ? out[i] / g : null), {width: 150, height: 28, color: 'var(--ink-2)', focus: -1}) : null;
  spark?.setAttribute('preserveAspectRatio', 'none');
  return tile('Generation speed', tps(s.speed), 'output tokens per second', {delta: index.change, deltaNote: 'like for like vs previous period', spark,
    title: 'Pooled over timed responses. The change compares the same model and context size, so bigger contexts or another model do not count as slower inference.'});
}
