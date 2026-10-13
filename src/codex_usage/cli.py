from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import webbrowser
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .analysis import prepare_report
from .loader import FileCache, cache_location, default_workers, load_history
from .report import export_tables, write_report
from .settings import ALIASES, boundary, duration_seconds

DEFAULTS = {"codex_home": "~/.codex", "timezone": "UTC", "period": "3d",
            "quota_window": "5h", "mode": "capacity", "metric": "total_tokens", "min_used": 98,
            "start_used_max": 2, "dominance": .95, "limit_id": "auto", "include_internal": False,
            "reset_tolerance_seconds": 180, "exclude_model": []}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Local Codex HTML report: observed quota capacity or usage over time")
    p.add_argument("--config", type=Path, help="JSON file with default settings")
    p.add_argument("--codex-home", "--profile", dest="codex_home", help="Codex profile, e.g. ~/.codex-work")
    p.add_argument("--start", help="Start: YYYY-MM-DD or ISO timestamp")
    p.add_argument("--end", help="Inclusive end date; an ISO timestamp is an exclusive boundary")
    p.add_argument("--days", type=int, help="Last N calendar days (default: 30)")
    p.add_argument("--timezone", help="IANA timezone, e.g. America/New_York or UTC")
    p.add_argument("--period", "--window", dest="period", help="Comparison period: 2d, 3d, 7d, 12h, 30m")
    p.add_argument("--quota-window", help="Quota duration: 5h or 7d; uses only recorded counters")
    p.add_argument("--mode", choices=["capacity", "usage"], help="capacity: average over exhausted windows; usage: total consumption")
    p.add_argument("--metric", help="total_tokens, input, cached, uncached, output, reasoning, responses or a new numeric usage field")
    p.add_argument("--min-used", type=float, help="Minimum usage for capacity: 98 by default, 100 for a strict sample")
    p.add_argument("--start-used-max", type=float, help="Maximum initial window usage: 2%% by default")
    p.add_argument("--dominance", type=float, help="Dominant-model token share for window classification: 0.95")
    p.add_argument("--limit-id", help="Counter: auto, codex or another discovered identifier")
    p.add_argument("--include-internal", action=argparse.BooleanOptionalAction, default=None,
                   help="Include internal reviewer usage; its quota impact is unknown")
    p.add_argument("--exclude-model", action="append", help="Exclude a model; may be repeated")
    p.add_argument("--reset-tolerance-seconds", type=int, help="Reset-time drift tolerance, default: 180 seconds")
    p.add_argument("--skip-unreadable", action="store_true", help="Explicitly allow skipping corrupt or unreadable files")
    p.add_argument("--no-cache", action="store_true", help="Disable the parsed-file cache (~/.cache/codex_usage)")
    p.add_argument("--output", type=Path, help="HTML output path; defaults to reports/ with dates in the filename")
    p.add_argument("--export-dir", type=Path, help="CSV and JSON directory; defaults to a sibling folder named after the HTML")
    p.add_argument("--open", action="store_true", help="Open the generated HTML in a browser")
    p.add_argument("--quiet", action="store_true", help="Hide progress messages")
    return p


def main(argv: list[str] | None = None, *, project_root: Path | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["serve"]:
        from .server import main as serve
        return serve(argv[1:])
    p = parser()
    args = p.parse_args(argv)
    try:
        options = dict(DEFAULTS)
        root = project_root or Path.cwd()
        local_config = root / "codex_usage.local.json"
        config = args.config or (local_config if local_config.is_file() else root / "codex_usage.json")
        if config.is_file():
            raw = json.loads(config.read_text())
            if not isinstance(raw, dict):
                raise ValueError("Settings must be a JSON object")
            unknown = set(raw) - (set(DEFAULTS) | {"start", "end", "days"})
            if unknown:
                raise ValueError("Unknown settings: " + ", ".join(sorted(unknown)))
            options.update(raw)
        elif args.config:
            raise ValueError(f"Settings file not found: {config}")
        for key in DEFAULTS:
            value = getattr(args, key, None)
            if value is not None:
                options[key] = value
        if options["mode"] not in {"capacity", "usage"}:
            raise ValueError("mode must be capacity or usage")
        tz = ZoneInfo(options["timezone"])
        today = dt.datetime.now(tz).date()
        end_arg = args.end or options.get("end") or today.isoformat()
        end_ts = boundary(end_arg, tz, end=True)
        end_day = dt.datetime.fromtimestamp(end_ts - .001, tz).date()
        days = args.days if args.days is not None else options.get("days", 30)
        if days <= 0:
            raise ValueError("--days must be positive")
        if args.start and args.days:
            raise ValueError("Choose --start or --days")
        start_arg = args.start or (None if args.days else options.get("start")) or (end_day - dt.timedelta(days=days - 1)).isoformat()
        start_ts = boundary(start_arg, tz)
        if start_ts >= end_ts:
            raise ValueError("Start must be before end")
        period_seconds = duration_seconds(options["period"])
        quota_seconds = duration_seconds(options["quota_window"])
        if quota_seconds % 60:
            raise ValueError("Quota duration must be a whole number of minutes")
        if not 0 < options["min_used"] <= 100 or not 0 <= options["start_used_max"] < options["min_used"]:
            raise ValueError("Required: 0 <= start_used_max < min_used <= 100")
        if not 0 < options["dominance"] <= 1 or options["reset_tolerance_seconds"] < 0:
            raise ValueError("dominance: (0,1]; reset_tolerance_seconds: >= 0")
        home = Path(options["codex_home"]).expanduser().resolve()
        if not home.is_dir():
            raise ValueError(f"Profile not found: {home}")
        options.update({"start_ts": start_ts, "end_ts": end_ts, "start_arg": start_arg, "end_arg": end_arg,
                        "period_seconds": period_seconds, "quota_minutes": quota_seconds // 60,
                        "profile_name": home.name, "codex_home": str(home),
                        "metric": ALIASES.get(options["metric"], options["metric"])})
        options["exclude_model"] = list(options["exclude_model"] or [])
        progress = None if args.quiet else lambda message: print(message, file=sys.stderr)
        cache = None if args.no_cache else FileCache(cache_location(home))
        history = load_history(home, skip_unreadable=args.skip_unreadable, progress=progress,
                               cache=cache, workers=default_workers())
        if cache:
            cache.save()
        if not history.events:
            raise ValueError("No token usage found in history")
        data = prepare_report(history, options)
        if not data["events"]:
            raise ValueError("No usage events in the selected date range")
        first_day = dt.datetime.fromtimestamp(start_ts, tz).strftime("%Y-%m-%d")
        last_day = dt.datetime.fromtimestamp(end_ts - .001, tz).strftime("%Y-%m-%d")
        profile_slug = re.sub(r"[^a-zA-Z0-9_.-]+", "_", home.name.lstrip('.')) or "codex"
        metric_slug = re.sub(r"[^a-zA-Z0-9_.-]+", "_", options["metric"])
        filename = (f"{profile_slug}_{first_day}_{last_day}_{options['mode']}_{metric_slug}"
                    f"_p{options['period']}_q{options['quota_window']}_ge{options['min_used']:g}.html")
        output = (args.output or root / "reports" / filename).expanduser().resolve()
        write_report(data, output)
        export_dir = (args.export_dir or output.with_suffix("")).expanduser().resolve()
        export_tables(data, export_dir)
        print(f"HTML: {output}")
        print(f"CSV / JSON: {export_dir}")
        print(f"Events: {len(data['events'])}; models: {len(data['models'])}; quota windows: {len(data['windows'])}")
        if not data["period_rows"]:
            print("No eligible windows for these settings; use the HTML to change duration, threshold or switch to usage mode.", file=sys.stderr)
        if args.open:
            webbrowser.open(output.as_uri())
        return 0
    except (OSError, ValueError, RuntimeError, TypeError, ZoneInfoNotFoundError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
