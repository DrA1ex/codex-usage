// Regression checks for the focus pages' statistics and calendar math.
// Run with: node tests/test_focus.mjs
import assert from 'node:assert/strict';

const {mannWhitney, quantile, Clock} = await import('../src/codex_usage/web/js/util.js');
const core = await import('../src/codex_usage/web/js/core.js');
const close = (actual, expected, tolerance, message) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

// Mann–Whitney: fully separated samples (normal approximation with continuity correction).
close(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).p, 0.0122, 0.0005, 'separated samples');
assert.equal(mannWhitney([3, 3, 3], [3, 3, 3]).p, 1, 'identical samples');
assert(mannWhitney([5, 1, 4, 2, 3], [2, 4, 3, 5, 1]).p > 0.9, 'same distribution');
assert(Number.isNaN(mannWhitney([], [1]).p), 'empty sample');
assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);

// Quota burn sums increases inside each reset epoch; a new deadline starts from zero.
const clock = new Clock('UTC');
core.ctx.clock = clock;
core.ctx.D = {
  quota_series: {'codex|300': [[0, 10, 1000], [100, 30, 1000], [200, 5, 5000], [300, 20, 5000], [350, 12, 5000, 1]]},
  windows: [
    {limit_id: 'codex', minutes: 300, start: 0, end: 100, deadline: 1000, full: true},
    {limit_id: 'codex', minutes: 300, start: 200, end: 350, deadline: 5000, full: false},
  ],
};
const all = core.quotaBurn('codex|300', 0, 400);
assert.equal(all.burn, 10 + 20 + 5 + 15 + 12, 'burn across epochs, refill restarts from zero');
assert.equal(core.quotaBurn('codex|300', 150, 320).burn, 5 + 15, 'burn inside a sub-range');
assert.equal(all.started, 2);
assert.equal(all.full, 1);
assert.equal(all.locked, 100, 'lockout ends when the next window starts');

// Calendar periods: ISO weeks start on Monday; months roll over the year boundary.
const day = clock.fromIso('2026-10-21'); // Wednesday
assert.equal(clock.iso(core.periodStart('week', day, clock)), '2026-10-19');
assert.equal(clock.iso(core.periodShift('month', clock.fromIso('2026-12-01'), 1, clock)), '2027-01-01');
assert.equal(clock.iso(core.periodShift('month', clock.fromIso('2026-01-01'), -1, clock)), '2025-12-01');
const month = core.period('month', clock.fromIso('2026-02-01'), clock);
assert.equal(month.days, 28);
assert.equal(core.contextBucket(15_999), 0);
assert.equal(core.contextBucket(128_000), 4);
assert.equal(core.contextBucket(2e6), core.CONTEXT_BUCKETS.length - 1);
console.log('focus checks passed');

// Quota forecast: wall-clock pace over the lookback, from the counter value at its start.
{
  const reset = 20000, q = {used: 40, reset, ts: 3600 * 3, minutes: 300}; // window started at 2000
  const points = [[2600, 5, reset], [7200, 30, reset], [10800, 40, reset]];
  const f = core.quotaForecast(points, q, {now: 10800});
  close(f.rate, 10, 1e-9, 'pace from the last snapshot before the lookback (30% → 40% in one hour)');
  close(f.hitAt, 10800 + 6 * 3600, 1e-6, '60 points left at 10%/h');
  assert.equal(f.hitsFirst, false, 'reset at 20000 comes before 32400');
  close(f.atReset, 40 + 10 * (reset - 10800) / 3600, 1e-9, 'projected level at the reset');
  const idle = core.quotaForecast(points, q, {now: 10800 + 3600});
  assert.equal(idle.rate, 0, 'an idle hour means no pace');
  const other = core.quotaForecast([[100, 90, 9999], ...points], q, {now: 10800, lookback: 86400});
  close(other.rate, 40 / ((10800 - 2000) / 3600), 1e-9, 'snapshots of another reset epoch are ignored; whole window from zero');
}

// Context growth: compactions, heavy share, avoided re-reads, late/early ratio.
{
  const mi = {total_tokens: 0, input_tokens: 1, cached_input_tokens: 2, output_tokens: 3};
  const contexts = [10e3, 40e3, 80e3, 120e3, 30e3, 60e3, 90e3, 150e3];
  const events = contexts.map((c, i) => [i * 60, 0, 0, 0, 0, [c + 1000, c, c * .9, 1000], c, 200e3]);
  const a = core.sessionContext(events, mi);
  assert.equal(a.n, 8);
  assert.equal(a.peak, 150e3);
  assert.deepEqual(a.compactions.map(cp => [cp.i, cp.before, cp.after]), [[4, 120e3, 30e3]], 'one drop of more than 40%');
  assert.equal(a.avoided, 90e3 * 4, 'removed context × remaining responses');
  assert.equal(a.heavySteps, 2, '120K and 150K are past half of the 200K window');
  assert.equal(a.growth, 30e3, 'median positive step, compaction excluded');
  close(a.lateRatio, (91e3 + 151e3) / (11e3 + 41e3), 1e-9, 'last quarter over first quarter');
}
// Quota attribution: each counter increase is split across the responses since the previous snapshot by tokens.
{
  const points = [[1000, 10, 18500], [2000, 30, 18500], [3000, 30, 18500], [4000, 40, 18500]];
  const ev = (ts, tokens, internal = 0) => [ts, 0, internal, 0, 0, [tokens], 0, 0];
  const events = [ev(400, 999), ev(600, 100), ev(900, 300), ev(1500, 200), ev(1600, 500, 1)];
  const A = core.attributeQuota(points, events, 0, 300, 0, 5000, e => !e[2]);
  close(A.share.get(1), 2.5, 1e-9, 'first increase, pro-rata by tokens');
  close(A.share.get(2), 7.5, 1e-9, 'first increase, pro-rata by tokens');
  close(A.share.get(3), 20, 1e-9, 'filtered response gets nothing, the rest takes the increase');
  assert(!A.share.has(0) && !A.share.has(4), 'before the window start, filtered out');
  assert.equal(A.attributed, 30);
  assert.equal(A.unattributed, 10, 'an increase with no responses stays unexplained');
  const late = core.attributeQuota(points, events, 0, 300, 1500, 5000);
  assert.equal(late.attributed, 20, 'only snapshots inside [a, b)');
  close(late.share.get(4), 20 * 500 / 700, 1e-9, 'no filter: internal responses count');
}
console.log('forecast, context and attribution checks passed');
// Context-window changes need a sustained run of the new value; work per 1% splits cached re-reads from new work.
{
  const ev = (ts, model, window) => [ts, model, 0, 0, 0, [], 0, window];
  const events = [];
  for (let i = 0; i < 30; i++) events.push(ev(i, 0, 272e3));
  events.push(ev(30, 0, 400e3), ev(31, 0, 272e3)); // a stray response is not a change
  for (let i = 40; i < 70; i++) events.push(ev(i, 0, 400e3), ev(i + .5, 1, 128e3));
  const changes = core.windowChanges(events);
  assert.deepEqual(changes, [{model: 0, t: 40, from: 272e3, to: 400e3}], 'one change of model 0, dated at its first response');
  assert.deepEqual(core.windowChanges(events, 40), [], 'shorter runs do not count');

  const r = core.workRates({total_tokens: 1100, input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100, responses: 5}, 10);
  assert.equal(r.total, 110);
  assert.equal(r.cached, 90);
  assert.equal(r.uncached, 10);
  assert.equal(r.fresh, 20, 'uncached input + output');
  close(r.weighted, (100 + 900 * .1 + 100 * 8) / 10, 1e-9, 'API-ratio weights by default');
  assert.equal(r.responses, .5);
  assert.equal(core.workRates({input_tokens: 10}, 0).total, null, 'no usage, no rate');
}
console.log('context window and work-rate checks passed');
// Task speed: like-for-like index by model × context size, change point, busy-span overlap, per-task breakdown.
{
  const mi = {output_tokens: 0, total_tokens: 1};
  // ev(ts, model, context, output, generation, tools, compaction, turn)
  const ev = (ts, model, ctx, out, gen, tools = 0, comp = 0, turn = -1, session = 0) => [ts, model, 0, session, 0, [out, out], ctx, 0, gen, tools, comp, turn];
  const before = [], after = [];
  for (let i = 0; i < 20; i++) before.push(ev(i, 0, 20e3, 400, 10), ev(i, 0, 200e3, 400, 20));
  // Later: the same cells at the same speed, but the mix moves to the slow large-context cell.
  for (let i = 0; i < 20; i++) after.push(ev(100 + i, 0, 200e3, 400, 20));
  close(core.genSpeed(before, mi).speed, 800 / 30, 1e-9, 'pooled speed');
  close(core.genSpeed(after, mi).speed, 20, 1e-9, 'pooled speed drops with a bigger context');
  close(core.speedIndex(before, after, mi).change, 0, 1e-9, 'like for like: no slower inference');
  const slower = after.map(e => { const x = [...e]; x[8] = 25; return x; });
  close(core.speedIndex(before, slower, mi).change, 20 / 25 - 1, 1e-9, 'like for like: 20% slower');
  const other = [ev(200, 1, 20e3, 400, 5)];
  assert.equal(core.speedIndex(before, other, mi).coverage, 0, 'a model without a baseline is not compared');
  assert(core.genSpeed([ev(0, 0, 0, 400, 30, 0, 1)], mi).speed == null, 'compaction calls are not timed');

  const days = Array.from({length: 12}, (_, i) => ({t: i, value: (i < 7 ? 1 : .7) * (1 + (i % 3 - 1) * .02)}));
  const cp = core.changePoint(days);
  assert.equal(cp.t, 7, 'step detected on its first day');
  close(cp.change, -.3, .02, 'size of the step');
  assert.equal(core.changePoint(days.map(d => ({...d, value: 1 + (d.t % 3 - 1) * .02}))), null, 'flat series: no step');

  const u = core.unionSpans([[10, 20], [15, 30], [40, 50]]);
  assert.deepEqual([u.s, u.e], [[10, 40], [30, 50]], 'overlapping spans merge');
  assert.equal(core.overlap(u, 0, 100), 30);
  assert.equal(core.overlap(u, 25, 45), 10);
  assert.equal(core.overlap(u, 31, 39), 0);

  // Task 0 runs 0–100 s: generation 0–20, tools 20–60 (auto-review busy 30–36), generation 60–75, tools 75–95
  // (a subagent busy 70–90), compaction 95–99. Task 3 runs 200–210 with one response.
  core.ctx.D = {
    sessions: [{source: 'cli'}, {source: 'review'}, {source: 'subagent'}],
    turns: [[0, 100, 0, 2, 0], [30, 6, 1, null, 0], [70, 20, 2, null, 0], [200, 10, 0, 1, 0]], // [start, duration, session, ttft, aborted]
  };
  const main = [ev(60, 0, 1e3, 300, 20, 40, 0, 0), ev(95, 0, 1e3, 200, 15, 20, 0, 0), ev(99, 0, 1e3, 0, 4, 0, 1, 0), ev(209, 0, 1e3, 100, 8, 0, 0, 3)];
  const side = [ev(36, 0, 1e3, 50, 5, 0, 0, 1, 1), ev(90, 0, 1e3, 50, 18, 0, 0, 2, 2)];
  const turns = core.turnBreakdown([...main, ...side], mi);
  assert.deepEqual(turns.map(x => x.i), [0, 3], 'only turns of main sessions are tasks');
  const t = turns[0];
  assert.deepEqual([t.model, t.compaction, t.review, t.subagent, t.tools, t.other, t.total], [35, 4, 6, 15, 39, 1, 100]);
  assert.equal(t.out, 500);
  const p = core.pool(turns);
  assert.deepEqual([p.n, p.model, p.other, p.total], [2, 43, 3, 110]);
}
console.log('task speed checks passed');
// Binary segmentation finds both steps of a speed series that rose and then fell.
{
  const days = Array.from({length: 24}, (_, i) => ({t: i, value: (i < 8 ? 1 : i < 16 ? 1.5 : 1.05) * (1 + (i % 3 - 1) * .02)}));
  assert.deepEqual(core.changePoints(days).map(st => st.t), [8, 16], 'a rise, then a fall');
  assert(core.changePoints(days).at(-1).change < -.2, 'the latest step is the fall');
}
console.log('change point checks passed');
