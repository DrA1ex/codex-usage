"""Compact datasets for the web UI. All aggregation by date happens in the browser."""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

from .analysis import build_windows
from .loader import History
from .settings import METRICS


def stale(snap: dict) -> bool:
    seconds = snap["minutes"] * 60
    return snap["reset"] - snap["ts"] > seconds + 600 or snap["reset"] < snap["ts"] - 600


def quota_series(history: History, tolerance: int = 180) -> dict[str, list]:
    """Per counter: change points of used% with a monotone maximum inside each reset epoch.

    Parallel sessions report slightly outdated percentages; keeping the running maximum
    inside one deadline removes that jitter without hiding real resets.
    """
    grouped = defaultdict(list)
    for snap in history.snapshots:
        if not stale(snap):
            grouped[(snap["limit_id"], snap["minutes"])].append(snap)
    result = {}
    for (limit_id, minutes), snaps in grouped.items():
        tol = min(tolerance, minutes * 6)
        points, closed = [], []
        reset, peak = None, -1.0
        for index, snap in enumerate(snaps):
            if reset is None or abs(snap["reset"] - reset) > tol:
                if any(abs(snap["reset"] - old) <= tol for old in closed):
                    continue
                if reset is not None:
                    closed.append(reset)
                reset, peak = snap["reset"], snap["used"]
                points.append([snap["ts"], snap["used"], snap["reset"]])
                continue
            following = snaps[index + 1] if index + 1 < len(snaps) else None
            if (snap["used"] <= peak - 15 and following is not None and following["ts"] > snap["ts"]
                    and abs(following["reset"] - reset) <= tol and following["used"] <= peak - 15):
                # Confirmed refill without a new deadline (early reset).
                peak = snap["used"]
                points.append([snap["ts"], snap["used"], snap["reset"], 1])
                continue
            if snap["used"] > peak:
                peak = snap["used"]
                points.append([snap["ts"], snap["used"], snap["reset"]])
        result[f"{limit_id}|{minutes}"] = points
    return result


def quota_now(history: History) -> list[dict]:
    latest = {}
    for snap in history.snapshots:
        if stale(snap):
            continue
        key = (snap["limit_id"], snap["minutes"])
        current = latest.get(key)
        if current is None or snap["ts"] > current["ts"] or (snap["ts"] == current["ts"] and snap["used"] > current["used"]):
            latest[key] = snap
    return [{"limit_id": s["limit_id"], "minutes": s["minutes"], "used": s["used"], "reset": s["reset"],
             "ts": s["ts"], "plan": s["plan"]} for s in sorted(latest.values(), key=lambda s: (s["limit_id"], s["minutes"]))]


def build_dataset(history: History, profile: dict, *, tolerance_seconds: int = 180, start_used_max: float = 2,
                  dominance: float = .95, excluded_models: set[str] | None = None) -> dict:
    excluded_models = excluded_models or set()
    windows, resets = build_windows(history, tolerance_seconds=tolerance_seconds, start_used_max=start_used_max,
                                    dominance=dominance, excluded_models=excluded_models)
    events = [e for e in history.events if e["model"] not in excluded_models]
    totals = defaultdict(float)
    for event in events:
        totals[event["model"]] += event["counts"].get("total_tokens", 0)
    # Stable colour order: biggest model first, so colours follow the entity and not a filter.
    models = sorted(totals, key=lambda m: (-totals[m], m))
    model_ids = {m: i for i, m in enumerate(models)}
    metric_names = set(METRICS)
    for event in events:
        metric_names.update(event["counts"])
    metric_keys = [k for k in METRICS if k in metric_names] + sorted(metric_names - set(METRICS))
    used_sessions = sorted({e["session"] for e in events})
    session_ids = {s: i for i, s in enumerate(used_sessions)}
    efforts = sorted({e.get("effort") or "—" for e in events})
    effort_ids = {e: i for i, e in enumerate(efforts)}
    compact = [[round(e["ts"], 3), model_ids[e["model"]], int(e["internal"]), session_ids[e["session"]],
                effort_ids[e.get("effort") or "—"], [e["counts"].get(k, 0) for k in metric_keys],
                e.get("context") or 0, e.get("context_window") or 0] for e in events]
    sessions = []
    for sid in used_sessions:
        meta = history.sessions.get(sid, {})
        sessions.append({"id": sid, "title": history.thread_names.get(sid), "cwd": meta.get("cwd"),
                         "source": meta.get("source"), "originator": meta.get("originator"),
                         "cli_version": meta.get("cli_version"), "branch": meta.get("branch"),
                         "parent": meta.get("parent"), "started": meta.get("started"), "file": meta.get("file")})
    for window in windows:
        window.pop("source", None)
    plans = sorted({s["plan"] for s in history.snapshots if s["plan"]})
    return {
        "schema_version": 2,
        "profile": profile,
        "generated_at": dt.datetime.now(dt.timezone.utc).timestamp(),
        "models": models,
        "metric_keys": metric_keys,
        "metric_labels": {k: METRICS.get(k, k) for k in metric_keys},
        "efforts": efforts,
        "events": compact,
        "sessions": sessions,
        "windows": windows,
        "resets": resets,
        "quota_series": quota_series(history, tolerance_seconds),
        "quota_now": quota_now(history),
        "voice": history.voice,
        "plans": plans,
        "files_read": history.files,
        "files_cached": history.cached_files,
        "skipped": history.skipped,
        "diagnostics": dict(history.diagnostics),
        "diagnostic_examples": history.examples,
        "options": {"reset_tolerance_seconds": tolerance_seconds, "start_used_max": start_used_max,
                    "dominance": dominance, "exclude_model": sorted(excluded_models)},
    }


def daily_totals(history: History, timezone: str, metric: str = "total_tokens", include_internal: bool = False) -> dict:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(timezone)
    days = defaultdict(float)
    for event in history.events:
        if event["internal"] and not include_internal:
            continue
        day = dt.datetime.fromtimestamp(event["ts"], tz).date().isoformat()
        days[day] += event["counts"].get(metric, 0)
    return dict(sorted(days.items()))
