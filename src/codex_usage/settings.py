from __future__ import annotations

import datetime as dt
import re
from zoneinfo import ZoneInfo

METRICS = {
    "total_tokens": "Total tokens: input + output",
    "input_tokens": "Input tokens",
    "cached_input_tokens": "Cached input tokens",
    "uncached_input_tokens": "Uncached input tokens",
    "output_tokens": "Output tokens",
    "reasoning_output_tokens": "Reasoning tokens (included in output)",
    "cache_write_input_tokens": "Cache writes (if recorded)",
    "responses": "Model responses / internal steps",
}
ALIASES = {"tokens": "total_tokens", "input": "input_tokens", "cached": "cached_input_tokens",
           "uncached": "uncached_input_tokens", "output": "output_tokens",
           "reasoning": "reasoning_output_tokens", "requests": "responses"}


def duration_seconds(value: str) -> int:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([mhd])\s*", str(value), re.I)
    if not match:
        raise ValueError("Specify a duration such as 30m, 5h, 2d, 3d or 7d")
    seconds = float(match[1]) * {"m": 60, "h": 3600, "d": 86400}[match[2].lower()]
    if seconds < 60 or not seconds.is_integer():
        raise ValueError("Minimum duration is one minute; seconds must be whole numbers")
    return int(seconds)


def boundary(value: str, tz: ZoneInfo, *, end: bool = False) -> float:
    """End dates are inclusive; precise ISO timestamps are exclusive boundaries."""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        day = dt.date.fromisoformat(value)
        if end:
            day += dt.timedelta(days=1)
        return dt.datetime.combine(day, dt.time(), tzinfo=tz).timestamp()
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.timestamp()


def period_index(ts: float, start: float, seconds: int, tz: ZoneInfo) -> int:
    # Calendar day windows must remain aligned to midnight through DST transitions.
    if seconds % 86400 == 0:
        days = (dt.datetime.fromtimestamp(ts, tz).date() - dt.datetime.fromtimestamp(start, tz).date()).days
        return days // (seconds // 86400)
    return int((ts - start) // seconds)


def period_bounds(index: int, start: float, seconds: int, tz: ZoneInfo) -> tuple[float, float]:
    first = dt.datetime.fromtimestamp(start, tz)
    if seconds % 86400 == 0:
        first = first.replace(hour=0, minute=0, second=0, microsecond=0)
        count = seconds // 86400
        a = first + dt.timedelta(days=index * count)
        b = first + dt.timedelta(days=(index + 1) * count)
        return a.timestamp(), b.timestamp()
    return start + index * seconds, start + (index + 1) * seconds
