// Focus page "Quota budget": will the quota last until the reset, what is spending it,
// and what would make it last longer (automatic checks with the numbers behind them).
import {h, num, compact, share, duration, plural, quotaName, projectName} from './util.js';
import {burnChart, rankList} from './charts.js';
import {ctx, state, saveState, view, quotaForecast, quotaBurn, attributeQuota, card, tile, chartBox, segmented, table, color, modelDot,
  sessionKind, sourceNames, icon} from './core.js';
import {sessionDetail, sessionTitle} from './pages.js';

const pctText = v => v >= 10 ? num(v) + '%' : num(v, 1) + '%';
const keepEvent = e => state.internal || !e[2];

// Tokens per 1% of a counter over the last seven days (falls back to everything recorded).
function tokensPerPercent(points, minutes, now) {
  const D = ctx.D, T = D.mi.total_tokens;
  for (const since of [now - 7 * 86400, -Infinity]) {
    const A = attributeQuota(points, D.events, T, minutes, since, now + 1, keepEvent);
    let tokens = 0;
    for (const i of A.share.keys()) tokens += D.events[i][5][T] || 0;
    if (A.attributed >= 5) return tokens / A.attributed;
  }
  return null;
}

function counters(now) {
  const D = ctx.D, c = ctx.clock;
  return D.quota_now.filter(q => D.quota_series[`${q.limit_id}|${q.minutes}`]).map(q => {
    const key = `${q.limit_id}|${q.minutes}`, points = D.quota_series[key];
    const expired = q.reset <= now, used = expired ? 0 : q.used, start = q.reset - q.minutes * 60;
    const f = expired ? null : quotaForecast(points, q, {now});
    const perPct = tokensPerPercent(points, q.minutes, now);
    const left = Math.max(0, 100 - used), hoursLeft = Math.max(0, q.reset - now) / 3600;
    const today = expired ? 0 : quotaBurn(key, Math.max(c.dayStart(c.today()), start), now + 1).burn;
    let status = 'reset first';
    if (expired) status = 'restored';
    else if (used >= 100) status = 'at the limit';
    else if (f.rate < .05) status = 'idle';
    else if (f.hitsFirst) status = 'limit first';
    return {q, key, points, expired, used, start, f, perPct, left, hoursLeft, today, status,
      sustainable: hoursLeft ? left / hoursLeft : null, name: quotaName(q.minutes), weekly: q.minutes > 300};
  });
}

const statusChip = st => h('span', {class: ['chip', {'limit first': 'bad', 'at the limit': 'bad', 'reset first': 'ok', restored: 'ok'}[st] || null]}, st);

function forecastCard(k, now) {
  const c = ctx.clock, {q, f, perPct, left, used} = k;
  const tokens = v => perPct ? ` ≈ ${compact(v * perPct)} tokens` : '';
  const rows = [];
  if (k.expired) rows.push(['Window', `ended ${c.dateTime(q.reset)}; the counter is back to 0%`]);
  else {
    rows.push(['Resets', [h('b', {}, duration(q.reset - now)), ` · ${c.dateTime(q.reset)}`]]);
    rows.push(['Pace', f.rate < .05 ? 'no growth recently' : [h('b', {}, `+${num(f.rate, 1)}%/h`), ` over the last ${duration(f.lookback)}`]]);
    if (used < 100) {
      if (f.hitsFirst) {
        rows.push(['100% at', [h('b', {}, c.dateTime(f.hitAt)), ` · in ${duration(f.hitAt - now)}`]]);
        rows.push(['Blocked for', [h('b', {}, duration(q.reset - f.hitAt)), ' until the reset']]);
      } else rows.push(['At the reset', [h('b', {}, `≈ ${num(f.atReset)}%`), f.rate < .05 ? ' if you stay idle' : ' at this pace']]);
      rows.push(['Left', [h('b', {}, pctText(left)), tokens(left)]]);
      if (k.sustainable != null) rows.push(['Sustainable pace', [h('b', {}, `≤ ${num(k.sustainable, 1)}%/h`), tokens(k.sustainable), ' per hour, to reach the reset at 100%']]);
      if (f.budgetPerDay != null) rows.push(['Daily budget', [h('b', {}, `≤ ${num(f.budgetPerDay, 1)}%`), tokens(f.budgetPerDay), ` per day · today ${pctText(k.today)}`]]);
    }
  }
  const projection = f && !k.expired && used < 100 && f.rate >= .05
    ? {from: [now, used], to: f.hitsFirst ? [f.hitAt, 100] : [q.reset, f.atReset]} : null;
  const pts = k.points.filter(p => Math.abs(p[2] - q.reset) <= 600 && p[0] >= k.start - 60).map(p => [p[0], p[1]]);
  return card(null, {class: 'budget-card' + (used >= 90 ? ' critical' : used >= 70 ? ' warning' : '')},
    h('div', {class: 'budget-top'},
      h('div', {}, h('div', {class: 'now-label'}, k.name, q.plan ? h('span', {class: 'pill'}, q.plan) : null),
        h('div', {class: 'now-value'}, h('b', {}, num(used)), h('span', {class: 'unit'}, '% used'))),
      statusChip(k.status)),
    chartBox(el => burnChart(el, {points: pts, start: k.start, reset: q.reset, now: Math.min(now, q.reset), projection, clock: c, height: 190})),
    h('dl', {class: 'budget-rows'}, rows.flatMap(([dt, dd]) => [h('dt', {}, dt), h('dd', {}, dd)])),
    h('div', {class: 'meter-foot muted'}, `data as of ${c.dateTime(q.ts)}`, perPct ? ` · ≈ ${compact(perPct)} tokens per 1% over the last 7 days` : ''));
}

// Advice: each check fires only on its own evidence, so an empty list means nothing stands out.
function checks({ks, A, agg, sessions, total, scopeText}) {
  const D = ctx.D, tips = [];
  const weekly = ks.find(k => k.weekly && !k.expired), five = ks.find(k => !k.weekly && !k.expired);
  if (weekly?.status === 'limit first') tips.push({level: 'high', title: `The weekly quota runs out in ${duration(weekly.f.hitAt - Date.now() / 1000)}`,
    detail: `At +${num(weekly.f.rate, 1)}%/h it reaches 100% ${duration(weekly.q.reset - weekly.f.hitAt)} before the reset.`,
    action: weekly.f.budgetPerDay != null ? `Keep to ≤ ${num(weekly.f.budgetPerDay, 1)}% per day${weekly.perPct ? ` (≈ ${compact(weekly.f.budgetPerDay * weekly.perPct)} tokens)` : ''}; today so far ${pctText(weekly.today)}.` : 'Slow down until the reset.'});
  if (five?.status === 'limit first') tips.push({level: 'medium', title: `The five-hour quota hits 100% in ${duration(five.f.hitAt - Date.now() / 1000)}`,
    detail: `${duration(five.q.reset - five.f.hitAt)} would be spent waiting for the reset at ${ctx.clock.time(five.q.reset)}.`,
    action: five.sustainable != null ? `Stay under ${num(five.sustainable, 1)}%/h to make it, or queue heavy work for after the reset.` : ''});
  if (weekly && weekly.status !== 'limit first' && weekly.status !== 'at the limit' && weekly.f && weekly.f.atReset < 85)
    tips.push({level: 'ok', title: 'The weekly quota is on track', detail: `About ${num(weekly.f.atReset)}% will be used when it resets ${duration(weekly.q.reset - Date.now() / 1000)} from now.`, action: ''});
  if (!A.attributed) return tips;

  const of = v => share(v, A.attributed, 0);
  if (agg.heavy / A.attributed > .3) tips.push({level: 'medium', title: `${of(agg.heavy)} of the quota went to responses with a long context`,
    detail: `These responses ran with more than half of the context window filled; each cost ×${num(agg.heavyCost, 1)} the quota of a shorter one.`,
    action: 'Start a fresh session once a task is done, or compact earlier.', page: 'context'});
  const top = sessions[0];
  if (top && top.pct / A.attributed > .25) tips.push({level: 'medium', title: `One session took ${of(top.pct)} of the quota spent ${scopeText}`,
    detail: `“${sessionTitle(top.session)}” — ${pctText(top.pct)} of the counter ${scopeText}.`,
    action: 'Open it to see where its context grew.', session: top.session.id});
  const models = [...agg.models.values()].filter(m => m.pct / A.attributed >= .05 && m.tokens);
  if (models.length > 1) {
    const rate = m => m.pct / m.tokens;
    models.sort((p, q) => rate(q) - rate(p));
    const hi = models[0], lo = models[models.length - 1], ratio = rate(hi) / rate(lo);
    if (ratio >= 1.5 && hi.pct / A.attributed >= .2) tips.push({level: 'info', title: `${D.models[hi.model]} spends ×${num(ratio, 1)} the quota per token of ${D.models[lo.model]}`,
      detail: `${D.models[hi.model]} took ${of(hi.pct)} of the quota with ${share(hi.tokens, agg.tokens, 0)} of the tokens.`,
      action: `Use ${D.models[lo.model]} for routine steps where it is good enough.`});
  }
  const highEffort = [...agg.efforts.entries()].filter(([i]) => /high/i.test(D.efforts[i] || '')).reduce((n, [, x]) => n + x, 0);
  if (highEffort / A.attributed > .5) tips.push({level: 'info', title: `${of(highEffort)} of the quota was spent at high reasoning effort`,
    detail: 'High and extra-high effort produce more reasoning tokens per response.', action: 'Lower the effort for mechanical tasks such as renames, formatting or simple edits.'});
  const helpers = (agg.kinds.get('subagent') || 0) + (agg.kinds.get('review') || 0);
  if (helpers / A.attributed > .2) tips.push({level: 'info', title: `Subagents and reviews spent ${of(helpers)} of the quota`,
    detail: `Subagents ${of(agg.kinds.get('subagent') || 0)}, reviews ${of(agg.kinds.get('review') || 0)}.`, action: 'Check whether every delegated run was needed.'});
  if (agg.cacheShare < .7 && agg.input) tips.push({level: 'info', title: `Only ${share(agg.cacheShare, 1, 0)} of input came from the cache`,
    detail: 'Uncached input is new context the model has to read.', action: 'Keep a task in one session instead of re-explaining it in new ones.'});
  if (agg.locked > 1800) tips.push({level: 'medium', title: `${duration(agg.locked)} at a usage limit ${scopeText}`,
    detail: 'Time between hitting 100% and the reset.', action: 'Spread heavy work across windows, or start long tasks right after a reset.'});
  const all = A.attributed + A.unattributed;
  if (A.unattributed / all > .15) tips.push({level: 'info', title: `${share(A.unattributed, all, 0)} of the quota is not explained by this profile`,
    detail: 'The counter grew while this profile recorded no responses.', action: 'Other devices, voice, or another profile on the same account share this quota.'});
  const order = {high: 0, medium: 1, info: 2, ok: 3};
  return tips.sort((p, q) => order[p.level] - order[q.level]);
}

function tipList(tips) {
  if (!tips.length) return h('div', {class: 'empty'}, 'Nothing stands out: no check found a pattern worth changing.');
  const glyph = {high: 22, medium: 22, info: 21, ok: 23};
  return h('ul', {class: 'tips'}, tips.map(t => h('li', {class: ['tip-item', 'is-' + t.level]},
    h('span', {class: 'tip-icon'}, icon(glyph[t.level])),
    h('div', {class: 'tip-body'},
      h('div', {class: 'tip-head'}, t.title),
      t.detail ? h('div', {class: 'tip-detail'}, t.detail) : null,
      t.action || t.page || t.session ? h('div', {class: 'tip-action'}, t.action,
        t.page ? h('a', {href: '#/' + t.page, class: 'link'}, 'Open Context growth →') : null,
        t.session ? h('button', {type: 'button', class: 'link', onclick: () => sessionDetail(t.session)}, 'Open session →') : null) : null))));
}

export function budget() {
  const D = ctx.D, c = ctx.clock, now = Date.now() / 1000, B = state.budget, T = D.mi.total_tokens;
  const ks = counters(now);
  if (!ks.length) return [card('Quota budget', {}, h('div', {class: 'empty'}, 'No quota snapshots in the history of this profile.'))];

  // ---------- attribution scope ----------
  const keys = ks.map(k => k.key);
  const key = keys.includes(B.key) ? B.key : (ks.find(k => k.weekly) || ks[0]).key;
  const K = ks.find(k => k.key === key), v = view();
  const [a, b] = B.scope === 'range' ? [v.a, v.b] : [K.start, now + 1];
  const scopeText = B.scope === 'range' ? 'in the selected period' : 'in the current window';
  ctx.bar = h('div', {class: 'bar-group'},
    h('span', {class: 'bar-label'}, 'Spent from'), segmented(ks.map(k => [k.key, k.name]), key, x => { B.key = x; saveState(); ctx.render(); }, {class: 'small', label: 'Counter'}),
    segmented([['window', 'Current window'], ['range', 'Selected period']], B.scope, x => { B.scope = x; saveState(); ctx.render(); }, {class: 'small', label: 'Scope'}));

  const A = attributeQuota(K.points, D.events, T, K.q.minutes, a, b, keepEvent);
  const agg = {tokens: 0, input: 0, cached: 0, heavy: 0, heavyTok: 0, lightTok: 0, heavyN: 0, lightN: 0, models: new Map(), efforts: new Map(), kinds: new Map(), projects: new Map()};
  const bySession = new Map();
  for (const [i, pct] of A.share) {
    const e = D.events[i], tok = e[5][T] || 0, sess = D.sessions[e[3]];
    agg.tokens += tok; agg.input += e[5][D.mi.input_tokens] || 0; agg.cached += e[5][D.mi.cached_input_tokens] || 0;
    const heavy = e[6] && e[6] >= (e[7] ? e[7] / 2 : 128e3);
    if (heavy) { agg.heavy += pct; agg.heavyTok += pct; agg.heavyN++; } else { agg.lightTok += pct; agg.lightN++; }
    const m = agg.models.get(e[1]) || {model: e[1], pct: 0, tokens: 0}; m.pct += pct; m.tokens += tok; agg.models.set(e[1], m);
    agg.efforts.set(e[4], (agg.efforts.get(e[4]) || 0) + pct);
    agg.kinds.set(sessionKind(sess), (agg.kinds.get(sessionKind(sess)) || 0) + pct);
    const pk = D.sessionProject[e[3]], p = agg.projects.get(pk) || {key: pk, name: sess.cwd ? projectName(sess.cwd) : 'No directory', pct: 0};
    p.pct += pct; agg.projects.set(pk, p);
    const st = bySession.get(e[3]) || {session: sess, pct: 0, tokens: 0, responses: 0, models: new Map(), first: e[0], last: e[0]};
    st.pct += pct; st.tokens += tok; st.responses++; st.last = e[0]; st.models.set(e[1], (st.models.get(e[1]) || 0) + tok);
    bySession.set(e[3], st);
  }
  agg.heavyCost = agg.heavyN && agg.lightN && agg.lightTok ? (agg.heavyTok / agg.heavyN) / (agg.lightTok / agg.lightN) : 1;
  agg.cacheShare = agg.input ? agg.cached / agg.input : 1;
  agg.locked = quotaBurn(key, a, b).locked;
  const sessions = [...bySession.values()].sort((p, q) => q.pct - p.pct);
  for (const st of sessions) st.model = D.models[[...st.models.entries()].sort((p, q) => q[1] - p[1])[0][0]];
  const tips = checks({ks, A, agg, sessions, total: A.attributed, scopeText});

  // ---------- headline ----------
  const say = k => {
    if (k.expired) return [`${k.name}: the window ended; the counter is back to 0%. `];
    if (k.status === 'at the limit') return [`${k.name}: `, h('b', {}, 'at the limit'), ` until the reset in ${duration(k.q.reset - now)}. `];
    if (k.status === 'limit first') return [`${k.name}: `, h('b', {}, `${num(k.used)}%`), ', runs out ', h('b', {class: 'down'}, `in ${duration(k.f.hitAt - now)}`), ` at the current pace — ${duration(k.q.reset - k.f.hitAt)} before the reset. `];
    if (k.status === 'idle') return [`${k.name}: `, h('b', {}, `${num(k.used)}%`), `, idle; resets in ${duration(k.q.reset - now)}. `];
    return [`${k.name}: `, h('b', {}, `${num(k.used)}%`), ', on track for ', h('b', {}, `≈ ${num(k.f.atReset)}%`), ` at the reset in ${duration(k.q.reset - now)}. `];
  };
  const weekly = ks.find(k => k.weekly && !k.expired);
  const urgent = tips.filter(t => t.level === 'high' || t.level === 'medium').length;
  const headline = card(null, {class: 'headline'}, h('div', {class: 'headline-body'}, h('div', {class: 'headline-text'},
    h('div', {class: 'eyebrow'}, `Quota budget · ${c.dateTime(now)}`, urgent ? h('span', {class: 'chip bad'}, `${urgent} ${plural(urgent, 'warning', 'warnings')}`) : h('span', {class: 'chip ok'}, 'no warnings')),
    h('p', {class: 'lede'}, [...ks].sort((p, q) => q.q.minutes - p.q.minutes).flatMap(say)),
    h('ul', {class: 'facts'},
      weekly?.f?.budgetPerDay != null ? h('li', {}, 'To last until the weekly reset: ', h('b', {}, `≤ ${num(weekly.f.budgetPerDay, 1)}%`), ' per day; today so far ', h('b', {}, pctText(weekly.today))) : null,
      sessions[0] ? h('li', {}, `Biggest consumer ${scopeText}: `, h('b', {}, sessionTitle(sessions[0].session)), ` — ${pctText(sessions[0].pct)} of the ${K.name.toLowerCase()}`) : null,
      A.attributed ? h('li', {}, `${K.name} ${scopeText}: `, h('b', {}, pctText(A.attributed + A.unattributed)), ' spent', A.unattributed ? `, ${pctText(A.unattributed)} not explained by this profile` : '') : null,
      h('li', {}, tips.length ? `${tips.length} automatic ${plural(tips.length, 'check', 'checks')} with findings below` : 'Automatic checks found nothing to change')))));

  // ---------- forecast ----------
  const forecasts = h('div', {class: 'grid'}, ks.map(k => forecastCard(k, now)));

  // ---------- advice ----------
  const adviceCard = card('What to change', {sub: 'Automatic checks on the forecast and on what spent the quota. Each one shows the numbers it is based on.'}, tipList(tips));

  // ---------- where it went ----------
  const fmtPct = x => pctText(x);
  const spent = A.attributed + A.unattributed;
  const tiles = h('div', {class: 'tiles'},
    tile(`${K.name} spent`, pctText(spent), (spent > 100 ? `≈ ${num(spent / 100, 1)} full quotas · ` : '') + (B.scope === 'range' ? `${c.date(a)} – ${c.dateY(b - 1)}` : `since ${c.dateTime(K.start)}`), {class: 'hero'}),
    tile('Matched to responses', share(A.attributed, spent, 0), `${num(A.share.size)} responses in ${num(sessions.length)} sessions`),
    tile('Tokens per 1%', A.attributed ? compact(agg.tokens / A.attributed) : '—', 'total tokens of matched responses'),
    tile('Long-context share', share(agg.heavy, A.attributed, 0), 'quota spent past half of the context window'),
    tile('Time at the limit', agg.locked ? duration(agg.locked) : '—', 'between 100% and the reset'));

  const models = [...agg.models.values()].sort((p, q) => q.pct - p.pct);
  const modelCard = card('By model', {class: 'mini', sub: 'Quota used, its share, tokens per 1%'},
    chartBox(el => rankList(el, models.map(m => ({label: D.models[m.model], sub: m.pct ? `${compact(m.tokens / m.pct)}/1%` : '', value: m.pct, color: color(D.models[m.model])})), {fmt: fmtPct, total: A.attributed})));
  const projects = [...agg.projects.values()].sort((p, q) => q.pct - p.pct);
  const projCard = card('By project', {class: 'mini', sub: 'Quota used and its share'},
    chartBox(el => rankList(el, projects.map(p => ({label: p.name, value: p.pct, key: p.key})), {fmt: fmtPct, total: A.attributed})));
  const efforts = [...agg.efforts.entries()].sort((p, q) => q[1] - p[1]);
  const kinds = [...agg.kinds.entries()].sort((p, q) => q[1] - p[1]);
  const effortCard = card('By effort and session type', {class: 'mini', sub: 'Quota used and its share'},
    chartBox(el => rankList(el, [...efforts.map(([i, pct]) => ({label: D.efforts[i] === '—' ? 'effort: unspecified' : `effort: ${D.efforts[i]}`, value: pct})),
      ...kinds.map(([k, pct]) => ({label: k === 'main' ? 'main sessions' : (sourceNames[k] || k).toLowerCase() + 's', value: pct, color: 'var(--ink-2)'}))], {fmt: fmtPct, total: A.attributed, max: 8})));

  const sessCard = card('Sessions that spent the most', {sub: `Share of the ${K.name.toLowerCase()} ${scopeText}. Click a row for details.`},
    table({rows: sessions, sortKey: 'pct', pageSize: 10, csvName: 'quota-by-session', onRow: st => sessionDetail(st.session.id), columns: [
      {key: 'title', label: 'Session', value: st => sessionTitle(st.session), render: st => h('div', {class: 'cell-main'},
        h('div', {class: 'ellipsis', title: sessionTitle(st.session)}, sessionTitle(st.session)), h('div', {class: 'muted small ellipsis'}, projectName(st.session.cwd)))},
      {key: 'model', label: 'Model', value: st => st.model, render: st => modelDot(st.model)},
      {key: 'kind', label: 'Type', value: st => sourceNames[st.session.source] || sessionKind(st.session)},
      {key: 'pct', label: 'Quota', num: true, value: st => st.pct, fmt: pctText},
      {key: 'share', label: 'Share', num: true, value: st => A.attributed ? st.pct / A.attributed : 0, fmt: x => share(x, 1, 0)},
      {key: 'tokens', label: 'Tokens', num: true, value: st => st.tokens, compact: true},
      {key: 'per', label: 'Tokens per 1%', num: true, value: st => st.pct ? st.tokens / st.pct : null, compact: true},
      {key: 'resp', label: 'Responses', num: true, value: st => st.responses},
      {key: 'last', label: 'Last activity', value: st => st.last, render: st => c.dateTime(st.last)},
    ]}));

  const explain = card(null, {}, h('details', {class: 'explain'}, h('summary', {}, 'How this is calculated'),
    h('p', {}, 'Forecast: the pace is how much the counter grew over the last hour (five-hour quota) or day (longer quotas), idle time included, and it is extended in a straight line to the reset. The sustainable pace and the daily budget spread what is left evenly until the reset.'),
    h('p', {}, 'Attribution: every increase of the counter between two recorded snapshots is split across the responses recorded in that interval, in proportion to their total tokens. Increases with no responses in the interval stay unexplained — usage from other devices, voice, or another profile that shares the account.'),
    h('p', {}, 'Checks fire only when their own numbers cross a threshold: more than 30% of the quota at long context, one session above 25%, a model spending at least 1.5× the quota per token of another, more than half at high effort, more than 20% in subagents and reviews, less than 70% of input from the cache, more than 30 minutes at a limit, or more than 15% unexplained.')));

  return [headline, forecasts, adviceCard, h('h3', {class: 'section-title'}, `Where the ${K.name.toLowerCase()} went`), tiles,
    h('div', {class: 'grid three minis'}, modelCard, projCard, effortCard), sessCard, explain];
}

// One line for the overview signals.
export function budgetLine() {
  const now = Date.now() / 1000, ks = counters(now);
  const k = ks.find(x => x.weekly && !x.expired) || ks.find(x => !x.expired);
  if (!k) return 'No live quota counters';
  if (k.status === 'limit first') return `${k.name} runs out in ${duration(k.f.hitAt - now)}`;
  if (k.status === 'at the limit') return `${k.name}: at the limit until the reset`;
  return `${k.name}: ≈ ${num(k.f.atReset)}% at the reset${k.f.budgetPerDay != null ? `, ≤ ${num(k.f.budgetPerDay, 1)}%/day` : ''}`;
}

