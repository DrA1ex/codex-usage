from __future__ import annotations

import bisect
import datetime as dt
from collections import Counter, defaultdict
from copy import deepcopy
from zoneinfo import ZoneInfo

from .loader import History
from .settings import METRICS, period_index, period_bounds


def add_counts(target: dict, counts: dict) -> None:
    for name, value in counts.items():
        target[name] = target.get(name, 0) + value


def build_windows(history: History, *, tolerance_seconds: int = 180,
                  start_used_max: float = 2, dominance: float = .95,
                  excluded_models: set[str] | None = None) -> tuple[list[dict], list[dict]]:
    """Split observed counters into epochs before assigning any usage to them."""
    excluded_models = excluded_models or set()
    states = {}
    groups = []
    resets = []
    actions = sorted(history.reset_actions)

    def begin(snap, old=None, reason="initial"):
        group = {"limit_id": snap["limit_id"], "minutes": snap["minutes"],
                 "reset": snap["reset"], "start": snap["ts"], "last": snap["ts"],
                 "first_used": snap["used"], "max_used": snap["used"],
                 "first_full": snap["ts"] if snap["used"] >= 100 else None,
                 "reset_reason": reason, "snapshots": 1,
                 "source": {"file": snap["file"], "line": snap["line"]}}
        groups.append(group)
        if old:
            resets.append({"ts": snap["ts"], "limit_id": snap["limit_id"], "minutes": snap["minutes"],
                           "reason": reason, "early": snap["ts"] < old["reset"] - min(tolerance_seconds, snap["minutes"] * 6),
                           "used_before": old["max_used"], "used_after": snap["used"],
                           "previous_deadline": old["reset"], "new_deadline": snap["reset"],
                           "app_record": any(abs(t - snap["ts"]) <= 180 for t in actions)})
        return group

    def append(group, snap):
        group["last"] = max(group["last"], snap["ts"])
        group["max_used"] = max(group["max_used"], snap["used"])
        group["snapshots"] += 1
        if group["first_full"] is None and snap["used"] >= 100:
            group["first_full"] = snap["ts"]

    for snap in history.snapshots:
        if snap["internal"] or snap["model"] == "unknown" or snap["model"] in excluded_models:
            continue
        seconds = snap["minutes"] * 60
        # Reject imported/replayed counters whose deadline is impossible for this timestamp.
        if snap["reset"] - snap["ts"] > seconds + 600 or snap["reset"] < snap["ts"] - 600:
            history.diagnostics["stale_or_replayed_rate_snapshot"] += 1
            continue
        key = (snap["limit_id"], snap["minutes"])
        tolerance = min(tolerance_seconds, seconds / 10)
        if key not in states:
            states[key] = {"current": begin(snap), "closed": [], "pending": []}
            continue
        state = states[key]
        current = state["current"]
        changed = abs(snap["reset"] - current["reset"]) > tolerance
        if changed:
            if any(abs(snap["reset"] - old) <= tolerance for old in state["closed"]):
                history.diagnostics["late_closed_window_snapshot"] += 1
                continue
            state["closed"].append(current["reset"])
            state["current"] = begin(snap, current, "deadline_changed")
            state["pending"] = []
            continue
        # Refill without a materially shifted deadline. Confirm the drop in a second
        # later observation; a single stale parallel response must not manufacture a reset.
        if state["pending"]:
            first = state["pending"][0]
            if snap["used"] <= current["max_used"] - 15 and snap["ts"] > first["ts"]:
                state["closed"].append(current["reset"])
                fresh = begin(first, current, "counter_drop_confirmed")
                for pending in state["pending"][1:]:
                    append(fresh, pending)
                append(fresh, snap)
                state["current"] = fresh
                state["pending"] = []
                history.diagnostics["confirmed_counter_refill"] += 1
                continue
            if snap["ts"] == first["ts"] and snap["used"] <= current["max_used"] - 15:
                state["pending"].append(snap)
                continue
            history.diagnostics["unconfirmed_counter_drop"] += 1
            state["pending"] = []
        drop = current["max_used"] - snap["used"]
        if drop >= 20 and snap["used"] <= 5 and snap["ts"] > current["last"] + 1:
            if any(current["last"] <= t <= snap["ts"] for t in actions):
                state["current"] = begin(snap, current, "app_record_and_counter_drop")
            else:
                state["pending"] = [snap]
            continue
        append(current, snap)
    for state in states.values():
        if state["pending"]:
            history.diagnostics["unconfirmed_counter_drop"] += 1

    event_times = [event["ts"] for event in history.events]
    windows = []
    for index, group in enumerate(groups):
        end = group["first_full"] if group["first_full"] is not None else group["last"]
        span = end - group["start"]
        records = history.events[bisect.bisect_left(event_times, group["start"]):bisect.bisect_right(event_times, end)]
        metrics, internal_metrics, models, internal_models = {}, {}, {}, {}
        for event in records:
            if event["model"] in excluded_models:
                continue
            if event["internal"]:
                add_counts(internal_metrics, event["counts"])
                add_counts(internal_models.setdefault(event["model"], {}), event["counts"])
            else:
                add_counts(metrics, event["counts"])
                add_counts(models.setdefault(event["model"], {}), event["counts"])
        total = metrics.get("total_tokens", 0)
        dominant = max(models, key=lambda model: models[model].get("total_tokens", 0)) if models else None
        share = models[dominant].get("total_tokens", 0) / total if total and dominant else 0
        exclusion = exclusion_code = None
        if group["first_used"] > start_used_max:
            exclusion, exclusion_code = "Window start was not observed near zero usage", "start_not_observed"
        elif span > group["minutes"] * 60 + 600:
            exclusion, exclusion_code = "Observations exceed the window duration; counters may be stale", "too_long"
        elif not total:
            exclusion, exclusion_code = "No working-model usage in the observed interval", "no_usage"
        voice_minutes = sum(max(0, min(end, row["end"]) - max(group["start"], row["start"])) / 60
                            for row in history.voice)
        windows.append({"id": index, "limit_id": group["limit_id"], "minutes": group["minutes"],
                        "start": group["start"], "end": end, "deadline": group["reset"],
                        "first_used": group["first_used"], "max_used": group["max_used"],
                        "full": group["first_full"] is not None, "exclusion": exclusion, "exclusion_code": exclusion_code,
                        "classification": dominant if share >= dominance else "__mixed__",
                        "dominant_model": dominant, "dominant_share": share,
                        "metrics": metrics, "internal_metrics": internal_metrics,
                        "models": models, "internal_models": internal_models,
                        "voice_minutes": voice_minutes, "source": group["source"]})
    return sorted(windows, key=lambda row: row["start"]), sorted(resets, key=lambda row: row["ts"])


def aggregate(events: list[dict], windows: list[dict], *, start: float, end: float,
              seconds: int, timezone: str, mode: str, metric: str, minutes: int,
              limit_id: str, min_used: float = 98, include_internal: bool = False) -> list[dict]:
    """Capacity = an arithmetic mean of whole windows, never percent-normalized."""
    tz = ZoneInfo(timezone)
    sums = defaultdict(float)
    counts = Counter()
    full = Counter()
    values = defaultdict(list)
    if mode == "capacity":
        for window in windows:
            if not start <= window["start"] < end or window["minutes"] != minutes or window["limit_id"] != limit_id:
                continue
            if window["exclusion"] or window["max_used"] < min_used:
                continue
            value = window["metrics"].get(metric, 0)
            if include_internal:
                value += window["internal_metrics"].get(metric, 0)
            key = (period_index(window["start"], start, seconds, tz), window["classification"])
            sums[key] += value
            counts[key] += 1
            full[key] += int(window["full"])
            values[key].append(value)
    else:
        for event in events:
            if not start <= event["ts"] < end or (event["internal"] and not include_internal):
                continue
            key = (period_index(event["ts"], start, seconds, tz), event["model"])
            sums[key] += event["counts"].get(metric, 0)
            counts[key] += 1
    rows = []
    for (index, model), total in sorted(sums.items()):
        a, b = period_bounds(index, start, seconds, tz)
        row = {"period": index, "start": a, "end": min(b, end), "model": model,
               "value": total / counts[(index, model)] if mode == "capacity" else total,
               "observations": counts[(index, model)]}
        if mode == "capacity":
            row.update({"fully_exhausted": full[(index, model)],
                        "nearly_exhausted": counts[(index, model)] - full[(index, model)],
                        "min": min(values[(index, model)]), "max": max(values[(index, model)])})
        rows.append(row)
    return rows


def prepare_report(history: History, options: dict) -> dict:
    windows, resets = build_windows(history, tolerance_seconds=options["reset_tolerance_seconds"],
                                    start_used_max=options["start_used_max"], dominance=options["dominance"],
                                    excluded_models=set(options["exclude_model"]))
    start, end = options["start_ts"], options["end_ts"]
    selected_events = [event for event in history.events if start <= event["ts"] < end
                       and event["model"] not in options["exclude_model"]]
    selected_windows = [window for window in windows if start <= window["start"] < end]
    selected_resets = [reset for reset in resets if start <= reset["ts"] < end]
    ids = Counter(window["limit_id"] for window in selected_windows if window["minutes"] == options["quota_minutes"])
    limit_id = options["limit_id"]
    if limit_id == "auto":
        limit_id = "codex" if "codex" in ids else (ids.most_common(1)[0][0] if ids else "codex")
    options = dict(options, limit_id=limit_id)
    metric_names = set(METRICS)
    for event in selected_events:
        metric_names.update(event["counts"])
    for window in selected_windows:
        metric_names.update(window["metrics"])
        metric_names.update(window["internal_metrics"])
    if options["metric"] not in metric_names:
        raise ValueError("Metric not found. Available: " + ", ".join(sorted(metric_names)))
    discovered = sorted({event["model"] for event in selected_events}
                        | {model for window in selected_windows for model in window["models"]}
                        | {model for window in selected_windows for model in window["internal_models"]})
    model_ids = {model: index for index, model in enumerate(discovered)}
    # Compact events keep arbitrary aggregation periods accurate in the HTML report.
    metric_keys = sorted(metric_names)
    events = [[event["ts"], model_ids[event["model"]], int(event["internal"]),
               [event["counts"].get(key, 0) for key in metric_keys]] for event in selected_events]
    relevant_plans = sorted({snap["plan"] for snap in history.snapshots if snap["plan"] and start <= snap["ts"] < end})
    result = {
        "schema_version": 1, "options": options,
        "generated_at": dt.datetime.now(dt.timezone.utc).timestamp(),
        "models": discovered, "metric_keys": metric_keys,
        "metric_labels": {key: METRICS.get(key, key) for key in metric_keys},
        "events": events, "windows": selected_windows, "resets": selected_resets,
        "voice": [row for row in history.voice if row["start"] < end and row["end"] > start],
        "plans": relevant_plans, "files_read": history.files,
        "diagnostics": dict(history.diagnostics), "diagnostic_examples": history.examples,
        "latest_event": max((event["ts"] for event in selected_events), default=None),
        "first_event": min((event["ts"] for event in selected_events), default=None),
        "available_limits": sorted({window["limit_id"] for window in selected_windows}),
        "available_quota_minutes": sorted({window["minutes"] for window in selected_windows}),
        "period_rows": aggregate(selected_events, selected_windows, start=start, end=end,
                                 seconds=options["period_seconds"], timezone=options["timezone"],
                                 mode=options["mode"], metric=options["metric"], minutes=options["quota_minutes"],
                                 limit_id=limit_id, min_used=options["min_used"],
                                 include_internal=options["include_internal"]),
    }
    return result
