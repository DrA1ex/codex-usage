from __future__ import annotations

import concurrent.futures
import contextlib
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import pickle
import shutil
import sqlite3
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class History:
    events: list[dict] = field(default_factory=list)
    snapshots: list[dict] = field(default_factory=list)
    reset_actions: list[float] = field(default_factory=list)
    voice: list[dict] = field(default_factory=list)
    diagnostics: Counter = field(default_factory=Counter)
    examples: list[dict] = field(default_factory=list)
    sessions: dict[str, dict] = field(default_factory=dict)
    thread_names: dict[str, str] = field(default_factory=dict)
    skipped: list[dict] = field(default_factory=list)
    files: int = 0
    cached_files: int = 0

    def note(self, kind: str, filename: str = "", line: int = 0) -> None:
        self.diagnostics[kind] += 1
        if len(self.examples) < 25:
            self.examples.append({"kind": kind, "file": filename, "line": line})


def timestamp(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.timestamp()


def numeric_usage(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, (int, float))
            and not isinstance(v, bool) and math.isfinite(v)}


def is_internal(model: str, source) -> bool:
    if model == "codex-auto-review":
        return True
    if isinstance(source, dict):
        subagent = source.get("subagent", {})
        return isinstance(subagent, dict) and subagent.get("other") in {"guardian", "auto_review"}
    return False


@contextlib.contextmanager
def open_lines(path: Path):
    if path.name.endswith(".gz"):
        with gzip.open(path, "rb") as stream:
            yield stream
        return
    if not path.name.endswith(".zst"):
        with path.open("rb") as stream:
            yield stream
        return
    try:
        from compression import zstd  # Python >= 3.14
    except ImportError:
        zstd = None
    if zstd is not None:
        with zstd.open(path, "rb") as stream:
            yield stream
        return
    try:
        import zstandard
    except ImportError:
        zstandard = None
    if zstandard is not None:
        import io
        with path.open("rb") as source:
            with zstandard.ZstdDecompressor().stream_reader(source) as reader:
                with io.BufferedReader(reader) as stream:
                    yield stream
        return
    executable = shutil.which("zstd")
    if not executable:
        raise RuntimeError("Reading .jsonl.zst requires Python 3.14+, the zstandard package or the zstd command")
    proc = subprocess.Popen([executable, "-dc", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        yield proc.stdout
        proc.stdout.close()
        error = proc.stderr.read().decode("utf-8", "replace")
        code = proc.wait()
        if code:
            raise RuntimeError(f"Unable to decompress {path.name}: {error[:300]}")
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait()
        proc.stderr.close()


def session_files(home: Path) -> list[Path]:
    found = []
    for root in [home / "sessions", home / "archived_sessions"]:
        if root.is_dir():
            found.extend(p for p in root.rglob("*.jsonl*") if p.is_file()
                         and (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.zst") or p.name.endswith(".jsonl.gz")))
    return sorted(set(found))


def source_kind(source) -> str:
    if isinstance(source, dict):
        subagent = source.get("subagent")
        if isinstance(subagent, dict):
            if subagent.get("other") in {"guardian", "auto_review"}:
                return "review"
            return "subagent"
        return "other"
    return str(source or "unknown")


def parse_file(path: Path) -> dict:
    """Read one session file. Pure function of the file contents, so its result can be cached."""
    model, source, effort, previous = "unknown", None, None, None
    events, snapshots, notes = [], [], []
    counters = Counter()
    meta = {"id": None, "cwd": None, "originator": None, "cli_version": None, "branch": None,
            "source": "unknown", "parent": None, "started": None}
    markers = [b'"token_count"', b'"turn_context"', b'"session_meta"']
    with open_lines(path) as stream:
        for lineno, line in enumerate(stream, 1):
            if not any(marker in line for marker in markers):
                continue
            try:
                record = json.loads(line)
                ts = timestamp(record["timestamp"])
            except (ValueError, TypeError, KeyError, AttributeError):
                notes.append(("invalid_record", lineno))
                continue
            payload = record.get("payload", {})
            if not isinstance(payload, dict):
                continue
            kind = record.get("type")
            if kind == "session_meta":
                source = payload.get("source")
                if meta["id"] is None:
                    git = payload.get("git") if isinstance(payload.get("git"), dict) else {}
                    spawn = source.get("subagent", {}).get("thread_spawn") if isinstance(source, dict) and isinstance(source.get("subagent"), dict) else None
                    meta.update({"id": str(payload.get("id") or payload.get("session_id") or "") or None,
                                 "cwd": payload.get("cwd") if isinstance(payload.get("cwd"), str) else None,
                                 "originator": str(payload.get("originator") or "") or None,
                                 "cli_version": str(payload.get("cli_version") or "") or None,
                                 "branch": str(git.get("branch") or "") or None,
                                 "source": source_kind(source), "started": ts,
                                 "parent": str(spawn.get("parent_thread_id")) if isinstance(spawn, dict) and spawn.get("parent_thread_id") else None})
                continue
            if kind == "turn_context":
                model = payload.get("model") or model
                effort = payload.get("effort") or effort
                if meta["cwd"] is None and isinstance(payload.get("cwd"), str):
                    meta["cwd"] = payload["cwd"]
                continue
            if kind != "event_msg" or payload.get("type") != "token_count":
                continue
            internal = is_internal(model, source)
            limits = payload.get("rate_limits")
            if isinstance(limits, dict):
                for slot in ["primary", "secondary"]:
                    window = limits.get(slot)
                    if not isinstance(window, dict):
                        continue
                    try:
                        minutes = int(window["window_minutes"])
                        used = float(window["used_percent"])
                        reset = float(window["resets_at"])
                        if minutes <= 0 or not 0 <= used <= 100 or not math.isfinite(reset):
                            raise ValueError()
                    except (KeyError, ValueError, TypeError, OverflowError):
                        notes.append(("invalid_rate_snapshot", lineno))
                        continue
                    snapshots.append({"ts": ts, "minutes": minutes, "used": used, "reset": reset,
                                      "limit_id": str(limits.get("limit_id") or "codex"),
                                      "plan": limits.get("plan_type"), "model": model,
                                      "internal": internal, "file": path.name, "line": lineno})
            info = payload.get("info")
            if not isinstance(info, dict):
                continue
            total = numeric_usage(info.get("total_token_usage"))
            last = numeric_usage(info.get("last_token_usage"))
            if not total:
                notes.append(("missing_total_usage", lineno))
                continue
            if total == previous:
                counters["unchanged_usage"] += 1
                continue
            if previous is None:
                counts = dict(last)
                if not last:
                    notes.append(("missing_initial_last_usage", lineno))
                    previous = total
                    continue
                if total.get("total_tokens") != last.get("total_tokens"):
                    notes.append(("inherited_counter_baseline", lineno))
            else:
                counts = {k: v - previous.get(k, 0) for k, v in total.items()}
                if any(counts.get(k, 0) < 0 for k in ["input_tokens", "output_tokens", "total_tokens"]):
                    notes.append(("token_counter_reset", lineno))
                    counts = dict(last)
                    if not counts:
                        previous = total
                        continue
            previous = total
            fingerprint = hashlib.sha256(json.dumps([ts, total, last], sort_keys=True).encode()).digest()
            context = info.get("model_context_window")
            events.append((fingerprint, {"ts": ts, "model": str(model), "internal": internal,
                                         "effort": str(effort) if effort else None,
                                         "context": last.get("input_tokens", 0) if isinstance(context, (int, float)) else None,
                                         "context_window": context if isinstance(context, (int, float)) else None,
                                         "counts": counts, "file": path.name, "line": lineno}))
    if meta["id"] is None:
        stem = path.name.split(".jsonl")[0]
        meta["id"] = stem[-36:] if len(stem) >= 36 else stem
    return {"events": events, "snapshots": snapshots, "notes": notes, "counters": dict(counters), "meta": meta}


STATE_DIR = Path(os.environ.get("CODEX_USAGE_STATE", "~/.cache/codex_usage")).expanduser()


def default_workers() -> int:
    return max(1, min(8, (os.cpu_count() or 2) - 1))


def cache_location(home: Path) -> Path:
    """Per-profile cache file shared by the CLI and the web server."""
    home = Path(home).resolve()
    digest = hashlib.sha1(str(home).encode()).hexdigest()[:16]
    return STATE_DIR / "scan-cache" / f"{home.name.lstrip('.') or 'codex'}-{digest}.pickle"


class FileCache:
    """Parsed session files keyed by path, size and mtime; active sessions are re-read only when they change."""

    VERSION = 3

    def __init__(self, location: Path | None = None):
        self.location = location
        self.entries: dict[str, tuple[int, int, dict]] = {}
        if location and location.is_file():
            try:
                with location.open("rb") as stream:
                    stored = pickle.load(stream)
                if stored.get("version") == self.VERSION:
                    self.entries = stored["entries"]
            except (OSError, EOFError, pickle.UnpicklingError, AttributeError, KeyError, TypeError):
                self.entries = {}

    def get(self, path: Path, stat) -> dict | None:
        entry = self.entries.get(str(path))
        if entry and entry[0] == stat.st_size and entry[1] == stat.st_mtime_ns:
            return entry[2]
        return None

    def put(self, path: Path, stat, parsed: dict) -> None:
        self.entries[str(path)] = (stat.st_size, stat.st_mtime_ns, parsed)

    def prune(self, keep: set[str]) -> None:
        for key in set(self.entries) - keep:
            del self.entries[key]

    def save(self) -> None:
        if not self.location:
            return
        self.location.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.location.with_suffix(".tmp")
        with temporary.open("wb") as stream:
            pickle.dump({"version": self.VERSION, "entries": self.entries}, stream, protocol=pickle.HIGHEST_PROTOCOL)
        temporary.replace(self.location)


def load_history(home: Path, *, skip_unreadable: bool = False,
                 progress: Callable[[str], None] | None = None,
                 cache: FileCache | None = None, workers: int = 1) -> History:
    history = History()
    files = session_files(home)
    if not files:
        raise ValueError(f"In {home} has no session files in sessions/ or archived_sessions/")
    seen_events = set()
    snapshots = {}
    reused = 0
    parsed_files: dict[Path, dict | Exception] = {}
    pending = []
    for path in files:
        try:
            stat = path.stat()
        except OSError as exc:
            parsed_files[path] = exc
            continue
        hit = cache.get(path, stat) if cache else None
        if hit is None:
            pending.append((path, stat))
        else:
            parsed_files[path] = hit
            reused += 1
    done = reused

    def finished(path, stat, result):
        nonlocal done
        parsed_files[path] = result
        if cache and not isinstance(result, Exception):
            cache.put(path, stat, result)
        done += 1
        if progress and (done == len(files) or done % 25 == 0):
            progress(f"Parsed {done}/{len(files)} files" + (f" (from cache {reused})" if reused else ""))

    if workers > 1 and len(pending) > 8:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(parse_file, path): (path, stat) for path, stat in pending}
            for future in concurrent.futures.as_completed(futures):
                path, stat = futures[future]
                try:
                    result = future.result()
                except (OSError, EOFError, RuntimeError, ValueError) as exc:
                    result = exc
                finished(path, stat, result)
    else:
        for path, stat in pending:
            try:
                result = parse_file(path)
            except (OSError, EOFError, RuntimeError, ValueError) as exc:
                result = exc
            finished(path, stat, result)
    if progress and not pending:
        progress(f"All {len(files)} files loaded from cache")
    for path in files:
        parsed = parsed_files[path]
        if isinstance(parsed, Exception):
            if not skip_unreadable:
                raise RuntimeError(f"File {path.name} could not be read: {parsed}. To explicitly skip it, use --skip-unreadable") from parsed
            history.note("skipped_file", path.name)
            history.skipped.append({"file": str(path), "error": str(parsed)[:300]})
            continue
        # Commit only completely read files; a truncated archive cannot create a partial history.
        for kind, line in parsed["notes"]:
            history.note(kind, path.name, line)
        history.diagnostics.update(parsed["counters"])
        meta = parsed["meta"]
        session = history.sessions.setdefault(meta["id"], dict(meta, file=str(path), files=0))
        session["files"] += 1
        for snap in parsed["snapshots"]:
            key = tuple(snap[k] for k in ["ts", "limit_id", "minutes", "used", "reset"])
            if key not in snapshots or (snapshots[key]["internal"] and not snap["internal"]):
                snapshots[key] = snap
        for fingerprint, original in parsed["events"]:
            if fingerprint in seen_events:
                history.diagnostics["duplicate_history_event"] += 1
                continue
            seen_events.add(fingerprint)
            event = dict(original, session=meta["id"])
            counts = event["counts"] = dict(original["counts"])
            if event["model"] == "unknown":
                history.note("unknown_model_event", path.name, event["line"])
                continue
            if not counts or any(v < 0 for v in counts.values()):
                history.note("invalid_usage_delta", path.name, event["line"])
                continue
            inp, out = counts.get("input_tokens", 0), counts.get("output_tokens", 0)
            total = counts.get("total_tokens", inp + out)
            if total != inp + out:
                history.note("inconsistent_total_tokens", path.name, event["line"])
                continue
            if total == 0:
                continue
            counts["total_tokens"] = total
            cached = counts.get("cached_input_tokens", 0)
            if cached > inp:
                history.note("cached_exceeds_input", path.name, event["line"])
                continue
            counts["uncached_input_tokens"] = inp - cached
            counts["responses"] = 1
            history.events.append(event)
        history.files += 1
    if cache:
        cache.prune({str(path) for path in files})
    history.events.sort(key=lambda r: r["ts"])
    history.snapshots = sorted(snapshots.values(), key=lambda r: r["ts"])
    history.cached_files = reused
    load_auxiliary(home, history)
    return history


def load_auxiliary(home: Path, history: History) -> None:
    index = home / "session_index.jsonl"
    if index.is_file():
        try:
            with index.open("rb") as stream:
                for line in stream:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(row, dict) and row.get("id") and isinstance(row.get("thread_name"), str):
                        history.thread_names[str(row["id"])] = row["thread_name"]
        except OSError:
            history.note("session_index_unavailable")
    state = home / ".codex-global-state.json"
    if state.exists():
        try:
            raw = json.loads(state.read_text())
            atom = raw.get("electron-persisted-atom-state", {})
            for row in atom.get("codex-rate-limit-reset-history", []):
                value = row.get("occurredAtMs")
                if isinstance(value, (int, float)):
                    history.reset_actions.append(value / 1000)
        except (OSError, ValueError, AttributeError):
            history.note("reset_history_unavailable")
    database = home / "thread_history_1.sqlite"
    if not database.exists():
        return
    try:
        with contextlib.closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=3)) as connection:
            tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "thread_realtime_items" not in tables:
                return
            sessions = {}
            for created, kind, raw in connection.execute(
                "SELECT created_at_ms,item_type,item_json FROM thread_realtime_items "
                "WHERE item_type IN ('realtime_session_started','realtime_session_closed') ORDER BY created_at_ms"
            ):
                payload = json.loads(raw)
                sid = payload.get("realtime_session_id")
                if sid:
                    sessions.setdefault(sid, {})[kind] = created / 1000
            for session in sessions.values():
                a, b = session.get("realtime_session_started"), session.get("realtime_session_closed")
                if a is not None and b is not None and b >= a:
                    history.voice.append({"start": a, "end": b, "minutes": (b - a) / 60})
    except (sqlite3.Error, OSError, ValueError, TypeError):
        history.note("voice_history_unavailable")
