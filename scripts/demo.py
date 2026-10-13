#!/usr/bin/env python3
"""Build a self-contained synthetic dashboard and optionally serve it on loopback.

No real Codex profiles, caches, credentials or session logs are read. The dashboard
uses the actual bundled frontend with an in-memory demo API and isolated UI state.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import random
import re
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from codex_usage.analysis import prepare_report
from codex_usage.cli import DEFAULTS
from codex_usage.loader import History
from codex_usage.report import export_tables, write_report
from codex_usage.settings import METRICS
from codex_usage.webdata import build_dataset, daily_totals, quota_now


def synthetic_history(now: float, seed: int = 7) -> History:
    rng = random.Random(seed)
    history = History()
    projects = ["atlas-dashboard", "orbit-search", "canvas-studio", "signal-api", "lumen-docs"]
    titles = ["Build the analytics dashboard", "Refactor the search index", "Add keyboard navigation",
              "Optimize image processing", "Write integration tests", "Polish the settings screen",
              "Review accessibility"]
    models = ["demo-coder", "demo-reasoner", "demo-fast"]
    midnight = dt.datetime.fromtimestamp(now, dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    starts = []
    for day in range(35):
        for slot in range(1 + (day % 3 != 0)):
            starts.append(midnight - (35 - day) * 86400 + (9 + slot * 6) * 3600)
    starts.append(now - 7200)
    weekly_base = midnight - 35 * 86400
    for i, start in enumerate(starts):
        model = models[(i + seed) % len(models)]
        sid = f"demo-{seed:02d}-session-{i:03d}"
        cwd = f"/home/demo/projects/{projects[i % len(projects)]}"
        history.sessions[sid] = {"id": sid, "cwd": cwd, "originator": "demo-client", "cli_version": "demo",
                                 "source": "cli" if i % 4 == 0 else "vscode", "parent": None,
                                 "branch": "feature/demo-dashboard", "started": start,
                                 "file": f"/home/demo/.codex-demo/sessions/rollout-{sid}.jsonl"}
        history.thread_names[sid] = titles[i % len(titles)]
        peak = 68 if i == len(starts) - 1 else [100, 100, 99, 100, 76, 100][i % 6]
        window_span = 6600 if i == len(starts) - 1 else rng.randint(6000, 15500)
        reset = start + 18000
        for step in range(25):
            ts = start + window_span * step / 24
            inp = int((45000 + step * 7500) * (1.1 if model == "demo-reasoner" else .8 if model == "demo-fast" else 1) * rng.uniform(.8, 1.2))
            out = rng.randint(1800, 6500)
            cached = int(inp * rng.uniform(.62, .91))
            history.events.append({"ts": ts, "model": model, "session": sid, "internal": False,
                                   "effort": ["medium", "high", "low"][(i + seed) % 3], "context": inp,
                                   "context_window": 524288, "file": "synthetic.jsonl", "line": step + 1,
                                   "counts": {"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out,
                                              "cached_input_tokens": cached, "uncached_input_tokens": inp - cached,
                                              "reasoning_output_tokens": int(out * .55), "responses": 1}})
            history.snapshots.append({"ts": ts, "model": model, "internal": False, "limit_id": "codex",
                                      "minutes": 300, "reset": reset, "used": round(peak * step / 24, 1),
                                      "plan": "Demo", "file": "synthetic.jsonl", "line": step + 1})
            week = int((ts - weekly_base) // (7 * 86400))
            week_start = weekly_base + week * 7 * 86400
            used = min(100, max(0, (ts - week_start - 9 * 3600) / (6 * 86400) * 100))
            history.snapshots.append({"ts": ts, "model": model, "internal": False, "limit_id": "codex",
                                      "minutes": 10080, "reset": week_start + 7 * 86400, "used": round(used, 1),
                                      "plan": "Demo", "file": "synthetic.jsonl", "line": step + 1})
        if i % 5 == 0:
            child = sid + "-agent"
            history.sessions[child] = {**history.sessions[sid], "id": child, "source": "subagent", "parent": sid,
                                       "file": f"/home/demo/.codex-demo/sessions/rollout-{child}.jsonl"}
            history.thread_names[child] = "Check accessibility and tests"
            for step in range(8):
                history.events.append({"ts": start + 1800 + step * 150, "model": model, "session": child,
                                       "internal": False, "effort": "medium", "context": 40000 + step * 2500,
                                       "context_window": 524288, "file": "synthetic.jsonl", "line": step + 1,
                                       "counts": {"input_tokens": 45000, "cached_input_tokens": 30000,
                                                  "uncached_input_tokens": 15000, "output_tokens": 2500,
                                                  "reasoning_output_tokens": 1200, "total_tokens": 47500, "responses": 1}})
    history.events.sort(key=lambda e: e["ts"])
    history.snapshots.sort(key=lambda s: s["ts"])
    history.files = len(history.sessions)
    return history


def build(output: Path) -> Path:
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    output.mkdir(parents=True, exist_ok=True)
    profiles, datasets, comparisons = [], {}, []
    histories = []
    for seed, label, name in [(7, "Studio · demo", ".codex-studio"), (19, "Lab · demo", ".codex-lab")]:
        history = synthetic_history(now, seed)
        histories.append(history)
        profile = {"path": f"/home/demo/{name}", "name": name, "label": label, "valid": True,
                   "exists": True, "custom": False, "files": history.files, "size": len(history.events) * 720,
                   "modified": now - 300, "scanned_at": now, "events": len(history.events),
                   "sessions": len(history.sessions), "stale": False, "quota_now": quota_now(history), "plans": ["Demo"]}
        profiles.append(profile)
        datasets[profile["path"]] = build_dataset(history, profile)
        comparisons.append({**profile, "daily": daily_totals(history, "UTC")})
    payload = {"profiles": profiles, "datasets": datasets, "compare": comparisons,
               "meta": {"timezone": "UTC", "home": "/home/demo", "root": "/demo", "checkout": False,
                        "metrics": METRICS, "config": {"codex_home": profiles[0]["path"], "timezone": "UTC"},
                        "python": "3.11+", "last_profile": profiles[0]["path"], "default_profile": profiles[0]["path"]}}
    payload_json = json.dumps(payload, ensure_ascii=True).replace("<", "\\u003c")
    demo_api = '''const demo = JSON.parse(document.getElementById('demo-data').textContent);
export const api = {
  async get(raw) {
    const u = new URL(raw, 'http://demo.invalid');
    if (u.pathname === '/api/meta') return structuredClone(demo.meta);
    if (u.pathname === '/api/profiles') return {profiles: structuredClone(demo.profiles)};
    if (u.pathname === '/api/dataset') return structuredClone(demo.datasets[u.searchParams.get('profile')]);
    if (u.pathname === '/api/compare') {
      const metric = u.searchParams.get('metric') || 'total_tokens', timezone = u.searchParams.get('tz') || 'UTC';
      const clock = new Clock(timezone), internal = u.searchParams.get('internal') === '1';
      const profiles = demo.compare.map(p => {
        const D = demo.datasets[p.path], mi = D.metric_keys.indexOf(metric), daily = {};
        for (const e of D.events) {
          if (!internal && e[2]) continue;
          const day = clock.iso(clock.day(e[0])); daily[day] = (daily[day] || 0) + (e[5][mi] || 0);
        }
        return {...p, daily};
      });
      return {profiles, timezone, metric};
    }
    if (u.pathname === '/api/jobs') return {jobs: []};
    if (u.pathname === '/api/reports') return {reports: []};
    throw new Error('This synthetic demo does not access files or a real profile.');
  },
  async post(raw, data) {
    if (raw === '/api/preview-command') return {command: 'python3 generate.py --codex-home /home/demo/.codex-studio --days 30 --open'};
    throw new Error('Read-only synthetic demo. Use the regular app for this action.');
  },
};
'''
    imports = {}
    web = ROOT / "src/codex_usage/web"
    for path in sorted((web / "js").glob("*.js")):
        source = path.read_text()
        source = re.sub(r"from '\./([^']+)\.js'", r"from 'demo/\1'", source)
        if path.name == "util.js":
            source = source.replace("codex-usage:", "codex-usage-synthetic-demo:")
        if path.name == "core.js":
            start = source.index("export const api =")
            end = source.index("// ---------- state ----------", start)
            source = source[:start] + demo_api + "\n" + source[end:]
        imports["demo/" + path.stem] = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    html = (web / "index.html").read_text()
    html = html.replace('<link rel="stylesheet" href="/static/style.css">', '<style>' + (web / "style.css").read_text() + '</style>')
    html = html.replace("Local · no external requests", "Synthetic demo · local only")
    html = html.replace('<script type="module" src="/static/js/app.js"></script>',
                        '<script type="application/json" id="demo-data">' + payload_json + '</script>\n'
                        '<script type="importmap">' + json.dumps({"imports": imports}) + '</script>\n'
                        '<script type="module">import "demo/app";</script>')
    target = output / "showcase.html"
    target.write_text(html)
    options = {**DEFAULTS, "codex_home": "/home/demo/.codex-studio", "profile_name": "Synthetic demo",
               "start_ts": now - 30 * 86400, "end_ts": now, "start_arg": dt.datetime.fromtimestamp(now - 30 * 86400, dt.timezone.utc).date().isoformat(),
               "end_arg": dt.datetime.fromtimestamp(now, dt.timezone.utc).date().isoformat(),
               "period_seconds": 259200, "quota_minutes": 300}
    report = prepare_report(histories[0], options)
    write_report(report, output / "demo-report.html")
    export_tables(report, output / "demo-report")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "demo-data")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--build-only", action="store_true", help="Generate the standalone demo without starting a server")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    target = build(args.output.resolve())
    print(f"Synthetic dashboard: {target}")
    if args.build_only:
        return
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(target.parent), **kw)
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/showcase.html"
        print(f"Synthetic demo only: {url} (Ctrl+C to stop)")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
