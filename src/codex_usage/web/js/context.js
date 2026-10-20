// Focus page "Context growth": how context accumulates inside sessions, where compactions cut it back,
// and how much of the spend happened with a long context.
import {h, num, compact, share, plural, median, projectName} from './util.js';
import {columns, trajectories, legend} from './charts.js';
import {ctx, state, saveState, view, sessionContext, card, tile, chartBox, segmented, table, color, modelDot, metricLabel, sessionKind, info} from './core.js';
import {sessionDetail, sessionTitle} from './pages.js';

const KINDS = [['main', 'Main sessions'], ['subagent', 'Subagents'], ['all', 'All']];
const MIN_RESPONSES = 3;
const ratioText = x => Number.isFinite(x) ? '×' + num(x, x < 10 ? 1 : 0) : '—';

function analyse() {
  const D = ctx.D, v = view(), kind = state.context.kind, bySession = new Map();
  for (const e of v.events) {
    if (kind !== 'all' && sessionKind(D.sessions[e[3]]) !== kind) continue;
    let list = bySession.get(e[3]);
    if (!list) bySession.set(e[3], list = []);
    list.push(e);
  }
  const rows = [];
  for (const [index, events] of bySession) {
    if (events.length < MIN_RESPONSES) continue;
    const a = sessionContext(events, D.mi);
    a.index = index; a.session = D.sessions[index]; a.id = a.session.id;
    a.value = events.reduce((n, e) => n + (e[5][D.mi[state.metric]] || 0), 0);
    const models = new Map();
    for (const st of a.steps) models.set(st.model, (models.get(st.model) || 0) + st.total);
    a.model = D.models[[...models.entries()].sort((p, q) => q[1] - p[1])[0][0]];
    rows.push(a);
  }
  return {v, rows: rows.sort((p, q) => q.tokens - p.tokens)};
}

export function contextPage() {
  const {rows} = analyse(), C = state.context;
  ctx.bar = h('div', {class: 'bar-group'},
    segmented(KINDS, C.kind, k => { C.kind = k; C.session = null; saveState(); ctx.render(); }, {class: 'small', label: 'Sessions'}));
  if (!rows.length) return [card('Context growth', {}, h('div', {class: 'empty'}, `No sessions with at least ${MIN_RESPONSES} responses in this range.`))];

  const sel = rows.find(r => r.id === C.session) || rows[0];
  const select = r => { C.session = r.id; saveState(); ctx.render(); requestAnimationFrame(() => document.getElementById('context-session')?.scrollIntoView({behavior: 'smooth', block: 'start'})); };

  // ---------- totals ----------
  let tokens = 0, heavy = 0, steps = 0, heavySteps = 0, input = 0, cached = 0, cuts = 0, avoided = 0, cutShare = [];
  for (const r of rows) {
    tokens += r.tokens; heavy += r.heavy; steps += r.n; heavySteps += r.heavySteps; input += r.input; cached += r.cached;
    cuts += r.compactions.length; avoided += r.avoided;
    for (const cp of r.compactions) cutShare.push(1 - cp.after / cp.before);
  }
  const peaks = rows.map(r => r.peak), growth = median(rows.map(r => r.growth).filter(Boolean));
  const late = median(rows.map(r => r.lateRatio).filter(Number.isFinite));
  const perHeavy = heavySteps ? heavy / heavySteps : 0, perLight = steps - heavySteps ? (tokens - heavy) / (steps - heavySteps) : 0;
  const top = rows[0];

  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'}, h('div', {class: 'headline-text'},
    h('div', {class: 'eyebrow'}, `${num(rows.length)} ${plural(rows.length, 'session', 'sessions')} · ${num(steps)} responses`),
    h('p', {class: 'lede'},
      h('b', {}, share(heavy, tokens, 0)), ' of tokens were spent past half of the context window, in ', h('b', {}, share(heavySteps, steps, 0)), ' of responses. ',
      growth ? ['Context grows by a median ', h('b', {}, compact(growth)), ' tokens per response', cuts ? [', and ', h('b', {}, num(cuts)), ` ${plural(cuts, 'compaction', 'compactions')} brought it back down.`] : '.'] : null),
    h('ul', {class: 'facts'},
      perHeavy && perLight ? h('li', {}, 'A response past half the window costs ', h('b', {}, ratioText(perHeavy / perLight)), ` as much as one below it (${compact(perHeavy)} vs ${compact(perLight)} tokens)`) : null,
      h('li', {}, 'Cached re-reads are ', h('b', {}, share(cached, input, 0)), ' of input — the price of carrying context forward'),
      Number.isFinite(late) ? h('li', {}, 'Late responses cost a median ', h('b', {}, ratioText(late)), ' of early ones within a session') : null,
      cuts ? h('li', {}, 'Compactions cut context by a median ', h('b', {}, share(median(cutShare), 1, 0)), ' and avoided ≈ ', h('b', {}, compact(avoided)), ' re-read tokens') : null,
      h('li', {}, 'Largest: ', h('b', {}, sessionTitle(top.session)), ` — ${compact(top.tokens)} tokens, peak ${compact(top.peak)}`)))));

  const tiles = h('div', {class: 'tiles'},
    tile('Sessions analysed', num(rows.length), `with ≥ ${MIN_RESPONSES} responses in range`, {class: 'hero'}),
    tile('Tokens past half window', share(heavy, tokens, 0), `${compact(heavy)} of ${compact(tokens)}`),
    tile('Median peak context', compact(median(peaks)), `largest ${compact(Math.max(...peaks))}`),
    tile('Growth per response', growth ? compact(growth) : '—', 'median context added per step'),
    tile('Compactions', num(cuts), cuts ? `≈ ${compact(avoided)} re-read tokens avoided` : 'none detected'),
    tile('Late vs early cost', ratioText(late), 'last quarter ÷ first quarter, per response'));

  // ---------- trajectories ----------
  const shown = rows.slice(0, 40);
  if (!shown.includes(sel)) shown.push(sel);
  const half = sel.window ? sel.window / 2 : 128e3;
  const trajCard = card('Context per response, session by session', {
    sub: 'Each line is a session: input context at every response. The highlighted line is the selected session; dots mark compactions. Click a line to select it.',
    actions: info('Context is the input token count of each response, which includes the conversation carried forward. A compaction is a drop of more than 40% from at least 20K tokens.')},
  chartBox(el => trajectories(el, {
    series: shown.map(r => ({key: r.id, label: sessionTitle(r.session), color: color(r.model), values: r.steps.map(st => st.context), marks: r.compactions.map(cp => cp.i),
      rows: i => [{label: 'tokens in response', value: compact(r.steps[i]?.total || 0)}, {label: r.model, value: compact(r.tokens), color: color(r.model)}]})),
    focus: sel.id, refs: [{value: half, label: `half of ${compact(half * 2)} window`}], height: 320,
    onClick: sr => select(rows.find(r => r.id === sr.key))})));

  // ---------- the selected session ----------
  const bs = sel.steps.map((st, i) => ({key: i, label: `Response ${i + 1} · ${ctx.clock.dateTime(st.t)}`, short: String(i + 1)}));
  const values = new Map(sel.steps.map((st, i) => [i, {uncached: st.uncached, cached: st.cached, output: st.output}]));
  const parts = [{key: 'uncached', label: 'Uncached input', color: 'var(--c1)'}, {key: 'cached', label: 'Cached input (re-read context)', color: 'var(--c2)'}, {key: 'output', label: 'Output', color: 'var(--c3)'}];
  const cpRows = sel.compactions.map((cp, k) => ({...cp, k, until: sel.compactions[k + 1]?.i ?? sel.n}));
  const selCard = card(sessionTitle(sel.session), {id: 'context-session',
    sub: [projectName(sel.session.cwd), sel.session.branch, `${sel.n} responses`, sel.first ? `${ctx.clock.dateTime(sel.first)} → ${ctx.clock.time(sel.last)}` : null].filter(Boolean).join(' · '),
    actions: [h('span', {class: 'pill'}, 'selected'), h('button', {type: 'button', class: 'small', onclick: () => sessionDetail(sel.id)}, 'Session details')]},
  h('div', {class: 'tiles small'},
    tile('Tokens', compact(sel.tokens), modelDot(sel.model)),
    tile('Peak context', compact(sel.peak), sel.window ? `${share(sel.peak, sel.window, 0)} of the ${compact(sel.window)} window` : ''),
    tile('Past half window', share(sel.heavy, sel.tokens, 0), `${num(sel.heavySteps)} of ${num(sel.n)} responses`),
    tile('Growth per response', sel.growth ? compact(sel.growth) : '—', 'median context added'),
    tile('Late vs early cost', ratioText(sel.lateRatio), 'per response'),
    tile('Compactions', num(sel.compactions.length), sel.compactions.length ? `≈ ${compact(sel.avoided)} tokens avoided` : 'context never cut back')),
  h('h3', {}, 'What each response cost'),
  chartBox(el => columns(el, {buckets: bs, series: parts, values, fmt: compact, height: 240})),
  legend(parts),
  h('p', {class: 'muted small'}, 'Every response re-reads the whole context, so cached input grows with the conversation. Uncached input is what is new at that step.'),
  cpRows.length ? [h('h3', {}, 'Compactions'), table({rows: cpRows, pageSize: 10, columns: [
    {key: 'i', label: 'At response', num: true, value: r => r.i + 1},
    {key: 't', label: 'When', value: r => r.t, render: r => ctx.clock.dateTime(r.t)},
    {key: 'before', label: 'Before', num: true, value: r => r.before, compact: true},
    {key: 'after', label: 'After', num: true, value: r => r.after, compact: true},
    {key: 'cut', label: 'Cut', num: true, value: r => 1 - r.after / r.before, fmt: x => share(x, 1, 0)},
    {key: 'avoided', label: 'Re-reads avoided ≈', num: true, value: r => (r.before - r.after) * (r.until - r.i), compact: true,
      title: 'Removed context × responses until the next compaction or the end of the session'},
  ]})] : null);

  // ---------- all sessions ----------
  const tableCard = card('Sessions by context load', {sub: 'Click a row to select the session above. Sorted by total tokens.'},
    table({rows, sortKey: 'tokens', pageSize: 25, csvName: 'context-growth', onRow: select, rowClass: r => r.id === sel.id ? 'selected' : null, columns: [
      {key: 'title', label: 'Session', value: r => sessionTitle(r.session), render: r => h('div', {class: 'cell-main'},
        h('div', {class: 'ellipsis', title: sessionTitle(r.session)}, sessionTitle(r.session)), h('div', {class: 'muted small ellipsis'}, projectName(r.session.cwd)))},
      {key: 'model', label: 'Model', value: r => r.model, render: r => modelDot(r.model)},
      {key: 'tokens', label: 'Total tokens', num: true, value: r => r.tokens, compact: true},
      state.metric !== 'total_tokens' ? {key: 'value', label: metricLabel(state.metric), num: true, value: r => r.value, compact: true} : null,
      {key: 'n', label: 'Responses', num: true, value: r => r.n},
      {key: 'peak', label: 'Peak context', num: true, value: r => r.peak, render: r => [compact(r.peak), r.window ? h('span', {class: 'muted small'}, ` · ${share(r.peak, r.window, 0)}`) : null]},
      {key: 'heavy', label: 'Past half window', num: true, value: r => r.tokens ? r.heavy / r.tokens : 0, fmt: x => share(x, 1, 0), title: 'Share of the session tokens spent with more than half of the context window filled'},
      {key: 'growth', label: 'Growth / response', num: true, value: r => r.growth || null, compact: true},
      {key: 'late', label: 'Late ÷ early', num: true, value: r => Number.isFinite(r.lateRatio) ? r.lateRatio : null, fmt: ratioText},
      {key: 'cuts', label: 'Compactions', num: true, value: r => r.compactions.length},
      {key: 'last', label: 'Last activity', value: r => r.last, render: r => ctx.clock.dateTime(r.last)},
    ].filter(Boolean)}));

  return [headline, tiles, trajCard, selCard, tableCard];
}

// One line for the overview launcher strip.
export function contextLine() {
  const {rows} = analyse();
  let tokens = 0, heavy = 0;
  for (const r of rows) { tokens += r.tokens; heavy += r.heavy; }
  return rows.length ? `${share(heavy, tokens, 0)} of tokens past half the context window` : 'No sessions in this range';
}

