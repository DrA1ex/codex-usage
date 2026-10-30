import datetime as dt
import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from codex_usage import loader, server
from codex_usage.loader import FileCache, load_history
from codex_usage.webdata import build_dataset, quota_now


def iso(seconds):
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat()


def count(seconds, total, last, used=None):
    limits = None if used is None else {"primary": {"window_minutes": 300, "used_percent": used, "resets_at": 18000}}
    return {"timestamp": iso(seconds), "type": "event_msg", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": total, "output_tokens": 0, "total_tokens": total},
        "last_token_usage": {"input_tokens": last, "output_tokens": 0, "total_tokens": last}},
        "rate_limits": limits}}


def write_session(root, name, session_id, records):
    path = root / "sessions" / "2026" / "09" / "01" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = {"timestamp": iso(0), "type": "session_meta",
            "payload": {"id": session_id, "cwd": "/work/demo", "originator": "codex_cli", "source": "cli"}}
    context = {"timestamp": iso(0), "type": "turn_context", "payload": {"model": "demo-model", "effort": "high"}}
    path.write_text("\n".join(json.dumps(r) for r in [meta, context, *records]) + "\n")
    return path


class CacheTests(unittest.TestCase):
    def test_cached_scan_matches_fresh_scan_and_rereads_changed_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_session(root, "rollout-a.jsonl", "a", [count(10, 100, 100, 5), count(20, 300, 200, 9)])
            changing = write_session(root, "rollout-b.jsonl", "b", [count(30, 50, 50)])
            cache = FileCache(root / "cache.pickle")
            first = load_history(root, cache=cache)
            cache.save()

            cache = FileCache(root / "cache.pickle")
            second = load_history(root, cache=cache)
            self.assertEqual(second.cached_files, 2)
            self.assertEqual([e["counts"] for e in first.events], [e["counts"] for e in second.events])
            self.assertEqual(set(second.sessions), {"a", "b"})

            write_session(root, changing.name, "b", [count(30, 50, 50), count(40, 80, 30)])
            third = load_history(root, cache=FileCache(root / "cache.pickle"))
            self.assertEqual(third.cached_files, 1)
            self.assertEqual(sum(e["counts"]["total_tokens"] for e in third.events), 380)

    def test_parallel_parse_matches_serial(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for i in range(12):
                write_session(root, f"rollout-{i:02}.jsonl", f"s{i}", [count(100 * i + 1, 10 + i, 10 + i)])
            serial = load_history(root)
            parallel = load_history(root, workers=2)
            self.assertEqual([(e["ts"], e["session"]) for e in serial.events],
                             [(e["ts"], e["session"]) for e in parallel.events])


class DatasetTests(unittest.TestCase):
    def test_dataset_is_compact_and_serializable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_session(root, "rollout-a.jsonl", "a", [count(10, 100, 100, 5), count(20, 300, 200, 9)])
            history = load_history(root)
            data = build_dataset(history, {"path": str(root)})
            json.dumps(data)
            self.assertEqual(data["models"], ["demo-model"])
            self.assertEqual(len(data["events"]), 2)
            total = data["metric_keys"].index("total_tokens")
            self.assertEqual(sum(row[5][total] for row in data["events"]), 300)
            self.assertEqual(data["sessions"][0]["cwd"], "/work/demo")
            self.assertEqual(data["efforts"], ["high"])
            self.assertEqual([(q["minutes"], q["used"]) for q in quota_now(history)], [(300, 9)])


class TimingTests(unittest.TestCase):
    def test_responses_are_timed_inside_turns(self):
        def rec(seconds, kind, payload, compact=False):
            record = {"timestamp": iso(seconds), "type": kind, "payload": payload}
            return json.dumps(record, separators=(",", ":")) if compact else json.dumps(record)

        def usage(seconds, total):
            return rec(seconds, "event_msg", {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": total, "output_tokens": total // 10, "total_tokens": total + total // 10},
                "last_token_usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}}})

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "sessions" / "2026" / "09" / "01" / "rollout-t.jsonl"
            path.parent.mkdir(parents=True)
            lines = [
                rec(0, "session_meta", {"id": "t", "cwd": "/work/demo", "source": "cli"}),
                rec(0, "turn_context", {"model": "demo-model"}),
                usage(5, 900),  # before any turn: not timed
                rec(100, "event_msg", {"type": "task_started", "turn_id": "x"}),
                rec(101, "response_item", {"type": "message", "role": "user", "content": []}, compact=True),
                rec(104, "response_item", {"type": "reasoning", "summary": []}, compact=True),
                rec(110, "response_item", {"type": "function_call", "name": "exec", "arguments": "{}"}),
                rec(111, "token_usage_record", {"usage": {}}),
                rec(130, "response_item", {"type": "function_call_output", "output": "x" * 5000}, compact=True),
                usage(130.5, 1000),  # generation 101 → 111, tools 111 → 130.5
                rec(140, "response_item", {"type": "message", "role": "assistant", "content": []}, compact=True),
                usage(141, 1100),  # no usage record: generation ends at the last output item, 130.5 → 140
                rec(171, "token_usage_record", {"usage": {}}),
                rec(171.2, "compacted", {"message": ""}),
                usage(171.3, 1200),  # a compaction call, 141 → 171
                rec(175, "event_msg", {"type": "task_complete", "duration_ms": 75500, "time_to_first_token_ms": 2500}),
            ]
            path.write_text("\n".join(lines) + "\n")
            history = load_history(root)
            timed = [(e["generation"], e["tools"], e["compaction"]) for e in history.events]
            self.assertEqual(timed[0], (None, None, False))
            for (gen, tools, compaction), expected in zip(timed[1:], [(10, 19.5, False), (9.5, 1, False), (30, .3, True)]):
                self.assertAlmostEqual(gen, expected[0], places=2)
                self.assertAlmostEqual(tools, expected[1], places=2)
                self.assertEqual(compaction, expected[2])
            self.assertEqual(len(history.turns), 1)
            self.assertAlmostEqual(history.turns[0]["end"] - history.turns[0]["start"], 75.5, places=2)
            self.assertEqual(history.turns[0]["ttft"], 2.5)
            data = build_dataset(history, {"path": str(root)})
            self.assertEqual([row[11] for row in data["events"]], [-1, 0, 0, 0], "each timed response points at its turn")
            self.assertEqual([row[10] for row in data["events"]], [0, 0, 0, 1])
            self.assertEqual(data["turns"], [[100.0, 75.5, 0, 2.5, 0]])


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.saved = server.STATE_DIR, server.STATE_FILE, server.APP.state
        server.STATE_DIR = Path(cls.tmp.name)
        server.STATE_FILE = server.STATE_DIR / "web-state.json"
        server.APP.state = {"custom_profiles": [], "labels": {}}
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.STATE_DIR, server.STATE_FILE, server.APP.state = cls.saved
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=body, headers={"Host": f"127.0.0.1:{self.port}", **(headers or {})})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, data

    def test_index_and_meta(self):
        status, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"/static/js/app.js", body)
        status, body = self.request("GET", "/api/meta")
        self.assertEqual(status, 200)
        self.assertIn("timezone", json.loads(body))

    def test_foreign_host_and_origin_are_rejected(self):
        self.assertEqual(self.request("GET", "/api/meta", headers={"Host": "evil.example"})[0], 403)
        status, _ = self.request("POST", "/api/scan", body=b"{}",
                                 headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/scan", body=b"{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)

    def test_static_paths_cannot_escape(self):
        self.assertEqual(self.request("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.request("GET", "/static/%2e%2e/server.py")[0], 404)

    def test_unknown_profile_is_refused(self):
        status, body = self.request("POST", "/api/run", body=json.dumps({"command": "report", "args": {"profile": "/etc"}}).encode(),
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("Profile", json.loads(body)["error"])

    def test_profile_detection_ignores_other_tools(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "claude" / "sessions").mkdir(parents=True)
            (root / "claude" / "sessions" / "123.json").write_text("{}")
            (root / "codex" / "sessions" / "2026").mkdir(parents=True)
            self.assertFalse(server.App.is_profile(root / "claude"))
            self.assertTrue(server.App.is_profile(root / "codex"))


if __name__ == "__main__":
    unittest.main()
