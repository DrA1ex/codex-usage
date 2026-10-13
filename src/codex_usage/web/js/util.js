// DOM helpers, number formatting and timezone-aware date math.
// All untrusted strings (model names, thread titles, paths) go through text nodes.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function append(node, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) { for (const c of child) append(node, c); return; }
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyAttrs(node, attrs, isSvg) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (!isSvg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled')) node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
}

export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs, false);
  append(node, children);
  return node;
}

export function s(tag, attrs, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  applyAttrs(node, attrs, true);
  append(node, children);
  return node;
}

// ---------- numbers ----------
const nf = new Map();
function numberFormat(digits) {
  if (!nf.has(digits)) nf.set(digits, new Intl.NumberFormat('en-US', {maximumFractionDigits: digits, minimumFractionDigits: 0}));
  return nf.get(digits);
}
export const num = (v, digits = 0) => numberFormat(digits).format(v || 0);

export function compact(v) {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return num(v / 1e9, a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2) + ' B';
  if (a >= 1e6) return num(v / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + ' M';
  if (a >= 1e4) return num(v / 1e3, a >= 1e5 ? 0 : 1) + ' K';
  return num(v, a < 10 && a % 1 ? 1 : 0);
}

export const pct = (v, digits = 0) => num(v, digits) + '%';

export function share(part, total, digits = 1) {
  return total ? pct(100 * part / total, digits) : '—';
}

export function bytes(v) {
  if (v >= 1e9) return num(v / 1e9, 1) + ' GB';
  if (v >= 1e6) return num(v / 1e6, 0) + ' MB';
  return num(v / 1e3, 0) + ' KB';
}

export function plural(n, one, many) {
  return Math.abs(n) === 1 ? one : many;
}

export function duration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const d = Math.floor(seconds / 86400), hh = Math.floor(seconds % 86400 / 3600), mm = Math.floor(seconds % 3600 / 60);
  if (d) return `${d} d ${hh} h`;
  if (hh) return `${hh} h ${mm} min`;
  if (mm) return `${mm} min`;
  return `${seconds} s`;
}

export function ago(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'just now';
  return duration(diff) + ' ago';
}

export function minutesLabel(n) {
  if (n % 1440 === 0) return n === 10080 ? 'week' : `${n / 1440} ${plural(n / 1440, 'day', 'days')}`;
  if (n % 60 === 0) return `${n / 60} h`;
  return `${n} min`;
}

export function quotaName(minutes) {
  if (minutes === 300) return '5-hour quota';
  if (minutes === 10080) return 'Weekly quota';
  return 'Quota ' + minutesLabel(minutes);
}

// ---------- timezone clock ----------
// Wall-clock math via a memoised UTC offset per hour: fast enough for 100k events.
export class Clock {
  constructor(tz) {
    this.tz = tz;
    this.parts = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    this.cache = new Map();
    const base = {timeZone: tz};
    this.fDate = new Intl.DateTimeFormat('en-US', {...base, day: 'numeric', month: 'short'});
    this.fDateY = new Intl.DateTimeFormat('en-US', {...base, day: 'numeric', month: 'short', year: 'numeric'});
    this.fDateTime = new Intl.DateTimeFormat('en-US', {...base, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
    this.fTime = new Intl.DateTimeFormat('en-US', {...base, hour: '2-digit', minute: '2-digit'});
    this.fMonth = new Intl.DateTimeFormat('en-US', {...base, month: 'long', year: 'numeric'});
    this.fWeekday = new Intl.DateTimeFormat('en-US', {...base, weekday: 'short', day: 'numeric', month: 'short'});
  }
  offset(ts) {
    const key = Math.floor(ts / 3600);
    let v = this.cache.get(key);
    if (v === undefined) {
      const p = Object.fromEntries(this.parts.formatToParts(new Date(key * 3600000)).filter(x => x.type !== 'literal').map(x => [x.type, +x.value]));
      v = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - key * 3600;
      this.cache.set(key, v);
    }
    return v;
  }
  local(ts) { return ts + this.offset(ts); }
  day(ts) { return Math.floor(this.local(ts) / 86400); }
  hour(ts) { return Math.floor((((this.local(ts) % 86400) + 86400) % 86400) / 3600); }
  weekday(ts) { return (this.day(ts) + 3) % 7; } // Monday = 0
  dayStart(day) {
    let ts = day * 86400;
    for (let i = 0; i < 3; i++) ts = day * 86400 - this.offset(ts);
    return ts;
  }
  hourStart(ts) { const l = this.local(ts); return ts - (((l % 3600) + 3600) % 3600); }
  iso(day) { return new Date(day * 86400000).toISOString().slice(0, 10); }
  fromIso(text) { const [y, m, d] = text.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
  today() { return this.day(Date.now() / 1000); }
  monthStartDay(day) { const d = new Date(day * 86400000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000; }
  nextMonthDay(day) { const d = new Date(day * 86400000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86400000; }
  date(ts) { return this.fDate.format(new Date(ts * 1000)); }
  dateY(ts) { return this.fDateY.format(new Date(ts * 1000)); }
  dateTime(ts) { return this.fDateTime.format(new Date(ts * 1000)); }
  time(ts) { return this.fTime.format(new Date(ts * 1000)); }
  month(ts) { return this.fMonth.format(new Date(ts * 1000)); }
  weekdayDate(ts) { return this.fWeekday.format(new Date(ts * 1000)); }
}

// ---------- misc ----------
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function download(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([type.startsWith('text/csv') ? '﻿' + text : text], {type}));
  const a = h('a', {href: url, download: name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csv(rows) {
  const q = v => {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(t) && isNaN(Number(t))) t = "'" + t;
    return /[",\n;]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t;
  };
  return rows.map(r => r.map(q).join(',')).join('\r\n');
}

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem('codex-usage:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('codex-usage:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

// Codex worktrees (~/.codex/worktrees/<id>/<repo>) belong to the same project as each other.
const WORKTREE = /\/\.codex[^/]*\/worktrees\/[^/]+\/(.+)$/;
export function projectKey(cwd) {
  if (!cwd) return '';
  const m = cwd.match(WORKTREE);
  return m ? 'worktree:' + m[1] : cwd;
}

export function projectName(cwd) {
  if (!cwd) return 'No directory';
  const m = cwd.match(WORKTREE);
  const parts = (m ? m[1] : cwd).split('/').filter(Boolean);
  return (parts[parts.length - 1] || cwd) + (m ? ' (worktree)' : '');
}

export function shortPath(path, home) {
  if (!path) return '';
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

export function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// replaceChildren that skips null/false placeholders from conditional children.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false).map(c => c instanceof Node ? c : document.createTextNode(String(c))));
  return el;
}
