// Regression checks for browser locale preferences and locale-independent calendar math.
// Run with: node tests/test_locale.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const utilSource = await fs.readFile(new URL('../src/codex_usage/web/js/util.js', import.meta.url), 'utf8');
const reportSource = await fs.readFile(new URL('../src/codex_usage/report.html', import.meta.url), 'utf8');
const reportScript = reportSource.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const reportFormatting = reportScript.slice(0, reportScript.indexOf('function periodIndex('));
const stamp = Date.UTC(2026, 9, 13, 15, 4) / 1000;
const fixtures = [
  {language: 'en-US', languages: ['en-US'], date: 'Oct 13', time: '03:04 PM', number: '1,234.5'},
  {language: 'en-US', languages: ['en-GB', 'en-US'], date: '13 Oct', time: '15:04', number: '1,234.5'},
  {language: 'de-DE', languages: ['de-DE'], date: '13. Okt.', time: '15:04', number: '1.234,5'},
  {language: 'de-DE', languages: [], date: '13. Okt.', time: '15:04', number: '1.234,5'},
  {language: 'ar-EG', languages: ['ar-EG']},
];
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
try {
  for (const [index, fixture] of fixtures.entries()) {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: fixture});
    const {Clock, num, resolveTimezone} = await import('data:text/javascript;base64,' + Buffer.from(utilSource).toString('base64') + '#' + index);
    const originalTimezone = process.env.TZ;
    try {
      // Locale and timezone are independent; the browser's zone wins over any server default.
      process.env.TZ = 'Asia/Tokyo';
      assert.equal(resolveTimezone(), 'Asia/Tokyo');
      assert.equal(resolveTimezone('auto'), 'Asia/Tokyo');
      assert.equal(resolveTimezone('America/New_York'), 'America/New_York');
      assert.equal(resolveTimezone('Invalid/Timezone'), 'Asia/Tokyo');
      const localClock = new Clock(resolveTimezone());
      assert.equal(localClock.iso(localClock.day(stamp)), '2026-10-14');
      process.env.TZ = 'America/New_York';
      assert.equal(resolveTimezone(), 'America/New_York', 'Auto should follow a changed browser timezone');
      assert.equal(resolveTimezone('Asia/Tokyo'), 'Asia/Tokyo', 'A manual preference should remain fixed');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
    const clock = new Clock('UTC');
    if (fixture.date) {
      assert.equal(clock.date(stamp), fixture.date);
      assert.equal(clock.time(stamp), fixture.time);
      assert.equal(num(1234.5, 1), fixture.number);
    } else {
      assert.match(num(1234.5, 1), /[\u0660-\u0669]/, 'Arabic display digits should follow browser preferences');
    }
    // Localized display digits must never enter the internal ISO/calendar calculations.
    assert.equal(clock.iso(clock.day(stamp)), '2026-10-13');
    const ny = new Clock('America/New_York'), day = ny.fromIso('2026-03-08');
    assert.equal(ny.dayStart(day + 1) - ny.dayStart(day), 23 * 3600);
    const document = {getElementById(id) {
      assert.equal(id, 'report-data');
      return {textContent: JSON.stringify({options: {timezone: 'America/New_York'}, models: []})};
    }};
    const result = vm.runInNewContext(reportFormatting + `\n({
      locale: fullDate.resolvedOptions().locale,
      number: format(1234500, 'total_tokens'),
      iso: isoDay(${stamp}),
      span: dayStart('2026-03-09') - dayStart('2026-03-08')
    })`, {navigator: fixture, document});
    assert.equal(result.locale, fixture.languages[0] || fixture.language);
    assert.equal(result.iso, '2026-10-13');
    assert.equal(result.span, 23 * 3600);
    if (fixture.language === 'de-DE') assert.equal(result.number, '1,23');
  }
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}
console.log('Locale/timezone checks passed: browser preferences, manual timezone, invalid-zone fallback, local day boundaries, and DST in dashboard/report.');
