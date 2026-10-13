from __future__ import annotations

import csv
import html
import json
from importlib.resources import files
from pathlib import Path


def write_report(data: dict, destination: Path) -> None:
    template = files("codex_usage").joinpath("report.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    # Session metadata/model names are untrusted; they must never terminate a script tag.
    payload = payload.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    title = html.escape("Codex usage · " + data["options"]["profile_name"])
    rendered = template.replace("__DOCUMENT_TITLE__", title).replace("__REPORT_DATA__", payload)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(rendered, encoding="utf-8")


def safe_csv(value):
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = sorted({key for row in rows for key in row})
    with path.open("w", newline="", encoding="utf-8-sig") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: safe_csv(row.get(key, "")) for key in fields} for row in rows)


def export_tables(data: dict, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    write_csv(directory / "periods.csv", data["period_rows"])
    write_csv(directory / "resets.csv", data["resets"])
    rows = []
    for window in data["windows"]:
        row = {key: value for key, value in window.items()
               if key not in {"metrics", "models", "internal_metrics", "internal_models", "source"}}
        row.update(window["metrics"])
        for model, metrics in window["models"].items():
            row[model + ":total_tokens"] = metrics.get("total_tokens", 0)
        row["internal_total_tokens"] = window["internal_metrics"].get("total_tokens", 0)
        for model, metrics in window["internal_models"].items():
            row["internal:" + model + ":total_tokens"] = metrics.get("total_tokens", 0)
        rows.append(row)
    write_csv(directory / "windows.csv", rows)
    (directory / "report-data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
