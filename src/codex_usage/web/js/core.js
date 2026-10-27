// Shared state, API access, filtering/aggregation and UI building blocks.
import {locales, h, fill, num, compact, csv, download, store, Clock, projectName, projectKey} from './util.js';

// ---------- API ----------
export const api = {
  async get(url) {
    const r = await fetch(url, {headers: {Accept: 'application/json'}});
    const body = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
    if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), {status: r.status, body});
    return body;
  },
  async post(url, data) {
    const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(data || {})});
    const body = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
    if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), {status: r.status, body});
    return body;
  },
};

// ---------- state ----------
export const defaults = {
  profile: null, range: {preset: '30d', from: null, to: null}, tz: null, tzPreference: 'auto', metric: 'total_tokens',
  models: [], project: '', internal: false, gran: 'auto', theme: 'auto',
  quota: {key: null, threshold: 98, period: 3},
  analysis: {tolerance: 180, start_used_max: 2, dominance: .95, exclude: []},
  sessions: {q: '', project: '', kind: 'main', model: ''},
  compare: true,
  review: {unit: 'week', at: null, measure: 'tokens'},
  watch: {key: null, basis: 'total_tokens', sample: 'per', recent: 14, baseline: 60},
  anatomy: {rows: 'model', cols: 'context'},
  context: {kind: 'main', session: null},
  budget: {key: null, scope: 'window'},
  work: {key: null, split: '', weights: '0.1:8', measure: 'fresh'},
};
export const state = Object.assign(structuredClone(defaults), store.get('state', {}));
for (const k of ['range', 'quota', 'analysis', 'sessions', 'review', 'watch', 'anatomy', 'context', 'budget', 'work']) state[k] = Object.assign(structuredClone(defaults[k]), state[k] || {});
export function saveState() { store.set('state', state); }

// ctx.bar: page-specific controls that the sticky header shows next to the global filters.
export const ctx = {D: null, clock: null, meta: null, profiles: [], bar: null, render: () => {}, go: () => {}};

// Categorical palette (validated reference order); colour follows the model, never its rank in a filter.
const SLOTS = 8;
export function color(model) {
  if (model === '__mixed__') return 'var(--mixed)';
  const i = ctx.D ? ctx.D.models.indexOf(model) : -1;
  return i >= 0 && i < SLOTS ? `var(--s${i + 1})` : 'var(--other)';
}
export const modelName = m => m === '__mixed__' ? 'Mixed models' : m;

// ---------- dataset ----------
export function prepare(raw) {
  const D = raw;
  D.mi = Object.fromEntries(D.metric_keys.map((k, i) => [k, i]));
  D.sessionIndex = new Map(D.sessions.map((sess, i) => [sess.id, i]));
  // Project of every session, and all projects ordered by total tokens (for the global project filter).
  D.sessionProject = D.sessions.map(sess => projectKey(sess.cwd || ''));
  const totals = new Map();
  for (const e of D.events) { const k = D.sessionProject[e[3]]; totals.set(k, (totals.get(k) || 0) + (e[5][D.mi.total_tokens] || 0)); }
  const names = new Map(D.sessions.map((sess, i) => [D.sessionProject[i], sess.cwd ? projectName(sess.cwd) : 'No directory']));
  D.projects = [...totals.entries()].sort((p, q) => q[1] - p[1]).map(([key, total]) => ({key, name: names.get(key), total}));
  D.quotaKeys = Object.keys(D.quota_series).sort((p, q) => Number(p.split('|')[1]) - Number(q.split('|')[1]));
  D.firstTs = D.events.length ? D.events[0][0] : null;
  D.lastTs = D.events.length ? D.events[D.events.length - 1][0] : null;
  return D;
}

export function metricLabel(key) { return ctx.D?.metric_labels[key] || key; }
export function metricUnit(key) { return key === 'responses' ? 'responses' : 'tokens'; }

export function resolveRange(clock = ctx.clock) {
  const today = clock.today(), r = state.range;
  let from, to;
  switch (r.preset) {
    case 'today': from = to = today; break;
    case '7d': from = today - 6; to = today; break;
    case '90d': from = today - 89; to = today; break;
    case 'month': from = clock.monthStartDay(today); to = today; break;
    case 'all': from = ctx.D?.firstTs ? clock.day(ctx.D.firstTs) : today - 29; to = Math.max(today, ctx.D?.lastTs ? clock.day(ctx.D.lastTs) : today); break;
    case 'custom': from = r.from ? clock.fromIso(r.from) : today - 29; to = r.to ? clock.fromIso(r.to) : today; break;
    default: from = today - 29; to = today;
  }
  if (to < from) [from, to] = [to, from];
  return {fromDay: from, toDay: to, a: clock.dayStart(from), b: clock.dayStart(to + 1), days: to - from + 1};
}

let memo = {key: null, value: null};
// Filtered events for the global filter bar; every chart and table below reads from this one slice.
export function view() {
  const D = ctx.D, r = resolveRange();
  const key = JSON.stringify([D.generated_at, r.a, r.b, state.models, state.project, state.internal, state.tz]);
  if (memo.key === key) return memo.value;
  const models = state.models.length ? new Set(state.models.map(m => D.models.indexOf(m)).filter(i => i >= 0)) : null;
  const keep = filterEvent(models);
  const events = [], previous = [];
  const span = r.b - r.a;
  for (const e of D.events) {
    if (e[0] >= r.a && e[0] < r.b) { if (keep(e)) events.push(e); }
    else if (e[0] >= r.a - span && e[0] < r.a && keep(e)) previous.push(e);
  }
  memo = {key, value: {...r, events, previous, models}};
  return memo.value;
}
// The global filters that apply to individual responses: internal reviews, models, project.
function filterEvent(models) {
  const D = ctx.D, project = state.project && D.projects?.some(p => p.key === state.project) ? state.project : null;
  return e => (state.internal || !e[2]) && (!models || models.has(e[1])) && (!project || D.sessionProject[e[3]] === project);
}

export function invalidate() { memo = {key: null, value: null}; }

// Events in [a, b) under the model/internal filters, independently of the global date range.
export function eventsBetween(a, b) {
  const D = ctx.D;
  const keep = filterEvent(state.models.length ? new Set(state.models.map(m => D.models.indexOf(m))) : null);
  let lo = 0, hi = D.events.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (D.events[mid][0] < a) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < D.events.length && D.events[i][0] < b; i++) {
    const e = D.events[i];
    if (keep(e)) out.push(e);
  }
  return out;
}

// ---------- calendar periods (day / week / month) ----------
export const unitNames = {day: 'Day', week: 'Week', month: 'Month'};
export function periodStart(unit, day, clock = ctx.clock) {
  if (unit === 'week') return day - (day + 3) % 7;
  if (unit === 'month') return clock.monthStartDay(day);
  return day;
}
export function periodShift(unit, startDay, n, clock = ctx.clock) {
  if (unit === 'day') return startDay + n;
  if (unit === 'week') return startDay + 7 * n;
  let d = startDay;
  for (let i = 0; i < Math.abs(n); i++) d = n > 0 ? clock.nextMonthDay(d) : clock.monthStartDay(d - 1);
  return d;
}
export function period(unit, startDay, clock = ctx.clock) {
  const endDay = periodShift(unit, startDay, 1, clock);
  const a = clock.dayStart(startDay), b = clock.dayStart(endDay);
  const label = unit === 'day' ? clock.weekdayDate(a) : unit === 'month' ? clock.month(a) : `${clock.date(a)} – ${clock.date(b - 1)}`;
  const short = unit === 'month' ? clock.month(a).split(' ')[0] : clock.date(a);
  return {unit, startDay, endDay, a, b, days: endDay - startDay, label, short, key: startDay};
}

// ---------- quota burn ----------
// Percentage points of a quota counter consumed inside [a, b): the sum of increases of the
// monotone per-epoch series, with each new epoch starting from zero.
export function quotaBurn(qkey, a, b) {
  const D = ctx.D, points = D.quota_series[qkey] || [];
  let burn = 0, prev = null;
  for (const p of points) {
    const [t, used, reset, refill] = p;
    const fresh = !prev || refill || Math.abs(reset - prev[2]) > 600;
    const inc = fresh ? used : Math.max(0, used - prev[1]);
    if (t >= a && t < b) burn += inc;
    prev = p;
    if (t >= b) break;
  }
  const [limitId, minutes] = qkey.split('|');
  const ws = D.windows.filter(w => w.limit_id === limitId && w.minutes === Number(minutes));
  let started = 0, full = 0, locked = 0;
  ws.forEach((w, i) => {
    if (w.start >= a && w.start < b) { started++; if (w.full) full++; }
    if (w.full) {
      const until = Math.min(w.deadline, ws[i + 1]?.start ?? Infinity);
      locked += Math.max(0, Math.min(b, until) - Math.max(a, w.end));
    }
  });
  return {burn, started, full, locked, minutes: Number(minutes)};
}

// ---------- context size buckets ----------
export const CONTEXT_BUCKETS = [[0, 16e3, '< 16K'], [16e3, 32e3, '16–32K'], [32e3, 64e3, '32–64K'], [64e3, 128e3, '64–128K'],
  [128e3, 256e3, '128–256K'], [256e3, 512e3, '256–512K'], [512e3, Infinity, '512K +']];
export function contextBucket(tokens) {
  for (let i = 0; i < CONTEXT_BUCKETS.length; i++) if (tokens < CONTEXT_BUCKETS[i][1]) return i;
  return CONTEXT_BUCKETS.length - 1;
}

// ---------- context growth inside one session ----------
// A compaction is a sharp drop of the input context between consecutive responses.
export const COMPACTION = {drop: .6, min: 20e3};
// events: one session's events in time order; mi: metric index map (D.mi).
export function sessionContext(events, mi) {
  const n = events.length, steps = [], compactions = [], deltas = [];
  let peak = 0, window = 0, tokens = 0, input = 0, cached = 0, output = 0, heavy = 0, heavySteps = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const e = events[i], x = e[5], context = e[6] || 0;
    const total = x[mi.total_tokens] || 0, inp = x[mi.input_tokens] || 0, cache = x[mi.cached_input_tokens] || 0, out = x[mi.output_tokens] || 0;
    tokens += total; input += inp; cached += cache; output += out;
    if (e[7] > window) window = e[7];
    if (context > peak) peak = context;
    if (context && prev >= COMPACTION.min && context < prev * COMPACTION.drop) compactions.push({i, t: e[0], before: prev, after: context});
    else if (context && prev && context > prev) deltas.push(context - prev);
    if (context) prev = context;
    steps.push({t: e[0], context: context || null, total, uncached: Math.max(0, inp - cache), cached: cache, output: out, model: e[1]});
  }
  // "Heavy" responses ran with more than half of the model context window (128K when unknown).
  const half = window ? window / 2 : 128e3;
  for (const st of steps) if (st.context >= half) { heavy += st.total; heavySteps++; }
  // Context that a compaction removed would otherwise have been read again at every later step until the next one.
  let avoided = 0;
  compactions.forEach((cp, k) => { const until = compactions[k + 1]?.i ?? n; avoided += (cp.before - cp.after) * (until - cp.i); });
  const q = Math.floor(n / 4), mean = list => list.reduce((a, st) => a + st.total, 0) / list.length;
  const lateRatio = q >= 2 ? mean(steps.slice(n - q)) / (mean(steps.slice(0, q)) || NaN) : NaN;
  deltas.sort((a, b) => a - b);
  const growth = deltas.length ? deltas[Math.floor((deltas.length - 1) / 2)] : 0;
  return {steps, n, peak, window, half, tokens, input, cached, output, heavy, heavySteps, compactions, avoided, growth, lateRatio,
    first: events[0]?.[0], last: events[n - 1]?.[0]};
}

// ---------- context window changes ----------
// The context window a model reports can change with a new default. A change counts once the new value
// holds for `run` consecutive responses of that model, and is dated at the first of them.
export function windowChanges(events, run = 20) {
  const byModel = new Map(), out = [];
  for (const e of events) {
    const w = e[7];
    if (!w) continue;
    const st = byModel.get(e[1]);
    if (!st) { byModel.set(e[1], {cur: w, cand: null, n: 0, t: 0}); continue; }
    if (w === st.cur) { st.cand = null; st.n = 0; continue; }
    if (w !== st.cand) { st.cand = w; st.n = 0; st.t = e[0]; }
    if (++st.n >= run) { out.push({model: e[1], t: st.t, from: st.cur, to: w}); st.cur = w; st.cand = null; st.n = 0; }
  }
  return out;
}

// ---------- work per percent of quota ----------
// Tokens of one quota window per percentage point it used, split by kind. Cached input is context re-read
// from the cache; "fresh" (uncached input + output) is the new work. weights: {cached, output} relative to
// uncached input, e.g. API price ratios.
export function workRates(m, used, weights = {cached: .1, output: 8}) {
  const input = m.input_tokens || 0, cached = Math.min(input, m.cached_input_tokens || 0), output = m.output_tokens || 0;
  const uncached = input - cached, per = x => used > 0 ? x / used : null;
  return {total: per(m.total_tokens ?? input + output), cached: per(cached), uncached: per(uncached), output: per(output),
    fresh: per(uncached + output), weighted: per(uncached + cached * weights.cached + output * weights.output), responses: per(m.responses || 0)};
}

// ---------- quota pace and forecast ----------
// points: one counter's series [[ts, used, reset, refill?]]; q: its latest snapshot {used, reset, ts, minutes}.
// Pace is wall-clock growth over the lookback ending now (idle time counts), from the counter value at the
// start of the lookback; default lookback: 1 h for the five-hour quota, 24 h for longer ones.
export function quotaForecast(points, q, {now = Date.now() / 1000, lookback} = {}) {
  lookback ??= q.minutes <= 300 ? 3600 : 86400;
  const epoch = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p[0] > q.ts) continue;
    if (Math.abs(p[2] - q.reset) > 600) break;
    epoch.unshift(p);
    if (p[3]) break;
  }
  const start = Math.min(q.reset - q.minutes * 60, epoch[0]?.[0] ?? q.ts);
  const since = Math.max(start, now - lookback);
  // Counter value at `since`: the last snapshot at or before it, else a straight line from zero at the window start.
  const prior = epoch.filter(p => p[0] <= since).pop();
  const first = epoch[0] || [q.ts, q.used];
  const base = since <= start ? 0 : prior ? prior[1] : first[1] * (since - start) / Math.max(1, first[0] - start);
  const span = now - since;
  const rate = span > 60 ? Math.max(0, (q.used - base) / span) : 0; // percentage points per second
  const left = Math.max(0, 100 - q.used), toReset = Math.max(0, q.reset - now);
  const hitAt = rate > 0 && q.used < 100 ? now + left / rate : null;
  const hitsFirst = hitAt != null && hitAt < q.reset;
  const atReset = Math.min(100, q.used + rate * toReset);
  const days = toReset / 86400;
  return {rate: rate * 3600, hitAt, hitsFirst, atReset, budgetPerDay: days >= 1 ? left / days : null, lookback: span};
}

// ---------- which responses spent the quota ----------
// Each increase of the counter between two snapshots is split across the responses recorded in that
// interval, in proportion to their total tokens. points: one counter's series; events: D.events (time order);
// keep(e): which responses may receive a share. Returns per-event shares (event index → percentage points)
// and the increase that no response could explain (e.g. usage on another device).
export function attributeQuota(points, events, mi, minutes, a, b, keep = () => true) {
  const share = new Map();
  let attributed = 0, unattributed = 0, j = 0, prev = null;
  for (const p of points) {
    const fresh = !prev || p[3] || Math.abs(p[2] - prev[2]) > 600;
    const inc = fresh ? p[1] : Math.max(0, p[1] - prev[1]);
    // A new epoch can only contain responses after its window started.
    const from = fresh ? Math.max(prev ? prev[0] : -Infinity, p[2] - minutes * 60) : prev[0];
    prev = p;
    if (p[0] < a || p[0] >= b || !inc) continue;
    while (j < events.length && events[j][0] <= from) j++;
    let k = j, tokens = 0;
    for (; k < events.length && events[k][0] <= p[0]; k++) if (keep(events[k])) tokens += events[k][5][mi] || 0;
    if (!tokens) { unattributed += inc; continue; }
    for (let i = j; i < k; i++) if (keep(events[i])) {
      const t = events[i][5][mi] || 0;
      if (t) share.set(i, (share.get(i) || 0) + inc * t / tokens);
    }
    attributed += inc;
    j = k;
  }
  return {share, attributed, unattributed};
}

export const val = (e, mi) => e[5][mi] || 0;
export function sum(events, mi) { let n = 0; for (const e of events) n += e[5][mi] || 0; return n; }

// ---------- time buckets ----------
export function granularity(r) {
  if (state.gran !== 'auto') return state.gran;
  return r.days <= 2 ? 'hour' : r.days <= 92 ? 'day' : r.days <= 400 ? 'week' : 'month';
}

export function bucketer(gran, clock = ctx.clock) {
  if (gran === 'hour') return ts => clock.hourStart(ts);
  if (gran === 'day') return ts => clock.day(ts);
  if (gran === 'week') return ts => { const d = clock.day(ts); return d - (d + 3) % 7; };
  return ts => clock.monthStartDay(clock.day(ts));
}

export function buckets(r, gran, clock = ctx.clock) {
  const out = [];
  if (gran === 'hour') {
    for (let t = clock.hourStart(r.a); t < r.b; t += 3600) out.push({key: t, start: t, end: t + 3600, label: clock.dateTime(t), short: clock.hour(t) === 0 ? clock.date(t) : clock.time(t)});
    return out;
  }
  if (gran === 'day') {
    for (let d = r.fromDay; d <= r.toDay; d++) { const t = clock.dayStart(d); out.push({key: d, start: t, end: clock.dayStart(d + 1), label: clock.weekdayDate(t), short: clock.date(t)}); }
    return out;
  }
  if (gran === 'week') {
    for (let d = r.fromDay - (r.fromDay + 3) % 7; d <= r.toDay; d += 7) {
      const t = clock.dayStart(d), e = clock.dayStart(d + 7);
      out.push({key: d, start: t, end: e, label: `${clock.date(t)} – ${clock.date(e - 1)}`, short: clock.date(t)});
    }
    return out;
  }
  for (let d = clock.monthStartDay(r.fromDay); d <= r.toDay; d = clock.nextMonthDay(d)) {
    const t = clock.dayStart(d);
    out.push({key: d, start: t, end: clock.dayStart(clock.nextMonthDay(d)), label: clock.month(t), short: clock.month(t)});
  }
  return out;
}

export const granLabels = {auto: 'Auto', hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly'};

// ---------- aggregations ----------
export function byModel(events, mi) {
  const m = new Map();
  for (const e of events) m.set(e[1], (m.get(e[1]) || 0) + (e[5][mi] || 0));
  return [...m.entries()].map(([i, v]) => ({model: ctx.D.models[i], value: v})).sort((p, q) => q.value - p.value);
}

export function sessionStats(events, mi) {
  const D = ctx.D, out = new Map();
  for (const e of events) {
    let st = out.get(e[3]);
    if (!st) { st = {index: e[3], value: 0, total: 0, responses: 0, first: e[0], last: e[0], models: new Map(), efforts: new Map(), peakContext: 0, window: 0}; out.set(e[3], st); }
    const v = e[5][mi] || 0;
    st.value += v; st.total += e[5][D.mi.total_tokens] || 0; st.responses++;
    st.last = e[0];
    st.models.set(e[1], (st.models.get(e[1]) || 0) + v);
    st.efforts.set(e[4], (st.efforts.get(e[4]) || 0) + v);
    if (e[6] > st.peakContext) { st.peakContext = e[6]; st.window = e[7]; }
  }
  for (const st of out.values()) {
    st.session = D.sessions[st.index];
    st.mainModel = [...st.models.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
    st.mainEffort = [...st.efforts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
  }
  return out;
}

export function projectStats(sessions) {
  const out = new Map();
  for (const st of sessions.values()) {
    const cwd = st.session.cwd || '', key = projectKey(cwd);
    let p = out.get(key);
    if (!p) { p = {key, cwd, name: projectName(cwd), value: 0, responses: 0, sessions: 0, last: 0, models: new Map(), paths: new Set()}; out.set(key, p); }
    p.paths.add(cwd);
    p.value += st.value; p.responses += st.responses; p.sessions++; p.last = Math.max(p.last, st.last);
    for (const [m, v] of st.models) p.models.set(m, (p.models.get(m) || 0) + v);
  }
  return [...out.values()].sort((p, q) => q.value - p.value);
}

export const sourceNames = {vscode: 'Desktop / IDE', cli: 'Terminal', exec: 'codex exec', subagent: 'Subagent', review: 'Auto-review', unknown: 'Unknown', other: 'Other'};
export function sessionKind(sess) { return sess?.source === 'subagent' ? 'subagent' : sess?.source === 'review' ? 'review' : 'main'; }

// ---------- UI blocks ----------
export function card(title, opts = {}, ...body) {
  return h('section', {class: ['card', opts.class], id: opts.id || null},
    title || opts.actions ? h('header', {class: 'card-head'},
      h('div', {}, title ? h('h2', {}, title) : null, opts.sub ? h('p', {class: 'sub'}, opts.sub) : null),
      opts.actions ? h('div', {class: 'card-actions'}, opts.actions) : null) : null,
    body);
}

// "12.4M" → 12.4 + a quieter "M", so the digits carry the weight.
function splitUnit(value) {
  const m = typeof value === 'string' && /^([−+\-\d.,\s\u00a0\u202f]+?)\s?(K|M|B|T|%)$/.exec(value);
  return m ? [m[1], h('span', {class: 'unit'}, m[2])] : value;
}

export function tile(label, value, note, opts = {}) {
  return h('div', {class: ['tile', opts.class], title: opts.title || null},
    h('div', {class: 'tile-label'}, label),
    h('div', {class: 'tile-value'}, splitUnit(value)),
    opts.delta != null ? delta(opts.delta, opts.deltaNote) : null,
    note ? h('div', {class: 'tile-note'}, note) : null,
    opts.spark ? h('div', {class: 'tile-spark'}, opts.spark) : null);
}

export function delta(change, note) {
  if (!Number.isFinite(change)) return h('div', {class: 'delta flat'}, note || 'no comparison data');
  const up = change > 0.005, down = change < -0.005;
  return h('div', {class: ['delta', up ? 'up' : down ? 'down' : 'flat']},
    h('span', {'aria-hidden': 'true'}, up ? '▲ ' : down ? '▼ ' : '● '),
    (up ? '+' : '') + num(change * 100, Math.abs(change) < .1 ? 1 : 0) + '%', ' ', h('span', {class: 'muted'}, note || ''));
}

export function chartBox(render, opts = {}) {
  const el = h('div', {class: ['chart', opts.class]});
  queueMicrotask(() => render(el));
  el._render = () => render(el);
  return el;
}

export function segmented(options, value, onChange, opts = {}) {
  return h('div', {class: ['segmented', opts.class], role: 'radiogroup', 'aria-label': opts.label || null},
    options.map(([v, label]) => h('button', {type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : null,
      onclick: () => onChange(v)}, label)));
}

export function select(options, value, onChange, attrs = {}) {
  return h('select', {...attrs, onchange: e => onChange(e.target.value)},
    options.map(([v, label]) => h('option', {value: v, selected: String(v) === String(value)}, label)));
}

export function info(text) {
  return h('span', {class: 'info', tabindex: 0, title: text, 'aria-label': text}, 'i');
}

// Sortable table with paging and CSV export of every (not only visible) row.
export function table({columns, rows, sortKey, sortDir = -1, pageSize = 50, csvName, empty = 'No data', onRow, rowClass, caption}) {
  let key = sortKey ?? null, dir = sortDir, page = 0;
  const wrap = h('div', {class: 'table-wrap'});
  const draw = () => {
    const col = columns.find(c => c.key === key);
    const sorted = col ? [...rows].sort((p, q) => {
      const a = (col.sort || col.value)(p), b = (col.sort || col.value)(q);
      if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b, locales) : a - b) * dir;
    }) : rows;
    const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
    page = Math.min(page, pages - 1);
    const slice = sorted.slice(page * pageSize, (page + 1) * pageSize);
    const thead = h('thead', {}, h('tr', {}, columns.map(c => h('th', {class: [c.num && 'num', c.key === key && 'sorted'], scope: 'col', title: c.title || null},
      c.sortable === false ? c.label : h('button', {type: 'button', class: 'sort', onclick: () => { if (key === c.key) dir = -dir; else { key = c.key; dir = c.num ? -1 : 1; } draw(); }},
        c.label, c.key === key ? (dir > 0 ? ' ↑' : ' ↓') : '')))));
    const tbody = h('tbody', {}, slice.map(r => h('tr', {class: [onRow && 'clickable', rowClass?.(r)], tabindex: onRow ? 0 : null,
      onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? e => { if (e.key === 'Enter') onRow(r); } : null},
      columns.map(c => h('td', {class: [c.num && 'num', c.class]}, c.render ? c.render(r) : fmtCell(c.value(r), c))))));
    const tools = h('div', {class: 'table-tools'},
      h('span', {class: 'muted small'}, caption || `${num(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`),
      pages > 1 ? h('span', {class: 'pager'},
        h('button', {type: 'button', class: 'ghost small', disabled: page === 0, onclick: () => { page--; draw(); }}, '←'),
        h('span', {class: 'small'}, `${page + 1} / ${pages}`),
        h('button', {type: 'button', class: 'ghost small', disabled: page >= pages - 1, onclick: () => { page++; draw(); }}, '→')) : null,
      csvName ? h('button', {type: 'button', class: 'ghost small', onclick: () => download(csvName + '.csv', csv([
        columns.map(c => c.csvLabel || c.label), ...sorted.map(r => columns.map(c => c.csv ? c.csv(r) : c.value(r)))]))}, 'CSV') : null);
    fill(wrap, tools, rows.length ? h('div', {class: 'scroll'}, h('table', {}, thead, tbody)) : h('div', {class: 'empty'}, empty));
  };
  draw();
  return wrap;
}

function fmtCell(v, c) {
  if (v == null || v === '') return '—';
  if (c.fmt) return c.fmt(v);
  if (typeof v === 'number') return c.compact ? compact(v) : num(v);
  return String(v);
}

export function modelDot(model) {
  return h('span', {class: 'model'}, h('i', {class: 'swatch', style: {background: color(model)}}), modelName(model));
}

export function toast(text, kind = 'info', ms = 4200) {
  const el = h('div', {class: ['toast', kind], role: 'status'}, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 600);
}

export function newClock(tz) { return new Clock(tz); }

// Index into /static/img/icons.png (a single-row strip of alpha masks).
export const icon = i => h('i', {class: 'ico', style: {'--i': i}, 'aria-hidden': 'true'});
