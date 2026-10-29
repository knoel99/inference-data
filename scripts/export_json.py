#!/usr/bin/env python3
"""Export data/*.csv to data/json/*.json, or check that the export matches."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = DATA / "json"
TABLES = ("sources", "hardware", "models", "measurements")
INT_FIELDS = {
    "hw_count",
    "context_tokens",
    "input_tokens",
    "output_tokens",
    "concurrency",
    "ttft_ms",
}


def parse(value: str, field: str):
    if value == "":
        return None
    if field in INT_FIELDS or field.endswith("_tokens"):
        if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
            return int(value)
    try:
        if "." in value:
            return float(value)
        if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
            return int(value)
    except ValueError:
        return value
    return value


def rows_for(name: str) -> list[dict]:
    with (DATA / f"{name}.csv").open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return [{k: parse(v, k) for k, v in row.items()} for row in reader]


def dump(name: str) -> str:
    return json.dumps(rows_for(name), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    check = "--check" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    failed = False
    for name in TABLES:
        text = dump(name)
        path = OUT / f"{name}.json"
        if check:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if current != text:
                print(f"mismatch: {path}", file=sys.stderr)
                failed = True
        else:
            path.write_text(text, encoding="utf-8")
            print(path)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
