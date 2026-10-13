#!/usr/bin/env python3
"""Audit the publication file set without printing suspected secret values."""
from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {".gitignore", "README.md", "VALIDATION.md", "pyproject.toml", "codex_usage.json",
              "generate.py", "serve.py", "generate.command", "serve.command"}
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".html", ".css", ".md", ".sh"}
SOURCE_DIRS = {"src", "tests", "docs", "scripts"}
REQUIRED_IGNORES = {"reports/", "archive/", "exports/", "screenshots/", "demo-data/", ".claude/", ".codex*/",
                    "__pycache__/", ".venv/", "build/", "dist/", "*.egg-info/", "node_modules/", ".env", ".env.*",
                    "auth.json", "codex_usage.local.json", "*.jsonl", "*.jsonl.gz", "*.jsonl.zst", "*.sqlite", "*.pickle"}
CHECKS = {
    "non-English Cyrillic text": re.compile("[\u0400-\u04ff]"),
    "machine-specific user path": re.compile(r"/(?:Users|home)/(?!demo(?:/|\b))[^/\s\"'<>]+/|[A-Z]:\\Users\\[^\\\s]+\\"),
    "GitHub credential": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b"),
    "API credential": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private key material": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credential-bearing URL": re.compile(r"https?://[^\s/:]+:[^\s/@]+@"),
    "personal email": re.compile(r"\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
}


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, check=check, capture_output=True)


def allowed(name: str) -> bool:
    path = Path(name)
    return name in ROOT_FILES or (len(path.parts) > 1 and path.parts[0] in SOURCE_DIRS
                                 and not any(p.startswith(".") or p == "__pycache__" for p in path.parts)
                                 and path.suffix in SOURCE_SUFFIXES)


def ignored(name: str, rules: list[str]) -> bool:
    """Handle the deliberately simple ignore rules used by this repository."""
    parts = Path(name).parts
    result = False
    for rule in rules:
        if not rule or rule.startswith("#"):
            continue
        negate = rule.startswith("!")
        pattern = rule.lstrip("!")
        if pattern.endswith("/"):
            match = any(fnmatch.fnmatch(part + "/", pattern) for part in parts[:-1])
        else:
            match = any(fnmatch.fnmatch(part, pattern) for part in parts) if "/" not in pattern else fnmatch.fnmatch(name, pattern)
        if match:
            result = not negate
    return result


def audit(staged: bool = False) -> tuple[list[str], list[str]]:
    rules = (ROOT / ".gitignore").read_text().splitlines()
    errors = [f"Missing ignore rule: {p}" for p in sorted(REQUIRED_IGNORES - set(rules))]
    repository = git("rev-parse", "--show-toplevel", check=False)
    in_repo = repository.returncode == 0 and Path(repository.stdout.decode().strip()).resolve() == ROOT
    if staged:
        if not in_repo:
            return [], ["A Git repository is required for --staged."]
        files = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").stdout.decode().split("\0")
        files = [f for f in files if f]
        if not files:
            errors.append("The Git index contains no changes to review.")
    else:
        files = []
        def visit(folder: Path) -> None:
            for path in sorted(folder.iterdir()):
                name = path.relative_to(ROOT).as_posix()
                if path.name == ".git" or ignored(name + ("/sentinel" if path.is_dir() else ""), rules):
                    continue
                if path.is_dir() and not path.is_symlink():
                    visit(path)
                else:
                    files.append(name)
        visit(ROOT)
    for name in files:
        if not allowed(name):
            errors.append(f"File is outside the publication allowlist: {name}")
            continue
        if ignored(name, rules):
            errors.append(f"Ignored file is staged: {name}")
        path = ROOT / name
        if path.is_symlink():
            errors.append(f"Symlink is not allowed: {name}")
            continue
        data = git("show", ":" + name).stdout if staged else path.read_bytes()
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            errors.append(f"Non-text publication file: {name}")
            continue
        for label, pattern in CHECKS.items():
            for match in pattern.finditer(content):
                line = content.count("\n", 0, match.start()) + 1
                errors.append(f"{name}:{line}: {label}")
    if in_repo:
        probes = ["reports/private.html", "archive/private.md", "demo-data/showcase.html", "exports/usage.csv",
                  "screenshots/preview.jpg", ".codex-work/sessions/log.jsonl", ".claude/launch.json",
                  "src/codex_usage/__pycache__/loader.pyc", ".venv/bin/python", "build/lib/test.py",
                  "dist/package.whl", "src/package.egg-info/PKG-INFO", ".env", ".env.local", "auth.json",
                  "codex_usage.local.json", "local/session.jsonl.gz", "local/session.jsonl.zst", "local/cache.pickle"]
        for probe in probes:
            if git("check-ignore", "--no-index", "-q", "--", probe, check=False).returncode != 0:
                errors.append(f"Git does not ignore generated/private data: {probe}")
        if staged:
            for name in git("ls-files", "-z").stdout.decode().split("\0"):
                if name and (not allowed(name) or ignored(name, rules)):
                    errors.append(f"Unsafe file in Git index: {name}")
    return sorted(files), errors


def audit_history() -> tuple[list[str], list[str]]:
    commits = git("rev-list", "--all", check=False)
    if commits.returncode:
        return [], ["A Git repository with commits is required for --history."]
    hashes = commits.stdout.decode().splitlines()
    if not hashes:
        return [], ["No commits to audit."]
    files_seen, errors = set(), []
    rules = (ROOT / ".gitignore").read_text().splitlines()
    for commit in hashes:
        metadata = git("show", "-s", "--format=%ae%n%ce%n%B", commit).stdout.decode()
        for email in metadata.splitlines()[:2]:
            if not email.endswith("@users.noreply.github.com"):
                errors.append(f"{commit[:8]}: commit identity must use a GitHub noreply email")
        for label, pattern in CHECKS.items():
            if pattern.search(metadata):
                errors.append(f"{commit[:8]}: {label} in commit metadata")
        names = git("ls-tree", "-r", "--name-only", "-z", commit).stdout.decode().split("\0")
        for name in filter(None, names):
            files_seen.add(name)
            if not allowed(name) or ignored(name, rules):
                errors.append(f"{commit[:8]}: private/generated file in history: {name}")
                continue
            data = git("show", commit + ":" + name).stdout
            try:
                content = data.decode("utf-8")
            except UnicodeDecodeError:
                errors.append(f"{commit[:8]}: non-text file in history: {name}")
                continue
            for label, pattern in CHECKS.items():
                if pattern.search(content):
                    errors.append(f"{commit[:8]}: {name}: {label}")
    return sorted(files_seen), errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--history", action="store_true", help="Audit every committed file and commit email")
    parser.add_argument("--list", action="store_true", help="Print only the audited publication paths")
    args = parser.parse_args()
    files, errors = audit_history() if args.history else audit(args.staged)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        print(f"Publication audit FAILED: {len(errors)} issue(s).", file=sys.stderr)
        return 1
    if args.list:
        print("\n".join(files))
    else:
        print(f"Publication audit passed: {len(files)} source/documentation files; generated and local data excluded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
