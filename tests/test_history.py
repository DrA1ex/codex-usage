import datetime as dt
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from codex_usage.analysis import aggregate, build_windows
from codex_usage.cli import main
from codex_usage.loader import History, load_history
from codex_usage.report import write_report
from codex_usage.settings import boundary, period_index, period_bounds


def snapshot(ts, used, reset=18000, minutes=300, limit="codex"):
    return {"ts": ts, "used": used, "reset": reset, "minutes": minutes, "limit_id": limit,
            "model": "new-model", "internal": False, "file": "fixture.jsonl", "line": 1}


def event(ts, tokens, model="new-model"):
    return {"ts": ts, "model": model, "internal": False,
            "counts": {"input_tokens": tokens, "cached_input_tokens": 0, "output_tokens": 0,
                       "total_tokens": tokens, "responses": 1}}


class WindowTests(unittest.TestCase):
    def test_first_100_stops_counting_active_turn_overrun(self):
        h = History(events=[event(0, 10), event(50, 90), event(80, 1000)],
                    snapshots=[snapshot(0, 0), snapshot(50, 100), snapshot(100, 100)])
        windows, _ = build_windows(h)
        self.assertEqual(windows[0]["metrics"]["total_tokens"], 100)
        self.assertEqual(windows[0]["end"], 50)

    def test_deadline_jitter_does_not_create_reset(self):
        h = History(events=[event(0, 10), event(100, 90)],
                    snapshots=[snapshot(0, 0), snapshot(40, 40, 18009), snapshot(100, 100, 18002)])
        windows, resets = build_windows(h)
        self.assertEqual(len(windows), 1)
        self.assertEqual(resets, [])

    def test_early_reset_splits_real_usage(self):
        h = History(events=[event(0, 50), event(1000, 70)], snapshots=[snapshot(0, 0), snapshot(500, 70),
                    snapshot(1000, 0, 19000), snapshot(1300, 100, 19000)])
        windows, resets = build_windows(h)
        self.assertEqual(len(windows), 2)
        self.assertTrue(resets[0]["early"])
        self.assertEqual(windows[0]["metrics"]["total_tokens"], 50)
        self.assertEqual(windows[1]["metrics"]["total_tokens"], 70)

    def test_counter_refill_without_new_deadline_needs_confirmation(self):
        h = History(events=[event(0, 10), event(120, 20)], snapshots=[snapshot(0, 0), snapshot(60, 70),
                    snapshot(120, 0), snapshot(130, 2), snapshot(200, 100)])
        windows, resets = build_windows(h)
        self.assertEqual(len(windows), 2)
        self.assertEqual(resets[0]["reason"], "counter_drop_confirmed")

    def test_single_stale_zero_is_not_a_refill(self):
        h = History(events=[event(0, 10)], snapshots=[snapshot(0, 0), snapshot(60, 70),
                    snapshot(120, 0), snapshot(130, 71)])
        windows, resets = build_windows(h)
        self.assertEqual(len(windows), 1)
        self.assertEqual(resets, [])

    def test_missing_start_is_not_called_capacity(self):
        h = History(events=[event(0, 10)], snapshots=[snapshot(0, 60), snapshot(100, 100)])
        windows, _ = build_windows(h)
        self.assertIsNotNone(windows[0]["exclusion"])

    def test_capacity_is_mean_of_windows_not_mean_of_percent_ratios(self):
        h = History(events=[event(0, 100), event(20000, 300)],
                    snapshots=[snapshot(0, 0), snapshot(50, 98), snapshot(20000, 0, 38000), snapshot(20050, 100, 38000)])
        windows, _ = build_windows(h)
        rows = aggregate(h.events, windows, start=0, end=40000, seconds=86400, timezone="UTC",
                         mode="capacity", metric="total_tokens", minutes=300, limit_id="codex")
        self.assertEqual(rows[0]["value"], 200)
        self.assertEqual(rows[0]["observations"], 2)

    def test_short_quota_windows_do_not_merge(self):
        h = History(events=[event(0, 100), event(65, 200)], snapshots=[snapshot(0, 0, 60, 1),
                    snapshot(30, 100, 60, 1), snapshot(65, 0, 125, 1), snapshot(95, 100, 125, 1)])
        windows, _ = build_windows(h)
        self.assertEqual(len(windows), 2)


class LoaderTests(unittest.TestCase):
    def make_file(self, root, name, records, compressed=False):
        path = root / "sessions" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        text = "\n".join(json.dumps(r) for r in records) + "\n"
        if compressed:
            with gzip.open(path, "wt") as f:
                f.write(text)
        else:
            path.write_text(text)

    def count_record(self, seconds, total, last, limits=None):
        return {"timestamp": dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat(),
                "type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": total, "output_tokens": 0, "total_tokens": total},
                "last_token_usage": {"input_tokens": last, "output_tokens": 0, "total_tokens": last}},
                "rate_limits": limits}}

    def test_inheritance_repeats_and_forks_do_not_inflate_usage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            context = {"timestamp": "2026-09-01T00:00:00Z", "type": "turn_context", "payload": {"model": "future-model-v99"}}
            records = [context, self.count_record(100, 1000, 100), self.count_record(101, 1000, 100),
                       self.count_record(110, 1200, 200), self.count_record(120, 50, 50)]
            self.make_file(root, "a.jsonl", records)
            self.make_file(root, "fork.jsonl.gz", records, compressed=True)
            h = load_history(root)
            self.assertEqual(sum(e["counts"]["total_tokens"] for e in h.events), 350)
            self.assertEqual({e["model"] for e in h.events}, {"future-model-v99"})
            self.assertEqual(h.diagnostics["duplicate_history_event"], 3)

    def test_weekly_counter_is_identified_by_minutes_not_slot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            limits = {"primary": {"window_minutes": 10080, "used_percent": 0, "resets_at": 604900}}
            context = {"timestamp": "2026-09-01T00:00:00Z", "type": "turn_context", "payload": {"model": "new"}}
            self.make_file(root, "a.jsonl", [context, self.count_record(100, 10, 10, limits)])
            h = load_history(root)
            windows, _ = build_windows(h)
            self.assertEqual(windows[0]["minutes"], 10080)

    def test_auth_file_is_not_used_and_cli_generates_offline_report(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "auth.json").write_text('DO NOT READ THIS PRIVATE SECRET')
            start = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc).timestamp()
            context = {"timestamp": "2026-09-01T00:00:00Z", "type": "turn_context", "payload": {"model": "brand-new-model"}}
            limits0 = {"primary": {"window_minutes": 300, "used_percent": 0, "resets_at": start + 18000}}
            limits1 = {"primary": {"window_minutes": 300, "used_percent": 100, "resets_at": start + 18000}}
            self.make_file(root, "a.jsonl", [context, self.count_record(start, 100, 100, limits0),
                                          self.count_record(start + 100, 500, 400, limits1)])
            target = root / "report.html"
            code = main(["--codex-home", str(root), "--start", "2026-09-01", "--end", "2026-09-01",
                         "--timezone", "UTC", "--output", str(target), "--quiet", "--no-cache"], project_root=root)
            self.assertEqual(code, 0)
            html = target.read_text()
            self.assertIn("brand-new-model", html)
            self.assertNotIn("PRIVATE SECRET", html)
            data = json.loads((root / "report" / "report-data.json").read_text())
            self.assertEqual(data["period_rows"][0]["value"], 500)

    def test_script_tag_in_model_name_is_serialized_safely(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "report.html"
            data = {"options": {"profile_name": "test"}, "models": ["</script><script>alert(1)</script>"]}
            write_report(data, target)
            html = target.read_text()
            self.assertNotIn("</script><script>alert(1)</script>", html)
            self.assertIn("\\u003c/script", html)


class DateTests(unittest.TestCase):
    def test_end_date_is_inclusive(self):
        tz = ZoneInfo("Asia/Tokyo")
        self.assertEqual(boundary("2026-09-02", tz, end=True) - boundary("2026-09-01", tz), 2 * 86400)

    def test_calendar_period_preserves_midnight_at_dst(self):
        tz = ZoneInfo("America/New_York")
        start = boundary("2026-03-07", tz)
        a, b = period_bounds(1, start, 86400, tz)
        self.assertEqual(dt.datetime.fromtimestamp(a, tz).hour, 0)
        self.assertEqual(b - a, 23 * 3600)
        self.assertEqual(period_index(a + 3 * 3600, start, 86400, tz), 1)


if __name__ == "__main__":
    unittest.main()
