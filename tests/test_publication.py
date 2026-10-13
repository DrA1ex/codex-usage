"""Synthetic privacy, local-configuration and demo regression checks."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from codex_usage import server


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


audit = module('publication_audit', 'audit_publication.py')
demo = module('synthetic_demo', 'demo.py')


class ConfigTests(unittest.TestCase):
    def test_local_settings_take_precedence_over_shared_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'codex_usage.json').write_text(json.dumps({'timezone': 'UTC'}))
            (root / 'codex_usage.local.json').write_text(json.dumps({'timezone': 'America/New_York'}))
            with patch.object(server, 'ROOT', root):
                self.assertEqual(server.project_config()['timezone'], 'America/New_York')
            (root / 'codex_usage.local.json').unlink()
            with patch.object(server, 'ROOT', root):
                self.assertEqual(server.project_config()['timezone'], 'UTC')


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / '.gitignore').write_text((ROOT / '.gitignore').read_text())
        self.root_patch = patch.object(audit, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_private_reports_and_local_settings_are_excluded(self):
        (self.root / 'README.md').write_text('Synthetic documentation')
        (self.root / 'reports').mkdir()
        (self.root / 'reports' / 'private.html').write_text('DO NOT PUBLISH')
        (self.root / 'codex_usage.local.json').write_text('DO NOT PUBLISH')
        (self.root / '.claude').mkdir()
        (self.root / '.claude' / 'launch.json').write_text('DO NOT PUBLISH')
        files, errors = audit.audit()
        self.assertEqual(errors, [])
        self.assertEqual(files, ['.gitignore', 'README.md'])

    def test_unexpected_file_is_rejected(self):
        (self.root / 'private-notes.md').write_text('Synthetic private note')
        _, errors = audit.audit()
        self.assertTrue(any('allowlist' in error for error in errors))

    def test_personal_path_is_flagged_without_printing_its_value(self):
        name = '/Users/' + 'fixture-person' + '/project'
        (self.root / 'README.md').write_text(name)
        _, errors = audit.audit()
        self.assertTrue(any('machine-specific user path' in error for error in errors))
        self.assertFalse(any('fixture-person' in error for error in errors))

    def test_symlink_to_private_file_is_rejected(self):
        (self.root / 'private.txt').write_text('Synthetic private text')
        (self.root / 'README.md').symlink_to(self.root / 'private.txt')
        _, errors = audit.audit()
        self.assertTrue(any('Symlink' in error for error in errors))


class DemoTests(unittest.TestCase):
    def test_demo_has_only_fictional_sessions_and_eligible_windows(self):
        from codex_usage.analysis import build_windows
        history = demo.synthetic_history(1770000000, seed=7)
        windows, _ = build_windows(history)
        self.assertTrue(any(w['full'] and not w['exclusion'] for w in windows))
        self.assertGreater(len(history.sessions), 30)
        self.assertTrue(all(s['cwd'].startswith('/home/demo/projects/') for s in history.sessions.values()))
        self.assertEqual({e['model'] for e in history.events}, {'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'})

    def test_demo_build_never_discovers_real_profiles_or_sends_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(server.App, 'profile_paths', side_effect=AssertionError('Real profile discovery forbidden')):
                target = demo.build(Path(folder))
            html = target.read_text()
            self.assertIn('Synthetic demo', html)
            self.assertNotIn(str(Path.home()), html)
            self.assertIn('demo-report.html', '\n'.join(p.name for p in Path(folder).iterdir()))
            self.assertNotIn('src="/static/', html)
            self.assertNotIn('href="/static/style.css"', html)


if __name__ == '__main__':
    unittest.main()
