import {h, $, num, ago, debounce, fill} from './util.js';
import {hideTip} from './charts.js';
import {ctx, state, saveState, api, prepare, newClock, invalidate, resolveRange, color, toast, card, segmented, select} from './core.js';
import {overview, quota, modelsPage, sessions, projectsPage} from './pages.js';
import {profilesPage, commandsPage, dataPage, watchJob, profileTitle} from './tools.js';

const PAGES = {
  overview: {title: 'Overview', icon: '◎', render: overview, data: true},
  quota: {title: 'Quotas', icon: '◔', render: quota, data: true},
  models: {title: 'Models', icon: '◆', render: modelsPage, data: true},
  sessions: {title: 'Sessions', icon: '☰', render: sessions, data: true},
  projects: {title: 'Projects', icon: '▣', render: projectsPage, data: true},
  profiles: {title: 'Profiles', icon: '◉', render: profilesPage},
  commands: {title: 'Commands', icon: '▶', render: commandsPage},
  data: {title: 'Data', icon: '⚙', render: dataPage, data: true},
};
const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];

let page = 'overview', loading = null, scanJob = null, autoTimer = null;

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
    state.profile = path; state.models = []; state.sessions.project = ''; state.quota.key = null; saveState();
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
  const nav = $('#nav');
  fill(nav, ...Object.entries(PAGES).map(([key, p]) => h('a', {href: '#/' + key, class: ['nav-item', key === page && 'on'], 'aria-current': key === page ? 'page' : null},
    h('span', {class: 'nav-icon', 'aria-hidden': 'true'}, p.icon), p.title)));
  fill($('#theme'), segmented([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], state.theme, t => { state.theme = t; saveState(); applyTheme(); renderNav(); render(); }, {class: 'small', label: 'Theme'}));
}

function renderHeader() {
  const head = $('#head');
  const valid = ctx.profiles.filter(p => p.valid);
  const current = ctx.profiles.find(p => p.path === state.profile);
  const status = scanJob ? h('span', {class: 'status warn'}, h('i', {class: 'spinner'}), scanJob.last || 'Scanning…')
    : ctx.D ? h('span', {class: 'status', title: `Scanned ${new Date(ctx.D.profile.scanned_at * 1000).toLocaleString('en-US')}`}, `updated ${ago(ctx.D.profile.scanned_at)}`) : null;
  const auto = h('label', {class: 'check small', title: 'Read new records every two minutes to track quota usage'},
    h('input', {type: 'checkbox', checked: !!state.auto, onchange: e => { state.auto = e.target.checked; saveState(); setupAuto(); }}), 'auto-refresh');
  const top = h('div', {class: 'head-row'},
    h('div', {class: 'head-title'}, h('h1', {}, PAGES[page].title)),
    h('div', {class: 'head-profile'},
      h('label', {class: 'sr-only', for: 'profile-select'}, 'Profile'),
      valid.length ? select(valid.map(p => [p.path, profileTitle(p) + (p.plans?.length ? ` · ${p.plans.join(', ')}` : '')]), state.profile, v => ctx.switchProfile(v), {id: 'profile-select', class: 'profile-select'})
        : h('a', {href: '#/profiles', class: 'link'}, 'Choose a profile'),
      current ? h('button', {type: 'button', class: 'ghost', disabled: !!scanJob, onclick: () => refresh(false), title: 'Read new profile records'}, '↻ Refresh') : null,
      auto, status));
  const showFilters = PAGES[page].data && ctx.D;
  fill(head, top, showFilters ? filters() : null);
}

function filters() {
  const D = ctx.D, r = resolveRange(), c = ctx.clock;
  const setRange = patch => { Object.assign(state.range, patch); saveState(); render(); };
  const from = h('input', {type: 'date', value: c.iso(r.fromDay), 'aria-label': 'Start', onchange: e => e.target.value && setRange({preset: 'custom', from: e.target.value, to: c.iso(r.toDay)})});
  const to = h('input', {type: 'date', value: c.iso(r.toDay), 'aria-label': 'End date', onchange: e => e.target.value && setRange({preset: 'custom', from: c.iso(r.fromDay), to: e.target.value})});
  const selected = new Set(state.models);
  const modelsLabel = state.models.length === 0 ? 'All models' : state.models.length === 1 ? state.models[0] : `Models: ${state.models.length}`;
  const menu = h('details', {class: 'dropdown'},
    h('summary', {class: ['btn-like', state.models.length && 'active']}, modelsLabel, ' ▾'),
    h('div', {class: 'dropdown-menu'},
      h('button', {type: 'button', class: 'ghost small', onclick: () => { state.models = []; saveState(); render(); }}, 'All models'),
      D.models.map(m => {
        const cb = h('input', {type: 'checkbox', checked: selected.has(m)});
        cb.addEventListener('change', () => { if (cb.checked) selected.add(m); else selected.delete(m); state.models = D.models.filter(x => selected.has(x)); saveState(); render({keepMenu: true}); });
        return h('label', {class: 'check'}, cb, h('i', {class: 'swatch', style: {background: color(m)}}), m);
      })));
  const metric = select(D.metric_keys.map(k => [k, D.metric_labels[k]]), state.metric, v => { state.metric = v; saveState(); render(); }, {'aria-label': 'Metric'});
  const zones = (Intl.supportedValuesOf?.('timeZone') || [state.tz]);
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  const tz = select(zones.map(z => [z, z]), state.tz, v => { state.tz = v; saveState(); ctx.clock = newClock(v); invalidate(); render(); }, {'aria-label': 'Timezone', class: 'tz'});
  const internal = h('label', {class: 'check small', title: 'Internal auto-reviewer. Its subscription quota impact is not established by the logs.'},
    h('input', {type: 'checkbox', checked: state.internal, onchange: e => { state.internal = e.target.checked; saveState(); invalidate(); render(); }}), 'internal');
  return h('div', {class: 'filters'},
    segmented(RANGES, state.range.preset, p => setRange({preset: p}), {label: 'Period', class: 'ranges'}),
    h('div', {class: 'dates'}, from, h('span', {class: 'muted'}, '—'), to),
    menu, metric, internal, tz);
}

// ---------- rendering ----------
function render(opts = {}) {
  page = currentPage();
  hideTip();
  renderNav();
  renderHeader();
  if (opts.keepMenu) $('#head .dropdown')?.setAttribute('open', '');
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
  fill(content, ...nodes.flat().filter(Boolean));
  window.scrollTo(0, opts.resetScroll ? 0 : scroll);
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
  state.tz = state.tz || ctx.meta.timezone;
  try { ctx.clock = newClock(state.tz); } catch { state.tz = 'UTC'; ctx.clock = newClock('UTC'); }
  ctx.profiles = (await api.get('/api/profiles')).profiles;
  const valid = ctx.profiles.filter(p => p.valid);
  if (!valid.some(p => p.path === state.profile)) {
    state.profile = (valid.find(p => p.path === ctx.meta.last_profile) || valid.find(p => p.path === ctx.meta.default_profile) || valid.find(p => p.scanned_at) || valid[0])?.path || null;
    saveState();
  }
  window.addEventListener('hashchange', () => render({resetScroll: true}));
  window.addEventListener('resize', debounce(() => { for (const el of document.querySelectorAll('.chart')) el._render?.(); }, 150));
  document.addEventListener('click', e => { for (const d of document.querySelectorAll('details.dropdown[open]')) if (!d.contains(e.target)) d.removeAttribute('open'); });
  setupAuto();
  render();
  loadProfile();
}

boot();
