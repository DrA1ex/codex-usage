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
console.log('forecast and context checks passed');
