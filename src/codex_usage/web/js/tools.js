// Tool pages: profiles (+ folder picker and comparison), commands (jobs, reports), data quality.
import {h, num, compact, bytes, ago, duration, shortPath, quotaName, plural, download, fill} from './util.js';
import {lines, legend} from './charts.js';
import {ctx, state, saveState, api, card, tile, table, chartBox, segmented, select, toast, resolveRange, metricLabel, modelDot, info} from './core.js';

const PROFILE_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

// ---------- job polling ----------
const watchers = new Map();
export function watchJob(id, onUpdate) {
  if (watchers.has(id)) { watchers.get(id).listeners.push(onUpdate); return watchers.get(id).promise; }
  const entry = {listeners: [onUpdate]};
  entry.promise = new Promise(resolve => {
    const tick = async () => {
      let job;
      try { job = await api.get('/api/jobs/' + id); } catch { setTimeout(tick, 1500); return; }
      for (const fn of entry.listeners) fn?.(job);
      if (job.status === 'running') setTimeout(tick, 600);
      else { watchers.delete(id); resolve(job); }
    };
    tick();
  });
  watchers.set(id, entry);
  return entry.promise;
}

export function profileTitle(p) { return p.label || p.name; }

// ---------- profiles ----------
export function profilesPage() {
  const root = h('div', {class: 'stack'});
  const listEl = h('div', {class: 'profile-grid'}, h('div', {class: 'empty'}, 'Loading profiles…'));
  const compareEl = h('div');
  const pathInput = h('input', {type: 'text', placeholder: '~/.codex-work or /Volumes/Backup/.codex', 'aria-label': 'Profile directory path', class: 'mono'});
  const labelInput = h('input', {type: 'text', placeholder: 'Example: Studio account', 'aria-label': 'Profile name'});
  const add = async () => {
    try {
      await api.post('/api/profiles', {path: pathInput.value, label: labelInput.value});
      toast('Directory added', 'ok'); pathInput.value = ''; labelInput.value = '';
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  };
  const addCard = card('Add directory', {sub: 'A Codex profile is a directory containing sessions/, such as ~/.codex. Directories matching ~/.codex* are discovered automatically.'},
    h('div', {class: 'form-row'},
      h('label', {class: 'field grow'}, h('span', {}, 'Directory'), h('div', {class: 'input-group'}, pathInput,
        h('button', {type: 'button', class: 'ghost', onclick: () => folderPicker(pathInput.value || ctx.meta.home, p => { pathInput.value = p; })}, 'Browse…'))),
      h('label', {class: 'field'}, h('span', {}, 'Name (optional)'), labelInput),
      h('div', {class: 'field end'}, h('button', {type: 'button', class: 'primary', onclick: add}, 'Add'))));

  async function refresh() {
    try {
      const {profiles} = await api.get('/api/profiles');
      ctx.profiles = profiles;
      fill(listEl, ...profiles.map(profileCard));
      ctx.renderHeader?.();
      const scanned = profiles.filter(p => p.scanned_at);
      if (scanned.length >= 2) compareProfiles(compareEl); else fill(compareEl, 
        card('Profile comparison', {sub: 'Scan two or more profiles to compare account usage on one chart.'}));
    } catch (e) { fill(listEl, h('div', {class: 'empty error'}, e.message)); }
  }

  function profileCard(p) {
    const active = p.path === state.profile;
    const status = !p.valid ? ['bad', 'Directory unavailable'] : p.scan_job ? ['warn', 'Scanning…'] : !p.scanned_at ? ['neutral', 'Not scanned']
      : p.stale ? ['warn', 'New records available'] : ['ok', 'Up to date'];
    const scan = async force => {
      try {
        const job = await api.post('/api/scan', {profile: p.path, force});
        toast(`Scan ${profileTitle(p)} started`);
        refresh();
        const done = await watchJob(job.id);
        toast(done.status === 'done' ? `${profileTitle(p)}: done` : `${profileTitle(p)}: ${done.error}`, done.status === 'done' ? 'ok' : 'error');
        if (p.path === state.profile) ctx.reload();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    const rename = () => {
      const input = h('input', {type: 'text', value: p.label || '', placeholder: p.name});
      modal('Profile name', [h('label', {class: 'field'}, h('span', {}, 'Display name'), input)], [
        ['Save', async close => { try { await api.post('/api/profiles/label', {path: p.path, label: input.value}); close(); refresh(); } catch (e) { toast(e.message, 'error'); } }, 'primary']]);
      input.focus();
    };
    return h('article', {class: ['profile', active && 'active']},
      h('header', {}, h('div', {},
        h('h3', {}, profileTitle(p), active ? h('span', {class: 'chip ok'}, 'active') : null),
        h('div', {class: 'mono muted small break'}, shortPath(p.path, ctx.meta.home))),
        h('span', {class: ['chip', status[0]]}, status[1])),
      p.valid ? h('dl', {class: 'meta compact'},
        h('dt', {}, 'Session files'), h('dd', {}, `${num(p.files)} · ${bytes(p.size)}`),
        h('dt', {}, 'Latest record'), h('dd', {}, p.modified ? `${ctx.clock.dateTime(p.modified)} (${ago(p.modified)})` : '—'),
        p.default_model ? [h('dt', {}, 'Default model'), h('dd', {}, p.default_model)] : null,
        p.plans?.length ? [h('dt', {}, 'Plan'), h('dd', {}, p.plans.join(', '))] : null,
        p.scanned_at ? [h('dt', {}, 'Scanned'), h('dd', {}, `${ago(p.scanned_at)} · ${num(p.events)} events, ${num(p.sessions)} sessions`)] : null) : null,
      p.quota_now?.length ? h('div', {class: 'mini-meters'}, p.quota_now.map(q => {
        const expired = q.reset <= Date.now() / 1000, used = expired ? 0 : q.used;
        return h('div', {class: 'mini-meter'}, h('div', {class: 'row'}, h('span', {}, quotaName(q.minutes)), h('b', {}, num(used) + '%')),
          h('div', {class: ['meter', used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'good']}, h('div', {class: 'meter-fill', style: {width: used + '%'}})),
          h('div', {class: 'muted small'}, expired ? 'window ended' : `resets in ${duration(q.reset - Date.now() / 1000)}`));
      })) : null,
      h('footer', {class: 'actions'},
        p.valid ? h('button', {type: 'button', class: active ? 'ghost' : 'primary', onclick: () => ctx.switchProfile(p.path)}, active ? 'Open overview' : 'Open') : null,
        p.valid ? h('button', {type: 'button', class: 'ghost', onclick: () => scan(false), title: 'Read only new and changed files'}, p.scanned_at ? 'Refresh' : 'Scan') : null,
        p.valid && p.scanned_at ? h('button', {type: 'button', class: 'ghost', onclick: () => scan(true), title: 'Reread all files, ignoring the cache'}, 'Full rescan') : null,
        h('button', {type: 'button', class: 'ghost', onclick: rename}, 'Rename'),
        p.custom ? h('button', {type: 'button', class: 'ghost danger', onclick: async () => {
          await api.post('/api/profiles/remove', {path: p.path}); toast('Removed from list (files unchanged)'); refresh();
        }}, 'Remove from list') : null));
  }

  root.append(card('Codex profiles', {sub: 'Each profile has its own account and history. Choose a profile to analyze, or scan several to compare them.',
    actions: h('button', {type: 'button', class: 'ghost', onclick: refresh}, 'Refresh list')}, listEl), addCard, compareEl);
  refresh();
  return [root];
}

async function compareProfiles(el) {
  fill(el, card('Profile comparison', {}, h('div', {class: 'empty'}, 'Calculating…')));
  try {
    const data = await api.get(`/api/compare?tz=${encodeURIComponent(state.tz)}&metric=${encodeURIComponent(state.metric)}&internal=${state.internal ? 1 : 0}`);
    const c = ctx.clock, r = resolveRange();
    const labels = [], keys = [];
    for (let d = r.fromDay; d <= r.toDay; d++) { keys.push(c.iso(d)); labels.push({label: c.weekdayDate(c.dayStart(d)), short: c.date(c.dayStart(d))}); }
    const series = data.profiles.map((p, i) => ({key: p.path, label: p.label || p.name, color: PROFILE_COLORS[i % 8], values: keys.map(k => p.daily[k] ?? 0)}));
    const rows = data.profiles.map((p, i) => ({...p, color: PROFILE_COLORS[i % 8], total: series[i].values.reduce((a, b) => a + b, 0),
      days: series[i].values.filter(Boolean).length}));
    fill(el, card('Profile comparison', {sub: `${metricLabel(state.metric)} by day for the selected range (${r.days} days)`},
      chartBox(el2 => lines(el2, {labels, series, fmt: compact})), legend(series.map(sr => ({...sr, line: true}))),
      table({rows, sortKey: 'total', columns: [
        {key: 'name', label: 'Profile', value: p => p.label || p.name, render: p => h('span', {class: 'model'}, h('i', {class: 'swatch', style: {background: p.color}}), p.label || p.name)},
        {key: 'total', label: metricLabel(state.metric), num: true, value: p => p.total, compact: true},
        {key: 'avg', label: 'Per active day', num: true, value: p => p.days ? p.total / p.days : 0, compact: true},
        {key: 'days', label: 'Active days', num: true, value: p => p.days},
        {key: 'plan', label: 'Plan', value: p => p.plans.join(', ')},
        ...[300, 10080].map(m => ({key: 'q' + m, label: quotaName(m) + ' now', num: true, value: p => {
          const q = p.quota_now.find(x => x.minutes === m); if (!q) return null; return q.reset <= Date.now() / 1000 ? 0 : q.used; }, fmt: x => num(x) + '%'})),
      ]})));
  } catch (e) { fill(el, card('Profile comparison', {}, h('div', {class: 'empty error'}, e.message))); }
}

// ---------- modal & folder picker ----------
export function modal(title, body, buttons = []) {
  const root = document.getElementById('modal');
  const close = () => { root.replaceChildren(); root.classList.remove('open'); };
  fill(root, h('div', {class: 'modal-backdrop', onclick: close}),
    h('div', {class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
      h('header', {class: 'drawer-head'}, h('h2', {}, title), h('button', {type: 'button', class: 'ghost icon', 'aria-label': 'Close', onclick: close}, '✕')),
      h('div', {class: 'modal-body'}, body),
      h('footer', {class: 'actions end'}, h('button', {type: 'button', class: 'ghost', onclick: close}, 'Cancel'),
        buttons.map(([label, fn, cls]) => h('button', {type: 'button', class: cls || 'ghost', onclick: () => fn(close)}, label)))));
  root.classList.add('open');
  root.onkeydown = e => { if (e.key === 'Escape') close(); };
  return close;
}

export function folderPicker(start, onPick) {
  const listEl = h('div', {class: 'folder-list'});
  const pathEl = h('input', {type: 'text', class: 'mono', 'aria-label': 'Current directory'});
  const hidden = h('input', {type: 'checkbox', checked: true});
  let current = null;
  const load = async path => {
    try {
      const data = await api.get('/api/browse?path=' + encodeURIComponent(path));
      current = data; pathEl.value = data.path;
      const entries = data.entries.filter(e => hidden.checked || !e.hidden);
      fill(listEl, 
        data.parent ? h('button', {type: 'button', class: 'folder up', onclick: () => load(data.parent)}, '↑ ..') : null,
        ...entries.map(e => h('button', {type: 'button', class: ['folder', e.profile && 'is-profile'], ondblclick: () => load(e.path), onclick: () => load(e.path)},
          h('span', {}, '📁 ', e.name), e.profile ? h('span', {class: 'chip ok'}, 'Codex profile') : null)),
        entries.length ? null : h('div', {class: 'empty'}, 'No subdirectories'));
      status.textContent = data.profile ? 'This is a Codex profile; you can select it.' : 'No sessions/ directory here. Open a subdirectory or choose another directory.';
      status.className = data.profile ? 'small ok-text' : 'small muted';
    } catch (e) { toast(e.message, 'error'); }
  };
  const status = h('div', {class: 'small muted'});
  pathEl.addEventListener('keydown', e => { if (e.key === 'Enter') load(pathEl.value); });
  hidden.addEventListener('change', () => current && load(current.path));
  modal('Choose a profile directory', [
    h('div', {class: 'input-group'}, pathEl, h('button', {type: 'button', class: 'ghost', onclick: () => load(pathEl.value)}, 'Go')),
    h('label', {class: 'check'}, hidden, 'Show hidden directories'),
    listEl, status], [['Select this directory', close => { if (current) { onPick(current.path); close(); } }, 'primary']]);
  load(start);
}

// ---------- commands ----------
export function commandsPage() {
  const r = resolveRange(), c = ctx.clock;
  const profiles = ctx.profiles.filter(p => p.valid);
  const form = {profile: state.profile, start: c.iso(r.fromDay), end: c.iso(r.toDay), timezone: state.tz, period: '3d', quota_window: '5h',
    mode: 'capacity', metric: state.metric, min_used: 98, include_internal: state.internal, exclude_model: [], output: ''};
  const preview = h('code', {class: 'cmd'}, '…');
  const updatePreview = async () => {
    try { preview.textContent = (await api.post('/api/preview-command', {command: 'report', args: form})).command; preview.classList.remove('error'); }
    catch (e) { preview.textContent = e.message; preview.classList.add('error'); }
  };
  const bind = (key, el, parse = x => x) => { el.addEventListener('input', () => { form[key] = el.type === 'checkbox' ? el.checked : parse(el.value); updatePreview(); }); return el; };
  const metricOptions = ctx.D ? ctx.D.metric_keys.map(k => [k, ctx.D.metric_labels[k]]) : Object.entries(ctx.meta.metrics);
  const reportCard = card('Standalone HTML report', {sub: 'Uses the same generator as generate.py: creates HTML that opens without a server, with CSV and JSON alongside it in reports/.'},
    h('div', {class: 'form-grid'},
      h('label', {class: 'field'}, h('span', {}, 'Profile'), bind('profile', select(profiles.map(p => [p.path, profileTitle(p)]), form.profile, () => {}))),
      h('label', {class: 'field'}, h('span', {}, 'Start'), bind('start', h('input', {type: 'date', value: form.start}))),
      h('label', {class: 'field'}, h('span', {}, 'End date'), bind('end', h('input', {type: 'date', value: form.end}))),
      h('label', {class: 'field'}, h('span', {}, 'Analysis mode'), bind('mode', select([['capacity', 'Quota window capacity'], ['usage', 'Total usage']], form.mode, () => {}))),
      h('label', {class: 'field'}, h('span', {}, 'Metric'), bind('metric', select(metricOptions, form.metric, () => {}))),
      h('label', {class: 'field'}, h('span', {}, 'Comparison period'), bind('period', select([['12h', '12 hours'], ['1d', '1 day'], ['2d', '2 days'], ['3d', '3 days'], ['7d', '7 days']], form.period, () => {}))),
      h('label', {class: 'field'}, h('span', {}, 'Quota window'), bind('quota_window', select([['5h', '5 hours'], ['7d', '7 days']], form.quota_window, () => {}))),
      h('label', {class: 'field'}, h('span', {}, 'Usage threshold, %'), bind('min_used', h('input', {type: 'number', min: 1, max: 100, value: form.min_used}), Number)),
      h('label', {class: 'field'}, h('span', {}, 'Filename (optional)'), bind('output', h('input', {type: 'text', placeholder: 'auto', value: ''}))),
      h('label', {class: 'check'}, bind('include_internal', h('input', {type: 'checkbox', checked: form.include_internal})), 'Include internal reviewer')),
    h('div', {class: 'cmd-row'}, h('span', {class: 'muted small'}, 'Command:'), preview,
      h('button', {type: 'button', class: 'ghost small', onclick: () => navigator.clipboard?.writeText(preview.textContent).then(() => toast('Copied'))}, 'Copy')),
    h('div', {class: 'actions'}, h('button', {type: 'button', class: 'primary', onclick: () => run('report', form)}, 'Generate report')));
  updatePreview();

  const jobsEl = h('div'), logEl = h('pre', {class: 'log', 'aria-live': 'polite'}, 'Select a job to view its log.');
  const reportsEl = h('div');
  let selected = null;
  const showJob = job => {
    selected = job.id;
    fill(logEl, ...(job.log || []).map(l => h('div', {class: /error|traceback|fail/i.test(l) ? 'err' : l.startsWith('$ ') ? 'cmdline' : null}, l)),
      job.result?.html?.length ? h('div', {class: 'okline'}, 'Done: ', job.result.html.map(u => h('a', {href: u, target: '_blank', rel: 'noopener'}, u.split('/').pop()))) : null);
    logEl.scrollTop = logEl.scrollHeight;
  };
  const loadJobs = async () => {
    const {jobs} = await api.get('/api/jobs');
    fill(jobsEl, jobs.length ? h('div', {class: 'jobs'}, jobs.map(j => h('button', {type: 'button', class: ['job', j.id === selected && 'on'],
      onclick: async () => { showJob(await api.get('/api/jobs/' + j.id)); loadJobs(); if (j.status === 'running') watchJob(j.id, showJob); }},
      h('span', {class: ['chip', j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : 'warn']}, j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'running'),
      h('span', {class: 'job-title'}, j.title), h('span', {class: 'muted small'}, ago(j.started))))) : h('div', {class: 'empty'}, 'No jobs yet'));
  };
  const loadReports = async () => {
    const {reports} = await api.get('/api/reports');
    fill(reportsEl, table({rows: reports, sortKey: 'modified', pageSize: 10, empty: 'No reports yet', columns: [
      {key: 'name', label: 'File', value: x => x.name, render: x => h('a', {href: x.url, target: '_blank', rel: 'noopener', class: 'mono small'}, x.name)},
      {key: 'modified', label: 'Created', value: x => x.modified, render: x => ctx.clock.dateTime(x.modified)},
      {key: 'size', label: 'Size', num: true, value: x => x.size, fmt: bytes},
    ]}));
  };
  async function run(command, args) {
    try {
      const job = await api.post('/api/run', {command, args});
      showJob(job); loadJobs();
      const done = await watchJob(job.id, showJob);
      loadJobs(); loadReports();
      const link = done.status === 'done' && done.result?.html?.[0];
      toast(done.status === 'done' ? [`${done.title}: done`, link ? [' · ', h('a', {href: link, target: '_blank', rel: 'noopener'}, 'Open')] : null]
        : `${done.title}: ${done.error || 'error'}`, done.status === 'done' ? 'ok' : 'error', link ? 10000 : 4200);
    } catch (e) { toast(e.message, 'error'); }
  }
  const scanNow = async force => {
    if (!state.profile) return toast('Choose a profile first', 'error');
    const job = await api.post('/api/scan', {profile: state.profile, force});
    showJob(job); loadJobs();
    const done = await watchJob(job.id, showJob);
    loadJobs();
    if (done.status === 'done') ctx.reload();
  };
  const actions = card('Actions', {sub: 'Each action runs as a background job, with its log shown below.'},
    h('div', {class: 'action-list'},
      action('Refresh profile data', 'Reads new and changed session files. Usually finishes in a fraction of a second.', 'Refresh', () => scanNow(false)),
      action('Full rescan', 'Rereads all files, ignoring the cache. Use after parser changes or if the cache is corrupt.', 'Rescan', () => scanNow(true)),
      ctx.meta.checkout ? action('Project tests', 'Runs the automated Python tests (python3 -m unittest).', 'Run', () => run('tests', {})) : null,
      ctx.D ? action('Export data', 'Download JSON with all events, windows and sessions from the current profile for your own analysis.', 'Download JSON',
        () => download(`${ctx.D.profile.name.replace(/^\./, '')}-dataset.json`, JSON.stringify(ctx.D, (k, v) => ['mi', 'sessionIndex', 'quotaKeys'].includes(k) ? undefined : v), 'application/json')) : null));
  const cli = card('Command line', {sub: 'You can also run these actions from a terminal'}, h('div', {class: 'cheats'},
    cheat('Start the dashboard', 'python3 serve.py --open'),
    cheat('30-day report', 'python3 generate.py --days 30 --open'),
    cheat('Another profile', 'python3 generate.py --codex-home ~/.codex-work --days 30'),
    cheat('Strict capacity (100% only)', 'python3 generate.py --period 3d --quota-window 5h --min-used 100'),
    cheat('Total output-token usage', 'python3 generate.py --mode usage --metric output --days 30')));
  loadJobs(); loadReports();
  return [reportCard, h('div', {class: 'grid'}, actions, card('Job log', {actions: h('button', {type: 'button', class: 'ghost small', onclick: loadJobs}, 'Refresh')}, jobsEl, logEl)),
    card('Generated reports', {sub: 'Project reports/ directory', actions: h('button', {type: 'button', class: 'ghost small', onclick: loadReports}, 'Refresh')}, reportsEl), cli];
}

function action(title, text, label, fn) {
  return h('div', {class: 'action'}, h('div', {}, h('b', {}, title), h('div', {class: 'muted small'}, text)), h('button', {type: 'button', class: 'ghost', onclick: fn}, label));
}
function cheat(title, cmd) {
  return h('div', {class: 'cheat'}, h('div', {class: 'small'}, title), h('code', {class: 'cmd'}, cmd),
    h('button', {type: 'button', class: 'ghost small', onclick: () => navigator.clipboard?.writeText(cmd).then(() => toast('Copied'))}, 'Copy'));
}

// ---------- data quality ----------
const DIAG = {
  unchanged_usage: ['Repeated counter without new usage', 'Snapshot with unchanged cumulative totals; skipped to avoid double counting.'],
  inherited_counter_baseline: ['Inherited counter', 'Session continued the history of another session (fork/resume). Only the last step is counted, rather than the inherited total.'],
  duplicate_history_event: ['Duplicate event', 'Event already appeared in another file (copied fork history); not counted again.'],
  unknown_model_event: ['Unknown model', 'Usage before the first model record; excluded.'],
  inconsistent_total_tokens: ['total ≠ input + output', 'Record with inconsistent totals; skipped.'],
  token_counter_reset: ['Cumulative counter reset', 'Session counter restarted; usage from the last step is used.'],
  invalid_record: ['Unreadable line', 'Usually an incomplete last line in an active session.'],
  invalid_rate_snapshot: ['Invalid quota snapshot', 'Skipped.'],
  missing_total_usage: ['Missing cumulative usage', 'Skipped.'],
  missing_initial_last_usage: ['Missing initial step usage', 'First event without last_token_usage is a baseline, not new usage.'],
  invalid_usage_delta: ['Negative usage', 'Skipped.'],
  cached_exceeds_input: ['Cache exceeds input', 'Inconsistent record; skipped.'],
  skipped_file: ['Unreadable file', 'Corrupt or inaccessible file. Statistics may be incomplete.'],
  stale_or_replayed_rate_snapshot: ['Stale quota snapshot', 'Reset deadline is impossible for the timestamp of the record (import or replay); excluded.'],
  late_closed_window_snapshot: ['Late snapshot', 'Response belongs to an already closed window; skipped.'],
  confirmed_counter_refill: ['Confirmed counter reset', 'Counter fell without a new deadline, confirmed by the next response; starts a new window.'],
  unconfirmed_counter_drop: ['Unconfirmed counter drop', 'Single stale response; ignored.'],
  reset_history_unavailable: ['Reset history unavailable', ''],
  voice_history_unavailable: ['Voice history unavailable', ''],
  session_index_unavailable: ['Session titles unavailable', ''],
};

export function dataPage() {
  const D = ctx.D, a = state.analysis;
  const form = {...a};
  const apply = () => { Object.assign(state.analysis, form); saveState(); ctx.reload(); };
  const num_ = (key, attrs) => { const el = h('input', {type: 'number', value: form[key], ...attrs}); el.addEventListener('input', () => { form[key] = Number(el.value); }); return el; };
  const excluded = new Set(form.exclude);
  const modelChecks = [...new Set([...D.models, ...form.exclude])].map(m => {
    const cb = h('input', {type: 'checkbox', checked: excluded.has(m)});
    cb.addEventListener('change', () => { if (cb.checked) excluded.add(m); else excluded.delete(m); form.exclude = [...excluded]; });
    return h('label', {class: 'check'}, cb, modelDot(m));
  });
  const diag = Object.entries(D.diagnostics).sort((x, y) => y[1] - x[1]).map(([k, n]) => ({k, n, title: DIAG[k]?.[0] || k, text: DIAG[k]?.[1] || ''}));
  return [
    h('div', {class: 'tiles'},
      tile('Files read', num(D.files_read), `from cache: ${num(D.files_cached)}`),
      tile('Usage events', num(D.events.length), `${num(D.sessions.length)} sessions`),
      tile('Quota windows', num(D.windows.length), `${num(D.resets.length)} resets`),
      tile('Unreadable', num(D.skipped.length), D.skipped.length ? 'statistics may be incomplete' : 'all files readable', {class: D.skipped.length ? 'warn' : null}),
      tile('Scanned', ago(D.profile.scanned_at), D.profile.path)),
    card('Window analysis settings', {sub: 'Control how history is divided into quota windows and which windows are considered reliable. Defaults suit most cases.'},
      h('div', {class: 'form-grid'},
        h('label', {class: 'field'}, h('span', {}, 'Maximum initial usage, %', info('A window is included in capacity only if its start was observed near zero usage.')), num_('start_used_max', {min: 0, max: 50, step: 1})),
        h('label', {class: 'field'}, h('span', {}, 'Dominant-model share', info('A window is assigned to a model if it accounts for this share of tokens; otherwise it is classified as Mixed models.')), num_('dominance', {min: .5, max: 1, step: .01})),
        h('label', {class: 'field'}, h('span', {}, 'Reset-time tolerance, s', info('Deadline shifts smaller than this value do not start a new window.')), num_('tolerance', {min: 0, max: 3600, step: 10}))),
      h('div', {class: 'field'}, h('span', {class: 'label'}, 'Exclude models from analysis'), h('div', {class: 'checks'}, modelChecks)),
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'primary', onclick: apply}, 'Apply'),
        h('button', {type: 'button', class: 'ghost', onclick: () => { Object.assign(state.analysis, {tolerance: 180, start_used_max: 2, dominance: .95, exclude: []}); saveState(); ctx.reload(); }}, 'Reset'))),
    card('Parser diagnostics', {sub: 'What the loader detected and how it handled it. Counts cover the entire profile history.'},
      table({rows: diag, sortKey: 'n', pageSize: 30, csvName: 'diagnostics', columns: [
        {key: 'title', label: 'Issue', value: r => r.title, render: r => h('div', {class: 'cell-main'}, h('div', {}, r.title), h('div', {class: 'muted small mono'}, r.k))},
        {key: 'n', label: 'Count', num: true, value: r => r.n},
        {key: 'text', label: 'Handling', value: r => r.text, class: 'wrap'},
      ]})),
    D.skipped.length ? card('Unreadable files', {}, table({rows: D.skipped, columns: [
      {key: 'file', label: 'File', value: r => shortPath(r.file, ctx.meta.home), class: 'mono small'},
      {key: 'error', label: 'Error', value: r => r.error, class: 'wrap small'}]})) : null,
    card('Example records', {sub: 'First file locations that triggered diagnostics'}, table({rows: D.diagnostic_examples, pageSize: 10, columns: [
      {key: 'kind', label: 'Type', value: r => DIAG[r.kind]?.[0] || r.kind},
      {key: 'file', label: 'File', value: r => r.file, class: 'mono small'},
      {key: 'line', label: 'Line', num: true, value: r => r.line || null}]})),
    card('Privacy', {}, h('p', {class: 'muted'}, 'By default the server listens on this computer only (127.0.0.1). It makes no external requests and never reads auth.json. Token counters, models, session titles and working directories are sent to your local browser; conversation bodies are excluded. Reports and exports can contain private metadata. Keep them local or review them before sharing.')),
  ].filter(Boolean);
}
