// Analysis pages: overview, quota windows, models, sessions, projects.
import {locales, h, fill, num, compact, pct, share, duration, ago, quotaName, minutesLabel, median, projectName, projectKey, shortPath, plural} from './util.js';
import {columns, lines, quotaChart, timeColumns, barList, composition, legend, hideTip, rankList, miniColumns, sparkline} from './charts.js';
import {ctx, state, saveState, view, sum, byModel, sessionStats, projectStats, granularity, bucketer, buckets, granLabels,
  card, tile, chartBox, segmented, table, color, modelName, modelDot, metricLabel, metricUnit, sourceNames, sessionKind, info, select, quotaForecast,
  eventsBetween, period, periodStart, quotaBurn} from './core.js';
import {signals} from './focus.js';

const weekdayFormat = new Intl.DateTimeFormat(locales, {weekday: 'short', timeZone: 'UTC'});
const WEEKDAYS = Array.from({length: 7}, (_, day) => weekdayFormat.format(new Date(Date.UTC(2024, 0, 1 + day))));
const fmtMetric = v => state.metric === 'responses' ? num(v) : compact(v);

function grow(...children) { return h('div', {class: 'grid'}, children); }

// Cross-filter: clicking a project anywhere narrows every page to it; clicking it again clears the filter.
export function toggleProject(key) { state.project = state.project === key ? '' : key; saveState(); ctx.render(); }
export function toggleModel(model) { state.models = state.models.length === 1 && state.models[0] === model ? [] : [model]; saveState(); ctx.render(); }

// Bucket size lives in the sticky bar so it stays reachable next to the charts it changes.
export function granBar() {
  return h('div', {class: 'bar-group'}, h('span', {class: 'bar-label'}, 'Buckets'),
    segmented(Object.entries(granLabels), state.gran, g => { state.gran = g; saveState(); ctx.render(); }, {class: 'small', label: 'Buckets'}));
}
function compareToggle() {
  return h('label', {class: 'check small', title: 'Overlay the previous period of the same length'},
    h('input', {type: 'checkbox', checked: state.compare, onchange: e => { state.compare = e.target.checked; saveState(); ctx.render(); }}), 'Compare with previous period');
}

// ---------- quota helpers ----------
function windowValue(w, metric = state.metric) {
  return (w.metrics[metric] || 0) + (state.internal ? (w.internal_metrics[metric] || 0) : 0);
}
function perPercent(w) {
  const used = w.max_used - w.first_used;
  const total = (w.metrics.total_tokens || 0) + (state.internal ? (w.internal_metrics.total_tokens || 0) : 0);
  if (used < 10 || !total || w.exclusion_code === 'too_long' || w.exclusion_code === 'no_usage') return null;
  return total / used;
}
function recentPerPercent(minutes, days = 30) {
  const since = Date.now() / 1000 - days * 86400;
  const values = ctx.D.windows.filter(w => w.minutes === minutes && w.start >= since).map(perPercent).filter(v => v != null);
  return {value: median(values), n: values.length};
}

// Live quota counters: one compact card each, with the pace forecast in one line.
function quotaCards() {
  const D = ctx.D, now = Date.now() / 1000, c = ctx.clock;
  return D.quota_now.map(q => {
    const expired = q.reset <= now, used = expired ? 0 : q.used;
    const level = used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'good';
    const f = !expired ? quotaForecast(D.quota_series[`${q.limit_id}|${q.minutes}`] || [], q, {now}) : null;
    const est = recentPerPercent(q.minutes);
    const left = est.n >= 3 && !expired ? est.value * (100 - used) : null;
    const why = 'Pace = growth of this counter over the last hour (five-hour quota) or day (longer quotas), idle time included, extended in a straight line.';
    let line = null;
    if (expired) line = h('span', {class: 'chip ok'}, 'restored');
    else if (used >= 100) line = h('span', {class: 'chip bad'}, 'at the limit');
    else if (f.rate < .05) line = [h('span', {class: 'chip'}, 'idle'), ' no recent growth'];
    else if (f.hitsFirst) line = [h('span', {class: 'chip bad'}, 'limit first'), ' 100% in ', h('b', {}, duration(f.hitAt - now))];
    else line = [h('span', {class: 'chip ok'}, 'reset first'), ' ≈ ', h('b', {}, num(f.atReset) + '%'), ' at the reset'];
    return h('a', {class: ['now-card', level], href: '#/quota', title: `Data as of ${c.dateTime(q.ts)} (${ago(q.ts)})`},
      h('div', {class: 'now-label'}, quotaName(q.minutes), f && f.rate >= .05 ? info(`${why} Current pace: +${num(f.rate, 1)}%/h.`) : null, q.limit_id !== 'codex' ? h('span', {class: 'pill'}, q.limit_id) : null, q.plan ? h('span', {class: 'pill'}, q.plan) : null),
      h('div', {class: 'now-value'}, h('b', {}, num(used)), h('span', {class: 'unit'}, '%'), h('span', {class: 'now-aside'}, expired ? 'window ended' : `resets in ${duration(q.reset - now)}`)),
      h('div', {class: ['meter', level]},
        h('div', {class: 'meter-fill', style: {width: Math.min(100, used) + '%'}}),
        f && f.atReset > used + .5 ? h('div', {class: 'meter-proj', style: {left: Math.min(100, used) + '%', width: (f.atReset - Math.min(100, used)) + '%'}}) : null),
      h('div', {class: 'now-line'}, line),
      h('div', {class: 'now-foot'}, f?.budgetPerDay != null && used < 100 ? `≤ ${num(f.budgetPerDay, 1)}% per day lasts to the reset` : left != null ? `≈ ${compact(left)} tokens left at typical usage` : `as of ${ago(q.ts)}`));
  });
}

// Today and this week, independent of the selected period (model/project filters still apply).
function todayCard() {
  const D = ctx.D, c = ctx.clock, mi = D.mi[state.metric], now = Date.now() / 1000, today = c.today();
  const events = eventsBetween(c.dayStart(today), now), total = sum(events, mi);
  const daily = new Map();
  for (const e of eventsBetween(c.dayStart(today - 28), c.dayStart(today))) { const d = c.day(e[0]); daily.set(d, (daily.get(d) || 0) + (e[5][mi] || 0)); }
  const typical = median([...daily.values()].filter(Boolean));
  const hours = Array(24).fill(0);
  for (const e of events) hours[c.hour(e[0])] += e[5][mi] || 0;
  const sessions = new Set(events.filter(e => sessionKind(D.sessions[e[3]]) === 'main').map(e => e[3])).size;
  const last = events[events.length - 1]?.[0];
  return h('div', {class: 'now-card'},
    h('div', {class: 'now-label'}, 'Today', h('span', {class: 'pill'}, c.date(now))),
    h('div', {class: 'now-value'}, splitValue(fmtMetric(total)), h('span', {class: 'now-aside'}, typical ? `${num(100 * total / typical)}% of a typical day` : '')),
    chartBox(el => miniColumns(el, {values: hours, labels: hours.map((_, i) => i % 6 ? '' : String(i).padStart(2, '0')), titles: hours.map((_, i) => `${String(i).padStart(2, '0')}:00`), fmt: fmtMetric, unit: metricUnit(state.metric), hot: c.hour(now), height: 34})),
    h('div', {class: 'now-foot'}, `${num(sessions)} ${plural(sessions, 'session', 'sessions')}`, last ? ` · last response ${ago(last)}` : ' · no activity yet', typical ? ` · typical ${fmtMetric(typical)}` : ''));
}

function weekCard() {
  const D = ctx.D, c = ctx.clock, mi = D.mi[state.metric], now = Date.now() / 1000;
  const wk = period('week', periodStart('week', c.today())), prev = period('week', wk.startDay - 7);
  const total = sum(eventsBetween(wk.a, now), mi), before = sum(eventsBetween(prev.a, prev.a + (now - wk.a)), mi), lastWeek = sum(eventsBetween(prev.a, prev.b), mi);
  const days = Array.from({length: 7}, (_, i) => wk.startDay + i <= c.today() ? sum(eventsBetween(c.dayStart(wk.startDay + i), c.dayStart(wk.startDay + i + 1)), mi) : 0);
  const five = D.quotaKeys.find(k => k === 'codex|300') || D.quotaKeys.find(k => k.endsWith('|300'));
  const burn = five ? quotaBurn(five, wk.a, now) : null;
  const ch = before ? total / before - 1 : NaN;
  return h('a', {class: 'now-card', href: '#/review', title: 'Compared with last week at the same point in time'},
    h('div', {class: 'now-label'}, 'This week', h('span', {class: 'pill'}, `${c.date(wk.a)} – ${c.date(wk.b - 1)}`)),
    h('div', {class: 'now-value'}, splitValue(fmtMetric(total)), h('span', {class: ['now-aside', Number.isFinite(ch) && (ch > 0 ? 'up' : 'down')]},
      Number.isFinite(ch) ? `${ch > 0 ? '+' : '−'}${num(Math.abs(ch * 100))}% vs last week` : 'no data last week')),
    chartBox(el => miniColumns(el, {values: days, labels: WEEKDAYS.map(d => d.slice(0, 2)), titles: days.map((_, i) => c.weekdayDate(c.dayStart(wk.startDay + i))), fmt: fmtMetric, unit: metricUnit(state.metric), hot: c.today() - wk.startDay, height: 34})),
    h('div', {class: 'now-foot'}, `last week ${fmtMetric(lastWeek)}`, burn?.burn ? ` · ${num(burn.burn)}% of five-hour quota (${num(burn.started)} ${plural(burn.started, 'window', 'windows')})` : ''));
}

function splitValue(text) {
  const m = /^([−+\-\d.,\s  ]+?)\s?(K|M|B|T)$/.exec(text);
  return m ? [h('b', {}, m[1]), h('span', {class: 'unit'}, m[2])] : h('b', {}, text);
}

// ---------- overview ----------
// Two layers: what is happening right now (live quotas, today, this week), then the selected period
// as a KPI strip, one chart, and a grid of same-size summary cards.
export function overview() {
  const D = ctx.D, v = view(), mi = D.mi[state.metric], c = ctx.clock;
  const total = sum(v.events, mi), prev = sum(v.previous, mi);
  const inp = sum(v.events, D.mi.input_tokens), cached = sum(v.events, D.mi.cached_input_tokens);
  const out = sum(v.events, D.mi.output_tokens), reasoning = D.mi.reasoning_output_tokens != null ? sum(v.events, D.mi.reasoning_output_tokens) : 0;
  const allTokens = sum(v.events, D.mi.total_tokens);
  const vsNote = `vs previous ${v.days} ${plural(v.days, 'day', 'days')}`;

  // Daily series for the KPI sparklines.
  const n = v.toDay - v.fromDay + 1, dayTotal = Array(n).fill(0), dayResp = Array(n).fill(0), dayIn = Array(n).fill(0), dayCached = Array(n).fill(0);
  const daySessions = Array.from({length: n}, () => new Set());
  for (const e of v.events) {
    const i = c.day(e[0]) - v.fromDay; if (i < 0 || i >= n) continue;
    dayTotal[i] += e[5][mi] || 0; dayResp[i]++; dayIn[i] += e[5][D.mi.input_tokens] || 0; dayCached[i] += e[5][D.mi.cached_input_tokens] || 0;
    if (sessionKind(D.sessions[e[3]]) === 'main') daySessions[i].add(e[3]);
  }
  const activeDays = dayTotal.filter(Boolean).length;
  const stats = sessionStats(v.events, mi);
  let mainSessions = 0;
  for (const st of stats.values()) if (sessionKind(st.session) === 'main') mainSessions++;
  const spark = (values, opts = {}) => {
    if (n < 2) return null;
    const svg = sparkline(values, {width: 150, height: 28, color: 'var(--ink-2)', focus: -1, ...opts});
    svg.setAttribute('preserveAspectRatio', 'none'); // stretch to the tile; the stroke keeps its width
    return svg;
  };
  const tiles = h('div', {class: 'tiles'},
    tile(metricLabel(state.metric), fmtMetric(total), null, {delta: prev ? total / prev - 1 : NaN, deltaNote: vsNote, class: 'hero', spark: spark(dayTotal, {color: 'var(--accent)'})}),
    tile('Per active day', fmtMetric(activeDays ? total / activeDays : 0), `${activeDays} of ${v.days} days active`, {spark: spark(dayTotal.map(x => x || null))}),
    tile('Sessions', num(mainSessions), `+ ${num(stats.size - mainSessions)} subagents and reviews`, {spark: spark(daySessions.map(x => x.size))}),
    tile('Responses', num(v.events.length), `≈ ${compact(v.events.length ? allTokens / v.events.length : 0)} tokens each`, {spark: spark(dayResp)}),
    tile('Input from cache', share(cached, inp, 0), `${compact(cached)} of ${compact(inp)}`, {spark: spark(dayIn.map((x, i) => x ? dayCached[i] / x : null))}));

  // ---------- main chart ----------
  const gran = granularity(v), key = bucketer(gran), bs = buckets(v, gran);
  const values = new Map(), present = new Set();
  for (const e of v.events) {
    const k = key(e[0]); let row = values.get(k);
    if (!row) values.set(k, row = {});
    const m = D.models[e[1]]; row[m] = (row[m] || 0) + (e[5][mi] || 0); present.add(m);
  }
  const series = D.models.filter(m => present.has(m)).map(m => ({key: m, label: m, color: color(m)}));
  let ghost = null;
  if (state.compare) {
    ghost = new Map();
    const span = v.b - v.a, keys = new Set(bs.map(b => b.key));
    for (const e of v.previous) { const k = key(e[0] + span); if (keys.has(k)) ghost.set(k, (ghost.get(k) || 0) + (e[5][mi] || 0)); }
  }
  const drill = gran === 'hour' ? null : b => {
    const from = c.day(b.start), to = c.day(b.end - 1);
    Object.assign(state.range, {preset: 'custom', from: c.iso(from), to: c.iso(to)});
    if (gran === 'day') state.gran = 'hour';
    saveState(); ctx.render();
  };
  ctx.bar = granBar();
  const usageCard = card(`${metricLabel(state.metric)} ${granLabels[gran].toLowerCase()}`, {
    sub: `Colored by model.${ghost ? ' Dashed markers: the previous period on the same buckets.' : ''} Click a bar to zoom in.`, actions: compareToggle()},
  chartBox(el => columns(el, {buckets: bs, series, values, fmt: fmtMetric, onClick: drill, ghost, ghostLabel: `Previous ${v.days} ${plural(v.days, 'day', 'days')}`, height: 240})),
  legend([...series, ...(ghost ? [{label: 'previous period', color: 'var(--ink-2)', line: true}] : [])]));

  // ---------- summary cards ----------
  const mini = (title, link, body, sub) => card(title, {class: 'mini', sub, actions: link ? h('a', {href: link[0], class: 'link'}, link[1]) : null}, body);
  const models = byModel(v.events, mi);
  const modelCard = mini('Models', ['#/models', 'Compare →'],
    chartBox(el => rankList(el, models.map(m => ({label: m.model, value: m.value, color: color(m.model), model: m.model})), {fmt: fmtMetric, onClick: it => toggleModel(it.model)})));
  const projects = projectStats(stats);
  const projCard = mini('Projects', ['#/projects', 'All →'],
    chartBox(el => rankList(el, projects.map(p => ({label: p.name, value: p.value, key: p.key, title: [...p.paths].join('\n')})), {fmt: fmtMetric, onClick: it => toggleProject(it.key)})));
  const topSessions = [...stats.values()].sort((p, q) => q.value - p.value);
  const sessCard = mini('Top sessions', ['#/sessions', 'All →'],
    chartBox(el => rankList(el, topSessions.map(st => ({label: sessionTitle(st.session), sub: projectName(st.session.cwd), value: st.value, color: color(D.models[st.mainModel]), id: st.session.id})),
      {fmt: fmtMetric, total: total, onClick: it => sessionDetail(it.id)})));
  const mixCard = mini('Token mix', null, chartBox(el => composition(el, [
    {label: 'New input', value: inp - cached, color: 'var(--c1)'}, {label: 'Cached input', value: cached, color: 'var(--c2)'},
    {label: 'Response', value: out - reasoning, color: 'var(--c3)'}, {label: 'Reasoning', value: reasoning, color: 'var(--c4)'}])),
  'Cached input is context read again; reasoning is part of output');
  const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
  for (const e of v.events) { hours[c.hour(e[0])] += e[5][mi] || 0; weekdays[c.weekday(e[0])] += e[5][mi] || 0; }
  const peakHour = hours.indexOf(Math.max(...hours)), peakDay = weekdays.indexOf(Math.max(...weekdays));
  const whenCard = mini('When you work', null, [
    chartBox(el => miniColumns(el, {values: hours, labels: hours.map((_, i) => i % 6 ? '' : String(i).padStart(2, '0')), titles: hours.map((_, i) => `${String(i).padStart(2, '0')}:00–${String(i + 1).padStart(2, '0')}:00`), fmt: fmtMetric, unit: metricUnit(state.metric), hot: peakHour, height: 56})),
    chartBox(el => miniColumns(el, {values: weekdays, labels: WEEKDAYS, fmt: fmtMetric, unit: metricUnit(state.metric), hot: peakDay, height: 36}))],
  total ? `Busiest: ${WEEKDAYS[peakDay]} and ${String(peakHour).padStart(2, '0')}:00–${String(peakHour + 1).padStart(2, '0')}:00 (${state.tz})` : null);
  const signalCard = mini('Signals', null, signals(), 'One line from each focus page');

  return [
    h('h3', {class: 'section-title'}, 'Right now'),
    h('div', {class: 'now'}, quotaCards(), todayCard(), weekCard()),
    h('h3', {class: 'section-title'}, `Selected period · ${v.days === 1 ? c.dateY(v.a) : `${c.date(v.a)} – ${c.dateY(v.b - 1)}`}`),
    tiles, usageCard,
    h('div', {class: 'grid three minis'}, modelCard, projCard, sessCard, mixCard, whenCard, signalCard)];
}

// ---------- quota ----------
export function quota() {
  const D = ctx.D, v = view(), c = ctx.clock;
  if (!D.quotaKeys.length) return [card('Quotas', {}, h('div', {class: 'empty'}, 'No quota snapshots in the history of this profile.'))];
  let qkey = state.quota.key;
  if (!D.quotaKeys.includes(qkey)) qkey = D.quotaKeys.find(k => k.endsWith('|300')) || D.quotaKeys[0];
  const [limitId, minutesText] = qkey.split('|'), minutes = Number(minutesText);
  const threshold = state.quota.threshold, models = state.models;
  const inRange = D.windows.filter(w => w.minutes === minutes && w.limit_id === limitId && w.start >= v.a && w.start < v.b);
  const shown = models.length ? inRange.filter(w => models.includes(w.classification) || models.some(m => w.models[m])) : inRange;
  const eligible = shown.filter(w => !w.exclusion && w.max_used >= threshold && (!models.length || models.includes(w.classification)));
  const values = eligible.map(w => windowValue(w));
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const per = shown.map(perPercent).filter(x => x != null);
  const now = D.quota_now.find(q => q.minutes === minutes && q.limit_id === limitId);

  const set = patch => { Object.assign(state.quota, patch); saveState(); ctx.render(); };
  ctx.bar = h('div', {class: 'bar-group'},
    segmented(D.quotaKeys.map(k => [k, quotaName(Number(k.split('|')[1])) + (k.split('|')[0] !== 'codex' ? ` · ${k.split('|')[0]}` : '')]), qkey, k => set({key: k}), {class: 'small', label: 'Counter'}),
    h('span', {class: 'bar-label'}, 'Exhausted at'), segmented([[100, '100%'], [98, '≥ 98%'], [95, '≥ 95%'], [90, '≥ 90%']], threshold, t => set({threshold: t}), {class: 'small', label: 'Exhaustion threshold'}),
    h('span', {class: 'bar-label'}, 'Trend by'), segmented([[1, '1 d'], [2, '2 d'], [3, '3 d'], [7, '7 d']], state.quota.period, p => set({period: p}), {class: 'small', label: 'Group trend by'}));

  const full = eligible.filter(w => w.full).length;
  const tiles = h('div', {class: 'tiles'},
    tile('Average per exhausted window', values.length ? fmtMetric(avg) : '—', `${metricLabel(state.metric)} · ${values.length} ${plural(values.length, 'window', 'windows')} (100%: ${full})`, {class: 'hero'}),
    tile('Median', values.length ? fmtMetric(median(values)) : '—', values.length ? `from ${fmtMetric(Math.min(...values))} to ${fmtMetric(Math.max(...values))}` : 'no exhausted windows'),
    tile('≈ tokens per 1% of quota', per.length ? compact(median(per)) : '—', per.length ? `median across ${per.length} ${plural(per.length, 'window', 'windows')}, including incomplete windows` : 'insufficient data',
      {title: 'Total window tokens ÷ usage percentage increase. Includes windows with an increase of at least 10 percentage points.'}),
    tile('Now', now ? (now.reset <= Date.now() / 1000 ? '0%' : num(now.used) + '%') : '—', now ? (now.reset <= Date.now() / 1000 ? 'window ended' : `resets in ${duration(now.reset - Date.now() / 1000)}`) : ''),
    tile('Windows in range', num(shown.length), `incomplete: ${shown.filter(w => !w.exclusion && w.max_used < threshold).length}, excluded: ${shown.filter(w => w.exclusion).length}`));

  const series = D.quota_series[qkey] || [];
  const fillCard = card(`Usage: ${quotaName(minutes).toLowerCase()}`, {
    sub: 'Usage percentage from recorded server responses. The line returns to zero at the reset deadline. Vertical markers show early resets.'},
  chartBox(el => quotaChart(el, {points: series, a: v.a, b: v.b, clock: c, resets: D.resets.filter(r => r.minutes === minutes && r.limit_id === limitId)})));

  const items = shown.map(w => {
    const ok = eligible.includes(w), p = perPercent(w);
    const breakdown = Object.entries(w.models).sort((x, y) => (y[1].total_tokens || 0) - (x[1].total_tokens || 0)).slice(0, 4);
    return {start: w.start, end: Math.max(w.end, w.start + 60), value: windowValue(w), color: color(w.classification), faded: !ok, w,
      title: `${c.dateTime(w.start)} → ${c.time(w.end)}`,
      rows: [{label: metricLabel(state.metric), value: fmtMetric(windowValue(w))},
        {label: 'usage', value: `${num(w.first_used)}% → ${num(w.max_used)}%`},
        p ? {label: 'tokens per 1%', value: compact(p)} : null,
        ...breakdown.map(([m, x]) => ({color: color(m), label: m, value: compact(x.total_tokens || 0), muted: true}))].filter(Boolean),
      note: ok ? (w.full ? 'Exhausted (100%); included in average' : `Nearly exhausted (${num(w.max_used)}%); included in average`) : (w.exclusion || `Below threshold ${threshold}%; excluded from average`)};
  });
  const present = [...new Set(shown.map(w => w.classification))].sort((x, y) => D.models.indexOf(x) - D.models.indexOf(y));
  const windowsCard = card('Tokens consumed in each window', {
    sub: `Each bar is one quota window (${minutesLabel(minutes)}). Bright bars are exhausted windows included in the average; pale bars are incomplete or excluded. Usage after the first 100% snapshot is excluded.`},
  chartBox(el => timeColumns(el, {items, a: v.a, b: v.b, clock: c, fmt: fmtMetric, ref: avg ? {value: avg, label: `average ${fmtMetric(avg)}`} : null, onClick: it => windowDetail(it.w)})),
  present.length ? legend(present.map(m => ({label: modelName(m), color: color(m)}))) : null);

  // capacity trend per period × model
  const period = state.quota.period, startDay = v.fromDay;
  const groups = new Map();
  for (const w of eligible) {
    const idx = Math.floor((c.day(w.start) - startDay) / period);
    const k = w.classification; let g = groups.get(k);
    if (!g) groups.set(k, g = new Map());
    const cell = g.get(idx) || {sum: 0, n: 0}; cell.sum += windowValue(w); cell.n++; g.set(idx, cell);
  }
  const nPeriods = Math.ceil(v.days / period);
  const labels = Array.from({length: nPeriods}, (_, i) => {
    const a = c.dayStart(startDay + i * period), b = c.dayStart(Math.min(v.toDay + 1, startDay + (i + 1) * period));
    return {label: period === 1 ? c.weekdayDate(a) : `${c.date(a)} – ${c.date(b - 1)}`, short: c.date(a)};
  });
  const trendSeries = [...groups.keys()].sort((x, y) => D.models.indexOf(x) - D.models.indexOf(y)).map(m => ({key: m, label: modelName(m), color: color(m),
    values: labels.map((_, i) => { const cell = groups.get(m).get(i); return cell ? cell.sum / cell.n : null; })}));
  labels.forEach((lb, i) => { const counts = trendSeries.map(sr => groups.get(sr.key).get(i)?.n).filter(Boolean); lb.note = counts.length ? `windows: ${counts.reduce((a, b) => a + b, 0)}` : 'no exhausted windows'; });
  const trendCard = card('Capacity over time', {sub: `Average over exhausted windows for each ${period} ${plural(period, 'day', 'days')}, grouped by dominant model. Gaps indicate no exhausted windows in that period.`},
    chartBox(el => lines(el, {labels, series: trendSeries, fmt: fmtMetric, emptyText: 'No exhausted windows. Try a threshold of ≥ 90% or another date range.'})),
    trendSeries.length > 1 ? legend(trendSeries.map(sr => ({...sr, line: true}))) : null);

  // per-model summary
  const byClass = new Map();
  for (const w of shown) {
    const k = w.classification; let r = byClass.get(k);
    if (!r) byClass.set(k, r = {model: k, all: 0, eligible: [], full: 0, per: []});
    r.all++;
    if (eligible.includes(w)) { r.eligible.push(windowValue(w)); r.full += w.full ? 1 : 0; }
    const p = perPercent(w); if (p) r.per.push(p);
  }
  const modelRows = [...byClass.values()];
  const modelTable = card('By dominant model', {sub: 'A window is assigned to a model if it accounts for ≥ ' + num(D.options.dominance * 100) + '% of tokens; otherwise it is classified as Mixed models.'},
    table({rows: modelRows, sortKey: 'n', csvName: 'quota-by-model', columns: [
      {key: 'model', label: 'Model', value: r => modelName(r.model), render: r => modelDot(r.model)},
      {key: 'n', label: 'Exhausted windows', num: true, value: r => r.eligible.length, render: r => `${r.eligible.length} of ${r.all}`},
      {key: 'full', label: 'At 100%', num: true, value: r => r.full},
      {key: 'avg', label: 'Average', num: true, value: r => r.eligible.length ? r.eligible.reduce((a, b) => a + b, 0) / r.eligible.length : null, fmt: fmtMetric},
      {key: 'med', label: 'Median', num: true, value: r => r.eligible.length ? median(r.eligible) : null, fmt: fmtMetric},
      {key: 'min', label: 'Min.', num: true, value: r => r.eligible.length ? Math.min(...r.eligible) : null, fmt: fmtMetric},
      {key: 'max', label: 'Max.', num: true, value: r => r.eligible.length ? Math.max(...r.eligible) : null, fmt: fmtMetric},
      {key: 'per', label: 'Tokens per 1%', num: true, value: r => r.per.length ? median(r.per) : null, fmt: compact, title: 'Median across windows with an increase of at least 10 percentage points'},
    ]}));

  const windowRows = [...shown].reverse();
  const windowsTable = card('All windows', {sub: 'Click a row to see the model breakdown'},
    table({rows: windowRows, pageSize: 25, csvName: `windows-${minutes}m`, onRow: windowDetail, columns: [
      {key: 'start', label: 'Start', value: w => w.start, render: w => c.dateTime(w.start), csv: w => new Date(w.start * 1000).toISOString()},
      {key: 'dur', label: 'Time to 100% / end', num: true, value: w => w.end - w.start, render: w => duration(w.end - w.start)},
      {key: 'fill', label: 'Usage', num: true, value: w => w.max_used, render: w => `${num(w.first_used)} → ${num(w.max_used)}%`},
      {key: 'model', label: 'Model', value: w => modelName(w.classification), render: w => modelDot(w.classification)},
      {key: 'value', label: metricLabel(state.metric), num: true, value: w => windowValue(w), fmt: fmtMetric},
      {key: 'per', label: 'Per 1%', num: true, value: w => perPercent(w), fmt: compact},
      {key: 'voice', label: 'Voice, min', num: true, value: w => w.voice_minutes || null, fmt: x => num(x, 1)},
      {key: 'status', label: 'Status', value: w => statusText(w, threshold), render: w => statusChip(w, threshold)},
    ]}));

  const resets = D.resets.filter(r => r.limit_id === limitId && r.minutes === minutes && r.ts >= v.a && r.ts < v.b).reverse();
  const resetNames = {deadline_changed: 'New reset deadline', counter_drop_confirmed: 'Counter reset', app_record_and_counter_drop: 'Reset + application record'};
  const resetCard = card('Quota resets', {sub: `Early resets: ${resets.filter(r => r.early).length} of ${resets.length}. An early reset starts a new window before the previous deadline.`},
    table({rows: resets, pageSize: 15, csvName: 'resets', columns: [
      {key: 'ts', label: 'When', value: r => r.ts, render: r => c.dateTime(r.ts)},
      {key: 'before', label: 'Before', num: true, value: r => r.used_before, fmt: x => num(x) + '%'},
      {key: 'after', label: 'After', num: true, value: r => r.used_after, fmt: x => num(x) + '%'},
      {key: 'kind', label: 'Type', value: r => r.early ? 'Early' : 'Scheduled', render: r => h('span', {class: ['chip', r.early ? 'warn' : 'neutral']}, r.early ? 'Early' : 'Scheduled')},
      {key: 'reason', label: 'Evidence', value: r => resetNames[r.reason] || r.reason, render: r => [resetNames[r.reason] || r.reason, r.app_record ? h('span', {class: 'pill'}, 'application record present') : null]},
      {key: 'prev', label: 'Previous deadline', value: r => r.previous_deadline, render: r => c.dateTime(r.previous_deadline)},
    ]}));

  const explain = card(null, {}, h('details', {class: 'explain'}, h('summary', {}, 'How this is calculated'),
    h('p', {}, 'Recorded server responses contain usage percentages and reset deadlines. These deadlines divide history into actual windows. For a window observed near zero, tokens are summed up to the first 100% snapshot, or the last snapshot for a nearly exhausted window.'),
    h('p', {}, 'The average is an arithmetic mean with equal weight for each window. Values are never extrapolated to 100%. Snapshots at 95–99% do not prove exhaustion; choose 100% for a strict sample.'),
    h('p', {}, 'Tokens per 1% is a rough estimate: total window tokens divided by the percentage increase. Voice, images and activity on other devices may share the budget without appearing in this profile token counts. The estimate can understate token capacity.'),
    h('p', {}, 'Internal auto-review usage is excluded by default because its quota impact cannot be established from the logs. Enable Internal in the filters to include it.')));

  return [tiles, fillCard, windowsCard, grow(trendCard, modelTable), windowsTable, resetCard, explain];
}

function statusText(w, threshold) {
  if (w.exclusion) return 'Excluded';
  if (w.full) return 'Exhausted';
  return w.max_used >= threshold ? 'Nearly exhausted' : 'Incomplete';
}
function statusChip(w, threshold) {
  const t = statusText(w, threshold);
  const kind = {Excluded: 'neutral', Exhausted: 'bad', 'Nearly exhausted': 'warn', 'Incomplete': 'ok'}[t];
  return h('span', {class: ['chip', kind], title: w.exclusion || ''}, t);
}

export function windowDetail(w) {
  const c = ctx.clock, models = Object.entries(w.models).sort((a, b) => (b[1].total_tokens || 0) - (a[1].total_tokens || 0));
  const internal = Object.entries(w.internal_models);
  drawer(`Window ${c.dateTime(w.start)}`, [
    h('div', {class: 'tiles small'},
      tile('Usage', `${num(w.first_used)} → ${num(w.max_used)}%`, w.full ? 'reached 100%' : 'no 100% snapshot'),
      tile(metricLabel(state.metric), fmtMetric(windowValue(w)), `over ${duration(w.end - w.start)}`),
      tile('Per 1%', perPercent(w) ? compact(perPercent(w)) : '—', 'total tokens ÷ percentage increase')),
    h('dl', {class: 'meta'},
      h('dt', {}, 'Reset deadline'), h('dd', {}, c.dateTime(w.deadline)),
      h('dt', {}, 'Dominant model'), h('dd', {}, `${modelName(w.classification)} (${num(w.dominant_share * 100)}%)`),
      w.voice_minutes ? [h('dt', {}, 'Voice'), h('dd', {}, num(w.voice_minutes, 1) + ' min')] : null,
      w.exclusion ? [h('dt', {}, 'Excluded from average'), h('dd', {}, w.exclusion)] : null),
    h('h3', {}, 'Model breakdown'),
    table({rows: [...models.map(([m, x]) => ({m, x, internal: false})), ...internal.map(([m, x]) => ({m, x, internal: true}))], pageSize: 20, columns: [
      {key: 'm', label: 'Model', value: r => r.m, render: r => [modelDot(r.m), r.internal ? h('span', {class: 'pill'}, 'internal') : null]},
      {key: 't', label: 'Total tokens', num: true, value: r => r.x.total_tokens || 0, compact: true},
      {key: 'u', label: 'Uncached', num: true, value: r => r.x.uncached_input_tokens || 0, compact: true},
      {key: 'o', label: 'Output', num: true, value: r => r.x.output_tokens || 0, compact: true},
      {key: 'r', label: 'Responses', num: true, value: r => r.x.responses || 0},
    ]})]);
}

// ---------- models ----------
export function modelsPage() {
  const D = ctx.D, v = view(), c = ctx.clock, mi = D.mi;
  const rows = new Map();
  for (const e of v.events) {
    let r = rows.get(e[1]);
    if (!r) rows.set(e[1], r = {model: D.models[e[1]], value: 0, total: 0, input: 0, cached: 0, output: 0, reasoning: 0, responses: 0, sessions: new Set(), first: e[0], last: e[0], efforts: new Map(), ctx: 0});
    const x = e[5];
    r.value += x[mi[state.metric]] || 0; r.total += x[mi.total_tokens] || 0; r.input += x[mi.input_tokens] || 0; r.cached += x[mi.cached_input_tokens] || 0;
    r.output += x[mi.output_tokens] || 0; r.reasoning += mi.reasoning_output_tokens != null ? x[mi.reasoning_output_tokens] || 0 : 0; r.responses++;
    r.sessions.add(e[3]); r.last = e[0]; r.ctx = Math.max(r.ctx, e[6]);
    r.efforts.set(e[4], (r.efforts.get(e[4]) || 0) + (x[mi[state.metric]] || 0));
  }
  const list = [...rows.values()].sort((a, b) => b.value - a.value);
  const grand = list.reduce((n, r) => n + r.value, 0);
  const tbl = card('Model comparison', {sub: 'Click a row to filter the dashboard by model'}, table({rows: list, sortKey: 'value', csvName: 'models',
    onRow: r => { state.models = [r.model]; saveState(); ctx.go('overview'); }, columns: [
      {key: 'model', label: 'Model', value: r => r.model, render: r => modelDot(r.model)},
      {key: 'value', label: metricLabel(state.metric), num: true, value: r => r.value, fmt: fmtMetric},
      {key: 'share', label: 'Share', num: true, value: r => grand ? r.value / grand : 0, fmt: x => pct(x * 100, 1)},
      {key: 'cache', label: 'Input cache share', num: true, value: r => r.input ? r.cached / r.input : null, fmt: x => pct(x * 100)},
      {key: 'perresp', label: 'Input per response', num: true, value: r => r.responses ? r.input / r.responses : 0, compact: true, title: 'Average context size read by the model at each step'},
      {key: 'out', label: 'Output per response', num: true, value: r => r.responses ? r.output / r.responses : 0, compact: true},
      {key: 'reason', label: 'Reasoning', num: true, value: r => r.output ? r.reasoning / r.output : null, fmt: x => pct(x * 100), title: 'Reasoning share of output tokens'},
      {key: 'resp', label: 'Responses', num: true, value: r => r.responses},
      {key: 'sess', label: 'Sessions', num: true, value: r => r.sessions.size},
      {key: 'last', label: 'Last used', value: r => r.last, render: r => c.dateTime(r.last)},
    ]}));

  ctx.bar = granBar();
  const gran = granularity(v), key = bucketer(gran), bs = buckets(v, gran);
  const totals = new Map(), values = new Map();
  for (const e of v.events) {
    const k = key(e[0]), m = D.models[e[1]], x = e[5][mi[state.metric]] || 0;
    totals.set(k, (totals.get(k) || 0) + x);
    let row = values.get(k); if (!row) values.set(k, row = {});
    row[m] = (row[m] || 0) + x;
  }
  for (const [k, row] of values) for (const m in row) row[m] = 100 * row[m] / totals.get(k);
  const series = list.map(r => ({key: r.model, label: r.model, color: color(r.model)}));
  const shareCard = card('Model share over time', {sub: `Percentage of ${metricLabel(state.metric).toLowerCase()} in each period`},
    chartBox(el => columns(el, {buckets: bs, series, values, fmt: x => num(x) + '%'})), series.length > 1 ? legend(series) : null);

  const efforts = D.efforts;
  const effortRows = list.map(r => ({model: r.model, total: r.value, ...Object.fromEntries(efforts.map((name, i) => [name, r.efforts.get(i) || 0]))}));
  const used = efforts.filter(name => effortRows.some(r => r[name]));
  const effortCard = card('Reasoning effort', {sub: 'Usage at each reasoning effort level'},
    table({rows: effortRows, sortKey: 'total', csvName: 'effort', columns: [
      {key: 'model', label: 'Model', value: r => r.model, render: r => modelDot(r.model)},
      ...used.map(name => ({key: name, label: name === '—' ? 'unspecified' : name, num: true, value: r => r[name],
        render: r => r[name] ? h('span', {}, fmtMetric(r[name]), h('span', {class: 'muted small'}, ' ' + share(r[name], r.total, 0))) : '—'})),
    ]}));
  return [tbl, shareCard, effortCard];
}

// ---------- sessions ----------
export function sessionTitle(sess) {
  return sess?.title || (sess?.source === 'review' ? 'Auto-review' : sess?.source === 'subagent' ? 'Subagent' : 'Untitled');
}

function sessionTable(list, {pageSize = 50, compactView = false} = {}) {
  const c = ctx.clock;
  return table({rows: list, sortKey: compactView ? null : 'last', pageSize, csvName: compactView ? null : 'sessions', onRow: st => sessionDetail(st.session.id), columns: [
    {key: 'title', label: 'Session', value: st => sessionTitle(st.session), render: st => h('div', {class: 'cell-main'},
      h('div', {class: 'ellipsis', title: sessionTitle(st.session)}, sessionTitle(st.session)),
      h('div', {class: 'muted small ellipsis'}, projectName(st.session.cwd), st.session.branch ? ` · ${st.session.branch}` : ''))},
    {key: 'last', label: 'Last activity', value: st => st.last, render: st => c.dateTime(st.last), csv: st => new Date(st.last * 1000).toISOString()},
    !compactView ? {key: 'dur', label: 'Duration', num: true, value: st => st.last - st.first, render: st => duration(st.last - st.first)} : null,
    {key: 'model', label: 'Model', value: st => ctx.D.models[st.mainModel], render: st => modelDot(ctx.D.models[st.mainModel])},
    !compactView ? {key: 'effort', label: 'Effort', value: st => ctx.D.efforts[st.mainEffort]} : null,
    {key: 'value', label: metricLabel(state.metric), num: true, value: st => st.value, fmt: fmtMetric},
    {key: 'resp', label: 'Responses', num: true, value: st => st.responses},
    !compactView ? {key: 'ctx', label: 'Peak context', num: true, value: st => st.window ? st.peakContext / st.window : null, fmt: x => pct(x * 100),
      title: 'Largest input context per response as a share of the model context window'} : null,
    !compactView ? {key: 'kind', label: 'Type', value: st => sourceNames[st.session.source] || st.session.source} : null,
  ].filter(Boolean)});
}

export function sessions() {
  const D = ctx.D, v = view(), mi = D.mi[state.metric];
  const stats = sessionStats(v.events, mi), f = state.sessions;
  const q = f.q.trim().toLowerCase();
  const all = [...stats.values()];
  const list = all.filter(st => {
    const sess = st.session;
    if (f.kind !== 'all' && sessionKind(sess) !== f.kind) return false;
    if (q && ![sess.title, sess.cwd, sess.id, sess.branch].some(x => x && x.toLowerCase().includes(q))) return false;
    return true;
  });
  const set = patch => { Object.assign(state.sessions, patch); saveState(); ctx.render(); };
  const counts = {main: 0, subagent: 0, review: 0};
  for (const st of all) counts[sessionKind(st.session)]++;
  const search = h('input', {type: 'search', placeholder: 'Title, directory, branch or ID', value: f.q, 'aria-label': 'Search sessions'});
  search.addEventListener('input', debounceInput(() => { state.sessions.q = search.value; saveState(); ctx.render({keepFocus: 'session-search'}); }));
  search.id = 'session-search';
  search.classList.add('bar-search');
  ctx.bar = h('div', {class: 'bar-group'}, search,
    segmented([['main', `Main · ${counts.main}`], ['subagent', `Subagents · ${counts.subagent}`], ['review', `Reviews · ${counts.review}`], ['all', 'All']], f.kind, k => set({kind: k}), {class: 'small', label: 'Session type'}));
  const total = list.reduce((n, st) => n + st.value, 0);
  return [
    h('div', {class: 'tiles'},
      tile('Sessions', num(list.length), f.kind === 'main' ? 'main conversations' : ''),
      tile(metricLabel(state.metric), fmtMetric(total), `${share(total, sum(v.events, mi))} of total in range`),
      tile('Median per session', fmtMetric(median(list.map(st => st.value))), 'half of sessions use less'),
      tile('Model responses', num(list.reduce((n, st) => n + st.responses, 0)))),
    card('Sessions', {sub: 'Click a session to open its details'}, sessionTable(list))];
}

function debounceInput(fn) { let t; return () => { clearTimeout(t); t = setTimeout(fn, 250); }; }

export function sessionDetail(id) {
  const D = ctx.D, c = ctx.clock, index = D.sessionIndex.get(id);
  if (index == null) return;
  const sess = D.sessions[index], mi = D.mi[state.metric];
  const events = D.events.filter(e => e[3] === index && (state.internal || !e[2]));
  const children = D.sessions.map((x, i) => [x, i]).filter(([x]) => x.parent === id);
  const total = sum(events, mi);
  const first = events[0]?.[0], last = events[events.length - 1]?.[0];
  const bs = events.map((e, i) => ({key: i, label: `${c.dateTime(e[0])} · response ${i + 1}`, short: c.time(e[0])}));
  const values = new Map(events.map((e, i) => [i, {[D.models[e[1]]]: e[5][mi] || 0}]));
  const present = [...new Set(events.map(e => D.models[e[1]]))];
  const ctxSeries = [{key: 'ctx', label: 'Context (input per response)', color: 'var(--s1)', values: events.map(e => e[6] || null)}];
  const windowMax = Math.max(0, ...events.map(e => e[7] || 0));
  const childStats = children.map(([x, i]) => ({x, value: sum(D.events.filter(e => e[3] === i), mi)}));
  drawer(sessionTitle(sess), [
    h('div', {class: 'tiles small'},
      tile(metricLabel(state.metric), fmtMetric(total), `${events.length} ${plural(events.length, 'response', 'responses')}`),
      tile('Duration', first ? duration(last - first) : '—', first ? `${c.dateTime(first)} → ${c.time(last)}` : ''),
      tile('Peak context', windowMax ? share(Math.max(...events.map(e => e[6] || 0)), windowMax, 0) : '—', windowMax ? `window ${compact(windowMax)}` : '')),
    h('dl', {class: 'meta'},
      h('dt', {}, 'Directory'), h('dd', {class: 'mono'}, sess.cwd || '—'),
      sess.branch ? [h('dt', {}, 'Branch'), h('dd', {class: 'mono'}, sess.branch)] : null,
      h('dt', {}, 'Type'), h('dd', {}, sourceNames[sess.source] || sess.source || '—'),
      h('dt', {}, 'Client'), h('dd', {}, [sess.originator, sess.cli_version].filter(Boolean).join(' · ') || '—'),
      sess.parent ? [h('dt', {}, 'Parent'), h('dd', {}, h('button', {class: 'link', type: 'button', onclick: () => sessionDetail(sess.parent)}, sessionTitle(D.sessions[D.sessionIndex.get(sess.parent)]) || sess.parent))] : null,
      h('dt', {}, 'ID'), h('dd', {class: 'mono small'}, sess.id),
      h('dt', {}, 'File'), h('dd', {class: 'mono small break'}, shortPath(sess.file, ctx.meta.home))),
    h('h3', {}, 'Usage per response'),
    chartBox(el => columns(el, {buckets: bs, series: present.map(m => ({key: m, label: m, color: color(m)})), values, fmt: fmtMetric, height: 220})),
    present.length > 1 ? legend(present.map(m => ({label: m, color: color(m)}))) : null,
    h('h3', {}, 'Context usage'),
    chartBox(el => lines(el, {labels: bs, series: ctxSeries, fmt: compact, height: 200, yMax: windowMax || undefined, area: true})),
    h('p', {class: 'muted small'}, 'Input tokens per response approximate context size. The scale ends at the model context window. Larger contexts require more tokens per step.'),
    childStats.length ? [h('h3', {}, `Subagents and reviews (${childStats.length})`),
      h('div', {class: 'bars'}, childStats.sort((a, b) => b.value - a.value).map(ch => h('button', {type: 'button', class: 'bar-row clickable', onclick: () => sessionDetail(ch.x.id)},
        h('div', {class: 'bar-label'}, h('span', {class: 'bar-name'}, sessionTitle(ch.x))), h('div'), h('div', {class: 'bar-value'}, h('b', {}, fmtMetric(ch.value))))))] : null,
  ]);
}

// ---------- projects ----------
export function projectsPage() {
  const D = ctx.D, v = view(), c = ctx.clock;
  const stats = sessionStats(v.events, D.mi[state.metric]);
  const projects = projectStats(stats);
  const total = projects.reduce((n, p) => n + p.value, 0);
  const open = p => { state.project = p.key; state.sessions.kind = 'all'; saveState(); ctx.go('sessions'); };
  return [
    card('Usage by project', {sub: 'Projects are session working directories. Subagents and reviews are assigned to their own directories.'},
      chartBox(el => barList(el, projects.map(p => ({label: p.name, sub: projectSub(p), value: p.value, key: p.key, title: [...p.paths].join('\n')})), {fmt: fmtMetric, max: 15, onClick: open}))),
    card('All projects', {}, table({rows: projects, sortKey: 'value', csvName: 'projects', onRow: open, columns: [
      {key: 'name', label: 'Project', value: p => p.name, render: p => h('div', {class: 'cell-main'}, h('div', {}, p.name), h('div', {class: 'muted small mono ellipsis', title: [...p.paths].join('\n')}, projectSub(p)))},
      {key: 'value', label: metricLabel(state.metric), num: true, value: p => p.value, fmt: fmtMetric},
      {key: 'share', label: 'Share', num: true, value: p => total ? p.value / total : 0, fmt: x => pct(x * 100, 1)},
      {key: 'sessions', label: 'Sessions', num: true, value: p => p.sessions},
      {key: 'responses', label: 'Responses', num: true, value: p => p.responses},
      {key: 'models', label: 'Models', value: p => [...p.models.keys()].length, render: p => h('span', {class: 'dots'}, [...p.models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) =>
        h('i', {class: 'swatch', title: D.models[m], style: {background: color(D.models[m])}})))},
      {key: 'last', label: 'Last activity', value: p => p.last, render: p => c.dateTime(p.last)},
    ]}))];
}

function projectSub(p) {
  return p.paths.size > 1 ? `${p.paths.size} ${plural(p.paths.size, 'directory', 'directories')} · ${shortPath(p.cwd, ctx.meta.home)}` : shortPath(p.cwd, ctx.meta.home);
}

// ---------- drawer ----------
export function drawer(title, body) {
  hideTip();
  const root = document.getElementById('drawer');
  const close = () => { root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); };
  fill(root, h('div', {class: 'drawer-backdrop', onclick: close}),
    h('aside', {class: 'drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
      h('header', {class: 'drawer-head'}, h('h2', {}, title), h('button', {type: 'button', class: 'ghost icon', 'aria-label': 'Close', onclick: close}, '✕')),
      h('div', {class: 'drawer-body'}, body)));
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  root.querySelector('.drawer-head button').focus();
  root.onkeydown = e => { if (e.key === 'Escape') close(); };
}
