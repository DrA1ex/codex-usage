"""Local web application: choose a Codex profile, scan it and analyse usage in the browser.

Only the standard library is used. The server listens on 127.0.0.1, rejects foreign Host
headers (DNS rebinding) and cross-origin writes, and never reads auth.json.
"""
from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .loader import STATE_DIR, FileCache, History, cache_location, default_workers, load_history, session_files
from .settings import ALIASES, METRICS, duration_seconds
from .webdata import build_dataset, daily_totals, quota_now

PACKAGE = Path(__file__).resolve().parent
WEB = PACKAGE / "web"
CHECKOUT = PACKAGE.parent.parent if (PACKAGE.parent.parent / "generate.py").is_file() else None
ROOT = CHECKOUT or Path.cwd()
STATE_FILE = STATE_DIR / "web-state.json"


def project_config() -> dict:
    local_config = ROOT / "codex_usage.local.json"
    path = local_config if local_config.is_file() else ROOT / "codex_usage.json"
    try:
        raw = json.loads(path.read_text())
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def local_timezone() -> str:
    configured = project_config().get("timezone")
    if configured:
        return configured
    try:
        link = os.readlink("/etc/localtime")
        if "zoneinfo/" in link:
            return link.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    return "UTC"


ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


class Job:
    def __init__(self, kind: str, title: str, command: str | None = None, profile: str | None = None):
        self.id = uuid.uuid4().hex[:12]
        self.kind, self.title, self.command, self.profile = kind, title, command, profile
        self.status = "running"
        self.log: list[str] = []
        self.started = time.time()
        self.finished: float | None = None
        self.result: dict | None = None
        self.error: str | None = None
        self.lock = threading.Lock()

    def write(self, line: str) -> None:
        with self.lock:
            self.log.append(ANSI.sub("", line.rstrip("\n")))
            if len(self.log) > 4000:
                del self.log[:1000]

    def public(self, with_log: bool = True) -> dict:
        with self.lock:
            data = {"id": self.id, "kind": self.kind, "title": self.title, "command": self.command,
                    "profile": self.profile, "status": self.status, "started": self.started,
                    "finished": self.finished, "result": self.result, "error": self.error,
                    "last": self.log[-1] if self.log else ""}
            if with_log:
                data["log"] = list(self.log)
            return data


class App:
    def __init__(self):
        self.lock = threading.RLock()
        self.histories: dict[str, dict] = {}
        self.datasets: dict[tuple, bytes] = {}
        self.jobs: dict[str, Job] = {}
        self.state = self.read_state()

    # ---------- persistent UI state ----------
    def read_state(self) -> dict:
        try:
            raw = json.loads(STATE_FILE.read_text())
            if isinstance(raw, dict):
                raw.setdefault("custom_profiles", [])
                raw.setdefault("labels", {})
                return raw
        except (OSError, ValueError):
            pass
        return {"custom_profiles": [], "labels": {}}

    def write_state(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2))
        tmp.replace(STATE_FILE)

    # ---------- profiles ----------
    @staticmethod
    def is_profile(path: Path) -> bool:
        # Codex keeps sessions/YYYY/MM/DD/rollout-*.jsonl; other tools (e.g. ~/.claude) also have sessions/.
        if (path / "archived_sessions").is_dir() or (path / "auth.json").exists() or (path / "config.toml").exists():
            return (path / "sessions").is_dir() or (path / "archived_sessions").is_dir()
        sessions = path / "sessions"
        try:
            return sessions.is_dir() and any(e.name.isdigit() and len(e.name) == 4 for e in sessions.iterdir())
        except OSError:
            return False

    def profile_paths(self) -> list[Path]:
        found = []
        home = Path.home()
        try:
            for entry in sorted(home.iterdir()):
                if entry.name.startswith(".codex") and entry.is_dir() and self.is_profile(entry):
                    found.append(entry.resolve())
        except OSError:
            pass
        configured = project_config().get("codex_home")
        if configured:
            path = Path(configured).expanduser().resolve()
            if path.is_dir():
                found.append(path)
        for raw in self.state["custom_profiles"]:
            path = Path(raw).expanduser().resolve()
            found.append(path)
        unique = []
        for path in found:
            if path not in unique:
                unique.append(path)
        return unique

    def resolve_profile(self, raw: str | None) -> Path:
        if not raw:
            raise ValueError("No profile specified")
        path = Path(raw).expanduser().resolve()
        if path not in self.profile_paths():
            raise ValueError("Profile is not listed. Add its directory on the Profiles page.")
        if not path.is_dir():
            raise ValueError(f"Directory unavailable: {path}")
        return path

    def profile_info(self, path: Path) -> dict:
        key = str(path)
        info = {"path": key, "name": path.name, "label": self.state["labels"].get(key),
                "custom": key in {str(Path(p).expanduser().resolve()) for p in self.state["custom_profiles"]},
                "exists": path.is_dir(), "valid": path.is_dir() and self.is_profile(path)}
        if info["valid"]:
            files = session_files(path)
            size, newest = 0, 0.0
            for file in files:
                try:
                    stat = file.stat()
                except OSError:
                    continue
                size += stat.st_size
                newest = max(newest, stat.st_mtime)
            info.update({"files": len(files), "size": size, "modified": newest or None})
            config = path / "config.toml"
            if config.is_file():
                try:
                    for line in config.read_text(errors="replace").splitlines():
                        if line.strip().startswith("model") and "=" in line and line.split("=", 1)[0].strip() == "model":
                            info["default_model"] = line.split("=", 1)[1].strip().strip('"\'')
                            break
                except OSError:
                    pass
        loaded = self.histories.get(key)
        if loaded:
            history: History = loaded["history"]
            info.update({"scanned_at": loaded["scanned_at"], "events": len(history.events),
                         "sessions": len(history.sessions), "quota_now": quota_now(history),
                         "plans": sorted({s["plan"] for s in history.snapshots if s["plan"]}),
                         "first_event": history.events[0]["ts"] if history.events else None,
                         "last_event": history.events[-1]["ts"] if history.events else None,
                         "stale": bool(info.get("modified") and info["modified"] > loaded["scanned_at"] + 1)})
        running = [job for job in self.jobs.values() if job.kind == "scan" and job.profile == key and job.status == "running"]
        if running:
            info["scan_job"] = running[0].id
        return info

    # ---------- scanning ----------
    def cache_for(self, path: Path) -> FileCache:
        return FileCache(cache_location(path))

    def start_scan(self, path: Path, force: bool = False) -> Job:
        with self.lock:
            for job in self.jobs.values():
                if job.kind == "scan" and job.profile == str(path) and job.status == "running":
                    return job
            job = Job("scan", f"Scan {path.name}" + (" (full)" if force else ""), profile=str(path))
            self.jobs[job.id] = job
        threading.Thread(target=self.run_scan, args=(job, path, force), daemon=True).start()
        return job

    def run_scan(self, job: Job, path: Path, force: bool) -> None:
        try:
            started = time.time()
            cache = self.cache_for(path)
            if force:
                cache.entries.clear()
            job.write(f"Directory: {path}")
            job.write(f"Cached files: {len(cache.entries)}")
            history = load_history(path, skip_unreadable=True, progress=job.write, cache=cache,
                                   workers=default_workers())
            cache.save()
            with self.lock:
                self.histories[str(path)] = {"history": history, "scanned_at": time.time(),
                                             "version": uuid.uuid4().hex}
                self.datasets = {k: v for k, v in self.datasets.items() if k[0] != str(path)}
            job.write(f"Usage events: {len(history.events)}; sessions: {len(history.sessions)}; "
                      f"quota snapshots: {len(history.snapshots)}")
            if history.skipped:
                job.write(f"Warning: unreadable files: {len(history.skipped)}")
            job.write(f"Completed in {time.time() - started:.1f} s")
            job.result = {"events": len(history.events), "skipped": len(history.skipped)}
            job.status = "done"
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            job.write(traceback.format_exc())
            job.error = str(exc)
            job.status = "error"
        finally:
            job.finished = time.time()

    def dataset(self, path: Path, params: dict) -> bytes:
        loaded = self.histories.get(str(path))
        if not loaded:
            raise LookupError("not_scanned")
        tolerance = int(params.get("tolerance", 180))
        start_used_max = float(params.get("start_used_max", 2))
        dominance = float(params.get("dominance", .95))
        exclude = tuple(sorted(x for x in params.get("exclude", "").split(",") if x))
        if not 0 < dominance <= 1 or tolerance < 0 or not 0 <= start_used_max < 100:
            raise ValueError("Invalid analysis settings")
        key = (str(path), loaded["version"], tolerance, start_used_max, dominance, exclude)
        with self.lock:
            cached = self.datasets.get(key)
        if cached is not None:
            return cached
        profile = {"path": str(path), "name": path.name, "label": self.state["labels"].get(str(path)),
                   "scanned_at": loaded["scanned_at"]}
        data = build_dataset(loaded["history"], profile, tolerance_seconds=tolerance, start_used_max=start_used_max,
                             dominance=dominance, excluded_models=set(exclude))
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        with self.lock:
            self.datasets = {k: v for k, v in self.datasets.items() if k[:2] == key[:2]} | {key: body}
        return body

    # ---------- commands ----------
    def report_command(self, form: dict) -> tuple[list[str], str]:
        """Build CLI arguments from a structured form; nothing is passed through a shell."""
        args = ["--codex-home", str(self.resolve_profile(form.get("profile")))]
        if form.get("start"):
            args += ["--start", str(form["start"])]
        if form.get("end"):
            args += ["--end", str(form["end"])]
        if not form.get("start") and form.get("days"):
            args += ["--days", str(int(form["days"]))]
        if form.get("timezone"):
            from zoneinfo import ZoneInfo
            ZoneInfo(str(form["timezone"]))
            args += ["--timezone", str(form["timezone"])]
        for field, flag in [("period", "--period"), ("quota_window", "--quota-window")]:
            if form.get(field):
                duration_seconds(str(form[field]))
                args += [flag, str(form[field])]
        if form.get("mode"):
            if form["mode"] not in {"capacity", "usage"}:
                raise ValueError("mode: capacity or usage")
            args += ["--mode", form["mode"]]
        if form.get("metric"):
            metric = ALIASES.get(str(form["metric"]), str(form["metric"]))
            if not metric.replace("_", "").isalnum():
                raise ValueError("Invalid metric")
            args += ["--metric", metric]
        if form.get("min_used") not in (None, ""):
            args += ["--min-used", str(float(form["min_used"]))]
        if form.get("include_internal"):
            args.append("--include-internal")
        for model in form.get("exclude_model") or []:
            args += ["--exclude-model", str(model)]
        if form.get("skip_unreadable", True):
            args.append("--skip-unreadable")
        if form.get("output"):
            name = Path(str(form["output"])).name
            if not name.endswith(".html"):
                name += ".html"
            args += ["--output", str(ROOT / "reports" / name)]
        display = (["python3", "generate.py"] if CHECKOUT else ["codex-usage"]) + args
        return [sys.executable, "-m", "codex_usage"] + args, shlex.join(display)

    def start_command(self, kind: str, form: dict) -> Job:
        if kind == "report":
            argv, display = self.report_command(form)
            title = "Generate HTML report"
        elif kind == "tests":
            if not CHECKOUT:
                raise ValueError("Tests are available only in a source checkout")
            argv = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
            display = "python3 -m unittest discover -s tests -v"
            title = "Automated tests"
        else:
            raise ValueError("Unknown command")
        job = Job(kind, title, command=display, profile=form.get("profile"))
        with self.lock:
            self.jobs[job.id] = job
        threading.Thread(target=self.run_process, args=(job, argv), daemon=True).start()
        return job

    def run_process(self, job: Job, argv: list[str]) -> None:
        env = dict(os.environ, PYTHONPATH=str(PACKAGE.parent) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                   PYTHONUNBUFFERED="1", NO_COLOR="1", PYTHON_COLORS="0")
        job.write("$ " + (job.command or shlex.join(argv)))
        try:
            proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            outputs = []
            for line in proc.stdout:
                job.write(line)
                if line.startswith("HTML: "):
                    outputs.append(line[6:].strip())
            code = proc.wait()
            job.result = {"code": code, "html": [self.report_link(p) for p in outputs if self.report_link(p)]}
            job.status = "done" if code == 0 else "error"
            if code:
                job.error = f"Exit code {code}"
        except OSError as exc:
            job.error, job.status = str(exc), "error"
        finally:
            job.finished = time.time()

    @staticmethod
    def report_link(raw: str) -> str | None:
        try:
            rel = Path(raw).resolve().relative_to((ROOT / "reports").resolve())
        except ValueError:
            return None
        return "/reports/" + rel.as_posix()

    def reports(self) -> list[dict]:
        base = ROOT / "reports"
        rows = []
        if base.is_dir():
            for path in base.rglob("*.html"):
                stat = path.stat()
                rel = path.relative_to(base).as_posix()
                rows.append({"name": rel, "url": "/reports/" + rel, "size": stat.st_size, "modified": stat.st_mtime,
                             "data": (path.with_suffix("") / "report-data.json").is_file()})
        return sorted(rows, key=lambda r: -r["modified"])


APP = App()


class Handler(BaseHTTPRequestHandler):
    server_version = "codex-usage"
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - BaseHTTPRequestHandler API
        if os.environ.get("CODEX_USAGE_DEBUG"):
            super().log_message(format, *args)

    # ---------- helpers ----------
    def allowed_host(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        return host in allowed

    def allowed_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.port == self.server.server_address[1]

    def send_body(self, body: bytes, content_type: str, status: int = 200, cache: bool = False) -> None:
        if len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, compresslevel=5)
            encoded = True
        else:
            encoded = False
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=60" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, data, status: int = 200) -> None:
        self.send_body(json.dumps(data, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status)

    def error(self, status: int, message: str, **extra) -> None:
        self.send_json({"error": message, **extra}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ValueError("Request too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    def serve_file(self, base: Path, rel: str) -> None:
        target = (base / unquote(rel)).resolve()
        try:
            target.relative_to(base.resolve())
        except ValueError:
            return self.error(404, "Not found")
        if not target.is_file():
            return self.error(404, "Not found")
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if kind.startswith("text/") or kind in {"application/javascript", "application/json"}:
            kind += "; charset=utf-8"
        self.send_body(target.read_bytes(), kind)

    # ---------- routing ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.allowed_host():
            return self.error(403, "Invalid Host")
        url = urlparse(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if url.path in {"/", "/index.html"}:
                return self.serve_file(WEB, "index.html")
            if url.path.startswith("/static/"):
                return self.serve_file(WEB, url.path[len("/static/"):])
            if url.path.startswith("/reports/"):
                return self.serve_file(ROOT / "reports", url.path[len("/reports/"):])
            if url.path == "/api/meta":
                return self.send_json({"timezone": local_timezone(), "home": str(Path.home()), "root": str(ROOT),
                                       "checkout": bool(CHECKOUT), "metrics": METRICS, "config": project_config(),
                                       "python": sys.version.split()[0], "last_profile": APP.state.get("last_profile"),
                                       "default_profile": str(Path(project_config()["codex_home"]).expanduser().resolve())
                                       if project_config().get("codex_home") else None})
            if url.path == "/api/profiles":
                return self.send_json({"profiles": [APP.profile_info(p) for p in APP.profile_paths()]})
            if url.path == "/api/browse":
                return self.browse(query.get("path"))
            if url.path == "/api/dataset":
                path = APP.resolve_profile(query.get("profile"))
                try:
                    body = APP.dataset(path, query)
                except LookupError:
                    return self.error(409, "Profile has not been scanned", needs_scan=True)
                APP.state["last_profile"] = str(path)
                return self.send_body(body, "application/json; charset=utf-8")
            if url.path == "/api/compare":
                return self.compare(query)
            if url.path == "/api/jobs":
                jobs = sorted(APP.jobs.values(), key=lambda j: -j.started)[:50]
                return self.send_json({"jobs": [j.public(with_log=False) for j in jobs]})
            if url.path.startswith("/api/jobs/"):
                job = APP.jobs.get(url.path.rsplit("/", 1)[1])
                return self.send_json(job.public()) if job else self.error(404, "Job not found")
            if url.path == "/api/reports":
                return self.send_json({"reports": APP.reports()})
            return self.error(404, "Not found")
        except ValueError as exc:
            return self.error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.error(500, f"Internal error: {exc}")

    def do_POST(self):
        if not self.allowed_host() or not self.allowed_origin():
            return self.error(403, "Cross-origin request rejected")
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.error(415, "Content-Type must be application/json")
        url = urlparse(self.path)
        try:
            body = self.read_json()
            if url.path == "/api/scan":
                path = APP.resolve_profile(body.get("profile"))
                return self.send_json(APP.start_scan(path, force=bool(body.get("force"))).public())
            if url.path == "/api/profiles":
                raw = str(body.get("path") or "").strip()
                if not raw:
                    raise ValueError("Specify a directory")
                path = Path(raw).expanduser().resolve()
                if not path.is_dir():
                    raise ValueError(f"Directory not found: {path}")
                if not APP.is_profile(path):
                    raise ValueError("Directory has neither sessions/ nor archived_sessions/; it is not a Codex profile")
                with APP.lock:
                    if str(path) not in APP.state["custom_profiles"]:
                        APP.state["custom_profiles"].append(str(path))
                    if body.get("label"):
                        APP.state["labels"][str(path)] = str(body["label"])[:80]
                    APP.write_state()
                return self.send_json(APP.profile_info(path))
            if url.path == "/api/profiles/label":
                path = APP.resolve_profile(body.get("path"))
                with APP.lock:
                    label = str(body.get("label") or "").strip()[:80]
                    if label:
                        APP.state["labels"][str(path)] = label
                    else:
                        APP.state["labels"].pop(str(path), None)
                    APP.write_state()
                return self.send_json(APP.profile_info(path))
            if url.path == "/api/profiles/remove":
                raw = str(Path(str(body.get("path") or "")).expanduser().resolve())
                with APP.lock:
                    APP.state["custom_profiles"] = [p for p in APP.state["custom_profiles"]
                                                    if str(Path(p).expanduser().resolve()) != raw]
                    APP.write_state()
                return self.send_json({"ok": True})
            if url.path == "/api/run":
                job = APP.start_command(str(body.get("command")), body.get("args") or {})
                return self.send_json(job.public())
            if url.path == "/api/preview-command":
                if body.get("command") != "report":
                    raise ValueError("Unknown command")
                return self.send_json({"command": APP.report_command(body.get("args") or {})[1]})
            return self.error(404, "Not found")
        except (ValueError, TypeError, KeyError) as exc:
            return self.error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.error(500, f"Internal error: {exc}")

    def browse(self, raw: str | None) -> None:
        path = Path(raw or str(Path.home())).expanduser().resolve()
        if not path.is_dir():
            return self.error(400, f"Directory not found: {path}")
        entries = []
        try:
            for entry in path.iterdir():
                try:
                    if entry.is_dir():
                        entries.append({"name": entry.name, "path": str(entry), "hidden": entry.name.startswith("."),
                                        "profile": App.is_profile(entry)})
                except OSError:
                    continue
        except PermissionError:
            return self.error(403, f"Access denied to {path}")
        entries.sort(key=lambda e: (not e["profile"], e["hidden"], e["name"].lower()))
        self.send_json({"path": str(path), "parent": str(path.parent) if path.parent != path else None,
                        "profile": App.is_profile(path), "entries": entries[:1000],
                        "truncated": len(entries) > 1000})

    def compare(self, query: dict) -> None:
        tz = query.get("tz") or local_timezone()
        metric = ALIASES.get(query.get("metric", "total_tokens"), query.get("metric", "total_tokens"))
        internal = query.get("internal") == "1"
        rows = []
        for key, loaded in list(APP.histories.items()):
            history = loaded["history"]
            rows.append({"path": key, "name": Path(key).name, "label": APP.state["labels"].get(key),
                         "daily": daily_totals(history, tz, metric, internal), "quota_now": quota_now(history),
                         "plans": sorted({s["plan"] for s in history.snapshots if s["plan"]})})
        self.send_json({"profiles": rows, "timezone": tz, "metric": metric})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local Codex usage dashboard")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CODEX_USAGE_PORT", 8765)))
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; defaults to this computer only")
    parser.add_argument("--open", action="store_true", help="Open the dashboard in a browser")
    parser.add_argument("--scan", action="append", default=[], help="Scan a profile at startup (may be repeated)")
    args = parser.parse_args(argv)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print("Warning: the server is reachable from other computers. Usage history will be exposed on the network.",
              file=sys.stderr)
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f"Unable to bind port {args.port}: {exc}. Choose another: --port 8766", file=sys.stderr)
        return 2
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"codex_usage: {url}  (Ctrl+C to stop)")
    for raw in args.scan:
        path = Path(raw).expanduser().resolve()
        if path not in APP.profile_paths():
            APP.state["custom_profiles"].append(str(path))
        APP.start_scan(path)
    if args.open:
        threading.Timer(.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
