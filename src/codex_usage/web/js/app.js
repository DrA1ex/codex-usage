import {locales, resolveTimezone, h, $, num, ago, debounce, fill} from './util.js';
import {hideTip} from './charts.js';
import {ctx, state, defaults as DEFAULTS, saveState, api, prepare, newClock, invalidate, resolveRange, color, toast, card, segmented, select, icon} from './core.js';
import {overview, quota, modelsPage, sessions, projectsPage} from './pages.js';
import {review, watch, anatomy} from './focus.js';
import {contextPage} from './context.js';
import {budget} from './budget.js';
import {workPage} from './work.js';
import {speedPage} from './speed.js';
import {profilesPage, commandsPage, dataPage, watchJob, profileTitle} from './tools.js';

// icon: index in /static/img/icons.png; scope: which global filters the page reads.
const ALL = {range: true, models: true, project: true, metric: true};
const PAGES = {
  review: {title: 'Period review', icon: 0, group: 'Focus', render: review, data: true, scope: {models: true, project: true, metric: true},
    lead: 'How a day, week or month went, compared with the ones before it.'},
  budget: {title: 'Quota budget', icon: 20, group: 'Focus', render: budget, data: true, scope: {range: true},
    lead: 'Will your quota last until the reset, what is spending it, and what would make it last longer.'},
  watch: {title: 'Quota watch', icon: 1, group: 'Focus', render: watch, data: true, scope: {metric: true},
    lead: 'Has the capacity of your Codex quota changed? Recent windows against a baseline, per model.'},
  work: {title: 'Work per quota', icon: 12, group: 'Focus', render: workPage, data: true, scope: {range: true, models: true, project: true},
    lead: 'Does more of each percent go to re-reading a longer context? Total tokens per 1% against new input and output per 1%.'},
  speed: {title: 'Task speed', icon: 24, group: 'Focus', render: speedPage, data: true, scope: {range: true, models: true, project: true},
    lead: 'Are tasks slower because the model generates more slowly, or because more of each task goes to tools, reviews and compactions?'},
  anatomy: {title: 'Spend anatomy', icon: 2, group: 'Focus', render: anatomy, data: true, scope: ALL,
    lead: 'What your usage is made of, and what drove it up or down.'},
  context: {title: 'Context growth', icon: 16, group: 'Focus', render: contextPage, data: true, scope: ALL,
    lead: 'How context accumulates inside sessions, where compactions cut it back, and what long contexts cost.'},
  overview: {title: 'Overview', icon: 3, group: 'Charts', render: overview, data: true, scope: ALL},
  quota: {title: 'Quotas', icon: 4, group: 'Charts', render: quota, data: true, scope: {range: true, models: true, metric: true}},
  models: {title: 'Models', icon: 5, group: 'Charts', render: modelsPage, data: true, scope: ALL},
  sessions: {title: 'Sessions', icon: 6, group: 'Charts', render: sessions, data: true, scope: ALL},
  projects: {title: 'Projects', icon: 7, group: 'Charts', render: projectsPage, data: true, scope: ALL},
  profiles: {title: 'Profiles', icon: 8, group: 'Setup', render: profilesPage},
  commands: {title: 'Commands', icon: 9, group: 'Setup', render: commandsPage},
  data: {title: 'Data', icon: 10, group: 'Setup', render: dataPage, data: true, scope: ALL},
};
const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];

let page = 'overview', loading = null, scanJob = null, autoTimer = null;

// ---------- URL state ----------
// The view lives in the hash query, so a link or a bookmark reopens the same slice: #/review?range=30d&unit=week.
// A hash without a query (a plain navigation link) keeps the current state.
const PAGE_STATE = {review: ['unit', 'at', 'measure'], watch: ['key', 'sample', 'recent', 'baseline'], anatomy: ['rows', 'cols'],
  quota: ['key', 'threshold', 'period'], sessions: ['q', 'kind'], context: ['kind', 'session'], budget: ['key', 'scope'],
  work: ['key', 'split', 'weights', 'measure'], speed: ['split', 'view']};

function writeUrl() {
  const q = new URLSearchParams();
  q.set('range', state.range.preset);
  if (state.range.preset === 'custom') { q.set('from', state.range.from || ''); q.set('to', state.range.to || ''); }
  if (state.models.length) q.set('models', state.models.join(','));
  if (state.project) q.set('project', state.project);
  if (state.metric !== 'total_tokens') q.set('metric', state.metric);
  if (state.internal) q.set('internal', '1');
  if (state.gran !== 'auto') q.set('gran', state.gran);
  const ns = state[page];
  for (const k of PAGE_STATE[page] || []) if (ns[k] != null && ns[k] !== '' && ns[k] !== DEFAULTS[page][k]) q.set(k, ns[k]);
  const url = `#/${page}?${q.toString().replace(/%2C/g, ',').replace(/%7C/g, '|').replace(/%2F/g, '/')}`;
  if (location.hash !== url) history.replaceState(null, '', url);
}


function readUrl() {
  const raw = location.hash.split('?')[1];
  if (raw == null) return;
  const q = new URLSearchParams(raw), name = currentPage();
  state.range.preset = q.get('range') || DEFAULTS.range.preset;
  if (state.range.preset === 'custom') { state.range.from = q.get('from'); state.range.to = q.get('to'); }
  state.models = q.get('models') ? q.get('models').split(',').filter(Boolean) : [];
  state.project = q.get('project') || '';
  state.metric = q.get('metric') || DEFAULTS.metric;
  state.internal = q.get('internal') === '1';
  state.gran = q.get('gran') || 'auto';
  const ns = state[name];
  for (const k of PAGE_STATE[name] || []) {
    const v = q.get(k), d = DEFAULTS[name][k];
    ns[k] = v == null ? d : typeof d === 'number' || (d == null && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : v;
  }
  invalidate(); saveState();
}

function copyLink() {
  writeUrl();
  navigator.clipboard?.writeText(location.href).then(() => toast('Link to this view copied', 'ok'), () => toast(location.href));
}

function currentPage() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES[name] ? name : 'overview';
}

ctx.go = name => { if (currentPage() === name) render(); else location.hash = '#/' + name; };
ctx.render = render;
ctx.renderHeader = renderHeader;
ctx.reload = () => loadProfile({quiet: true});
ctx.switchProfile = path => {
  if (path !== state.profile) {
    state.profile = path; state.models = []; state.project = ''; state.context.session = null; state.quota.key = null; saveState();
    ctx.D = null; invalidate(); loadProfile();
  }
  ctx.go('overview');
};

// ---------- theme ----------
function applyTheme() {
  const t = state.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}

// ---------- layout ----------

function renderNav() {
  const nav = $('#nav'), groups = new Map();
  for (const [key, p] of Object.entries(PAGES)) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(h('a', {href: '#/' + key, class: ['nav-item', key === page && 'on'], 'aria-current': key === page ? 'page' : null},
      icon(p.icon), h('span', {}, p.title)));
  }
  fill(nav, ...[...groups].map(([name, items]) => h('div', {class: ['nav-group', name.toLowerCase()]}, h('div', {class: 'nav-title'}, name), items)));
  fill($('#theme'), segmented([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], state.theme, t => { state.theme = t; saveState(); applyTheme(); renderNav(); render(); }, {class: 'small', label: 'Theme'}));
}

function renderHeader() {
  const head = $('#head');
  const valid = ctx.profiles.filter(p => p.valid);
  const current = ctx.profiles.find(p => p.path === state.profile);
  const status = scanJob ? h('span', {class: 'status warn'}, h('i', {class: 'spinner'}), scanJob.last || 'Scanning…')
    : ctx.D ? h('span', {class: 'status', title: `Scanned ${new Date(ctx.D.profile.scanned_at * 1000).toLocaleString(locales, {timeZone: state.tz})}`}, `updated ${ago(ctx.D.profile.scanned_at)}`) : null;
  const auto = h('label', {class: 'check small', title: 'Read new records every two minutes to track quota usage'},
    h('input', {type: 'checkbox', checked: !!state.auto, onchange: e => { state.auto = e.target.checked; saveState(); setupAuto(); }}), 'auto-refresh');
  const spec = PAGES[page];
  fill(head, h('div', {class: 'head-row'},
    h('div', {class: 'head-title'}, h('div', {class: 'crumb'}, spec.group === 'Focus' ? 'Focus · investigation' : spec.group), h('h1', {}, spec.title),
      spec.lead ? h('p', {class: 'lead'}, spec.lead) : null),
    h('div', {class: 'head-profile'},
      h('label', {class: 'sr-only', for: 'profile-select'}, 'Profile'),
      valid.length ? select(valid.map(p => [p.path, profileTitle(p) + (p.plans?.length ? ` · ${p.plans.join(', ')}` : '')]), state.profile, v => ctx.switchProfile(v), {id: 'profile-select', class: 'profile-select'})
        : h('a', {href: '#/profiles', class: 'link'}, 'Choose a profile'),
      current ? h('button', {type: 'button', class: 'ghost', disabled: !!scanJob, onclick: () => refresh(false), title: 'Read new profile records'}, icon(13), 'Refresh') : null,
      auto, status)));
  renderBar();
}

// The sticky bar: global filters the page reads, then the page's own controls.
function renderBar() {
  const bar = $('#bar'), spec = PAGES[page];
  const show = spec.data && ctx.D;
  bar.hidden = !show;
  if (!show) { fill(bar); return; }
  fill(bar, h('div', {class: 'bar-inner'},
    h('span', {class: 'bar-page'}, icon(spec.icon), spec.title),
    filters(spec.scope || ALL),
    ctx.bar ? h('div', {class: 'bar-page-controls'}, ctx.bar) : null));
}

function filters(scope) {
  const D = ctx.D, r = resolveRange(), c = ctx.clock;
  const setRange = patch => { Object.assign(state.range, patch); saveState(); render(); };
  const parts = [];
  if (scope.range) {
    const from = h('input', {type: 'date', value: c.iso(r.fromDay), 'aria-label': 'Start', onchange: e => e.target.value && setRange({preset: 'custom', from: e.target.value, to: c.iso(r.toDay)})});
    const to = h('input', {type: 'date', value: c.iso(r.toDay), 'aria-label': 'End date', onchange: e => e.target.value && setRange({preset: 'custom', from: c.iso(r.fromDay), to: e.target.value})});
    // Date inputs only while choosing a custom range; otherwise the resolved range is a compact label.
    parts.push(segmented(RANGES, state.range.preset, p => setRange({preset: p}), {label: 'Period', class: 'ranges small'}),
      state.range.preset === 'custom' ? h('div', {class: 'dates'}, from, h('span', {class: 'muted'}, '—'), to)
        : h('span', {class: 'range-label muted small', title: 'Choose Custom to type exact dates'}, r.days === 1 ? c.dateY(r.a) : `${c.date(r.a)} – ${c.dateY(r.b - 1)}`));
  }
  if (scope.models) {
    const selected = new Set(state.models);
    const modelsLabel = state.models.length === 0 ? 'All models' : state.models.length === 1 ? state.models[0] : `Models: ${state.models.length}`;
    parts.push(h('details', {class: 'dropdown models-menu'},
      h('summary', {class: ['btn-like', state.models.length && 'active']}, modelsLabel, ' ▾'),
      h('div', {class: 'dropdown-menu'},
        h('button', {type: 'button', class: 'ghost small', onclick: () => { state.models = []; saveState(); render(); }}, 'All models'),
        D.models.map(m => {
          const cb = h('input', {type: 'checkbox', checked: selected.has(m)});
          cb.addEventListener('change', () => { if (cb.checked) selected.add(m); else selected.delete(m); state.models = D.models.filter(x => selected.has(x)); saveState(); render({keepMenu: true}); });
          return h('label', {class: 'check'}, cb, h('i', {class: 'swatch', style: {background: color(m)}}), m);
        }))));
  }
  if (scope.project && D.projects.length > 1) {
    const known = D.projects.some(p => p.key === state.project);
    parts.push(select([['', 'All projects'], ...D.projects.map(p => [p.key, p.name])], known ? state.project : '', v => { state.project = v; saveState(); render(); },
      {'aria-label': 'Project', class: ['bar-select', 'project-select', known && 'active'], title: known ? state.project : 'Filter every page to one project'}));
  }
  if ((scope.models && state.models.length) || (scope.project && state.project))
    parts.push(h('button', {type: 'button', class: 'ghost small clear-filters', title: 'Clear model and project filters',
      onclick: () => { state.models = []; state.project = ''; saveState(); render(); }}, icon(19), 'Clear'));
  if (scope.metric) parts.push(select(D.metric_keys.map(k => [k, D.metric_labels[k]]), state.metric, v => { state.metric = v; saveState(); render(); }, {'aria-label': 'Metric', class: 'bar-select'}));
  const zones = (Intl.supportedValuesOf?.('timeZone') || [state.tz]);
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  const tz = select([['auto', `Auto (${resolveTimezone()})`], ...zones.map(z => [z, z])], state.tzPreference, v => {
    state.tzPreference = v; state.tz = resolveTimezone(v); ctx.clock = newClock(state.tz);
    saveState(); invalidate(); render();
  }, {'aria-label': 'Timezone', class: 'tz'});
  const internal = h('label', {class: 'check small', title: 'Internal auto-reviewer. Its subscription quota impact is not established by the logs.'},
    h('input', {type: 'checkbox', checked: state.internal, onchange: e => { state.internal = e.target.checked; saveState(); invalidate(); render(); }}), 'Include internal auto-review');
  parts.push(h('details', {class: 'dropdown more-menu'},
    h('summary', {class: ['btn-like', state.internal && 'active'], title: 'More options', 'aria-label': 'More options'}, icon(14)),
    h('div', {class: 'dropdown-menu right'}, internal, h('label', {class: 'field'}, h('span', {}, 'Timezone'), tz),
      h('button', {type: 'button', class: 'small', onclick: copyLink}, icon(17), 'Copy link to this view'))));
  return h('div', {class: 'filters'}, parts);
}

// ---------- command palette ----------
// Every navigation and view switch, reachable from the keyboard: ⌘K / Ctrl+K or "/".
function commands() {
  const list = [];
  for (const [key, p] of Object.entries(PAGES)) list.push({section: 'Go to', title: p.title, icon: p.icon, hint: p.group, run: () => ctx.go(key)});
  if (ctx.D) {
    for (const [preset, label] of RANGES.filter(r => r[0] !== 'custom'))
      list.push({section: 'Period', title: `Show ${label.toLowerCase()}`, icon: 0, hint: state.range.preset === preset ? 'current' : '', run: () => { state.range.preset = preset; saveState(); render(); }});
    for (const unit of ['day', 'week', 'month'])
      list.push({section: 'Period review', title: `Review this ${unit}`, icon: 0, run: () => { Object.assign(state.review, {unit, at: null}); saveState(); ctx.go('review'); }});
    for (const k of ctx.D.metric_keys)
      list.push({section: 'Metric', title: `Measure ${ctx.D.metric_labels[k].toLowerCase()}`, icon: 2, hint: state.metric === k ? 'current' : '', run: () => { state.metric = k; saveState(); render(); }});
    list.push({section: 'Actions', title: 'Refresh profile data', icon: 13, run: () => refresh(false)});
    list.push({section: 'Actions', title: 'Copy link to this view', icon: 17, run: copyLink});
    if (state.models.length || state.project) list.push({section: 'Actions', title: 'Clear model and project filters', icon: 19, run: () => { state.models = []; state.project = ''; saveState(); render(); }});
    for (const m of ctx.D.models)
      list.push({section: 'Filter', title: `Model: ${m}`, icon: 5, hint: state.models.includes(m) ? 'on' : '', run: () => { state.models = state.models.length === 1 && state.models[0] === m ? [] : [m]; saveState(); render(); }});
    for (const p of ctx.D.projects)
      list.push({section: 'Filter', title: `Project: ${p.name}`, icon: 7, hint: state.project === p.key ? 'on' : '', run: () => { state.project = state.project === p.key ? '' : p.key; saveState(); render(); }});
  }
  for (const p of ctx.profiles.filter(p => p.valid))
    list.push({section: 'Profile', title: `Switch to ${profileTitle(p)}`, icon: 8, hint: p.path === state.profile ? 'current' : '', run: () => ctx.switchProfile(p.path)});
  for (const t of ['auto', 'light', 'dark'])
    list.push({section: 'Appearance', title: `Theme: ${t}`, icon: 14, hint: state.theme === t ? 'current' : '', run: () => { state.theme = t; saveState(); applyTheme(); render(); }});
  return list;
}

function openPalette() {
  const root = $('#palette');
  if (root.classList.contains('open')) return;
  const all = commands();
  let found = all, at = 0;
  const input = h('input', {type: 'text', placeholder: 'Type a command or a page…', 'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false'});
  const listEl = h('div', {class: 'palette-list', role: 'listbox'});
  const close = () => { root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); fill(root); };
  const run = item => { close(); item?.run(); };
  const draw = () => {
    let section = null;
    fill(listEl, found.length ? found.flatMap((it, i) => {
      const head = it.section !== section ? h('div', {class: 'palette-section'}, section = it.section) : null;
      return [head, h('button', {type: 'button', class: ['palette-item', i === at && 'on'], role: 'option', 'aria-selected': i === at ? 'true' : 'false',
        onmousemove: () => { if (at !== i) { at = i; draw(); } }, onclick: () => run(it)},
        icon(it.icon), h('span', {}, it.title), it.hint ? h('span', {class: 'hint'}, it.hint) : null)];
    }) : h('div', {class: 'empty'}, 'No matching commands'));
    listEl.querySelector('.palette-item.on')?.scrollIntoView({block: 'nearest'});
  };
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    found = all.filter(it => { const text = `${it.section} ${it.title} ${it.hint || ''}`.toLowerCase(); return words.every(w => text.includes(w)); });
    at = 0; draw();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % Math.max(1, found.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(found[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  fill(root, h('div', {class: 'palette-backdrop', onclick: close}),
    h('div', {class: 'palette-panel', role: 'dialog', 'aria-label': 'Command palette'},
      h('div', {class: 'palette-input'}, icon(11), input, h('kbd', {}, 'esc')),
      listEl,
      h('div', {class: 'palette-foot'}, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), 'navigate'), h('span', {}, h('kbd', {}, '↵'), 'run'), h('span', {}, h('kbd', {}, 'esc'), 'close'))));
  root.classList.add('open'); root.setAttribute('aria-hidden', 'false');
  draw(); input.focus();
}

// ---------- rendering ----------
function render(opts = {}) {
  page = currentPage();
  hideTip();
  ctx.bar = null; ctx.keys = null;
  const content = $('#content');
  const scroll = window.scrollY;
  const spec = PAGES[page];
  document.title = `${spec.title} · codex usage`;
  let nodes;
  if (spec.data && !ctx.D) nodes = [placeholder()];
  else {
    try { nodes = spec.render(); }
    catch (e) { console.error(e); nodes = [card('Rendering error', {}, h('pre', {class: 'log'}, String(e.stack || e)))]; }
  }
  // Pages publish their controls into ctx.bar while rendering, so the header goes second.
  renderNav();
  renderHeader();
  if (opts.keepMenu) $('#bar .models-menu')?.setAttribute('open', '');
  fill(content, ...nodes.flat().filter(Boolean));
  window.scrollTo(0, opts.resetScroll ? 0 : scroll);
  writeUrl();
  if (opts.keepFocus) { const el = document.getElementById(opts.keepFocus); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
}

function placeholder() {
  if (!state.profile) {
    return card('Choose a profile', {sub: 'A profile is a Codex directory containing session history, such as ~/.codex. Each profile has its own account.'},
      h('div', {class: 'actions'}, h('a', {href: '#/profiles', class: 'button primary'}, 'Go to profiles')));
  }
  if (loading?.error) {
    return card('Unable to load data', {}, h('p', {class: 'error-text'}, loading.error),
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'primary', onclick: () => loadProfile()}, 'Retry'), h('a', {href: '#/profiles', class: 'button ghost'}, 'Profiles')));
  }
  const lines = scanJob?.log?.slice(-8) || [];
  return card(scanJob ? 'Scanning history' : 'Loading data', {sub: scanJob ? 'The first scan reads all files and may take a few seconds. Later scans read only new or changed files.' : null},
    h('div', {class: 'loading'}, h('i', {class: 'spinner big'}), h('div', {}, scanJob?.last || 'Preparing…')),
    lines.length ? h('pre', {class: 'log short'}, lines.join('\n')) : null);
}

// ---------- data loading ----------
async function loadProfile({quiet = false} = {}) {
  if (!state.profile) { render(); return; }
  const profile = state.profile;
  loading = {profile};
  if (!quiet) render();
  const a = state.analysis;
  const params = new URLSearchParams({profile, tolerance: a.tolerance, start_used_max: a.start_used_max, dominance: a.dominance, exclude: a.exclude.join(',')});
  try {
    let raw;
    try { raw = await api.get('/api/dataset?' + params); }
    catch (e) {
      if (e.status !== 409) throw e;
      await scan(profile, false);
      raw = await api.get('/api/dataset?' + params);
    }
    if (state.profile !== profile) return;
    ctx.D = prepare(raw);
    invalidate();
    loading = null;
    refreshProfiles();
    render();
  } catch (e) {
    loading = {profile, error: e.message};
    render();
  }
}

async function scan(profile, force) {
  const job = await api.post('/api/scan', {profile, force});
  scanJob = job;
  renderHeader();
  const done = await watchJob(job.id, j => { scanJob = j; renderHeader(); if (!ctx.D && PAGES[page].data) render(); });
  scanJob = null;
  if (done.status !== 'done') throw new Error(done.error || 'Scan failed');
  return done;
}

async function refresh(force) {
  if (!state.profile || scanJob) return;
  try {
    const before = ctx.D?.events.length || 0;
    await scan(state.profile, force);
    await loadProfile({quiet: true});
    const added = (ctx.D?.events.length || 0) - before;
    if (!state.auto) toast(added > 0 ? `Added ${num(added)} new events` : 'No new records', 'ok');
  } catch (e) { toast(e.message, 'error'); renderHeader(); }
}

function setupAuto() {
  clearInterval(autoTimer);
  if (state.auto) autoTimer = setInterval(() => { if (!document.hidden) refresh(false); }, 120000);
}

async function refreshProfiles() {
  try { ctx.profiles = (await api.get('/api/profiles')).profiles; renderHeader(); } catch { /* keep the old list */ }
}

// ---------- boot ----------
async function boot() {
  applyTheme();
  try {
    ctx.meta = await api.get('/api/meta');
  } catch (e) {
    fill($('#content'), card('Server unavailable', {}, h('p', {}, e.message)));
    return;
  }
  // Old saved tz values came from the server default; only explicit preferences override the browser.
  if (state.tzPreference !== 'auto') {
    try { newClock(state.tzPreference); } catch { state.tzPreference = 'auto'; }
  }
  state.tz = resolveTimezone(state.tzPreference);
  state.review.at = null; // A new visit reviews the current period; browsing back is per visit.
  state.review.measure ??= 'tokens';
  // The project filter used to belong to the Sessions page only.
  if (state.sessions.project) { state.project = state.sessions.project; delete state.sessions.project; }
  readUrl();
  ctx.clock = newClock(state.tz);
  ctx.profiles = (await api.get('/api/profiles')).profiles;
  const valid = ctx.profiles.filter(p => p.valid);
  if (!valid.some(p => p.path === state.profile)) {
    state.profile = (valid.find(p => p.path === ctx.meta.last_profile) || valid.find(p => p.path === ctx.meta.default_profile) || valid.find(p => p.scanned_at) || valid[0])?.path || null;
    saveState();
  }
  window.addEventListener('hashchange', () => { readUrl(); render({resetScroll: true}); });
  window.addEventListener('resize', debounce(() => { for (const el of document.querySelectorAll('.chart')) el._render?.(); }, 150));
  document.addEventListener('click', e => { for (const d of document.querySelectorAll('details.dropdown[open]')) if (!d.contains(e.target)) d.removeAttribute('open'); });
  $('#palette-open').addEventListener('click', openPalette);
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && !$('#palette').classList.contains('open')) { e.preventDefault(); openPalette(); return; }
    if ($('#palette').classList.contains('open')) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || $('#drawer').classList.contains('open')) return;
    ctx.keys?.(e);
  });
  // Show the page name inside the bar once the page title has scrolled away.
  new IntersectionObserver(([entry]) => $('#bar').classList.toggle('stuck', !entry.isIntersecting), {threshold: 0}).observe($('#head'));
  setupAuto();
  render();
  loadProfile();
}

boot();
