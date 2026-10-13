#!/usr/bin/env python3
"""Run from the checkout without installing a package."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from codex_usage.cli import main

if __name__ == "__main__":
    raise SystemExit(main(project_root=ROOT))
