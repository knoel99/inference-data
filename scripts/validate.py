#!/usr/bin/env python3
"""Validate data/*.csv against datapackage.json.

Checks encoding, headers, types, enums, unique ids, foreign keys, and that
every measurement cites a source with an https URL and a date. Empty cells
are missing values, not failures. Standard library only.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "datapackage.json"
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INT = re.compile(r"^-?\d+$")
NUM = re.compile(r"^-?(?:\d+\.\d+|\d+)$")


def fail(errors: list[str], msg: str) -> None:
    errors.append(msg)


def load_package() -> dict:
    return json.loads(PACKAGE.read_text(encoding="utf-8"))


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError(f"{path} has a UTF-8 BOM")
    if b"\r" in raw:
        raise ValueError(f"{path} has CR characters; use LF newlines")
    text = raw.decode("utf-8")
    reader = csv.DictReader(text.splitlines())
    if reader.fieldnames is None:
        raise ValueError(f"{path} has no header")
    rows = list(reader)
    return list(reader.fieldnames), rows


def check_type(value: str, field: dict) -> str | None:
    kind = field["type"]
    if kind == "string":
        return None
    if kind == "integer":
        if not INT.match(value):
            return f"expected integer, got {value!r}"
        return None
    if kind == "number":
        if not NUM.match(value):
            return f"expected number with a dot decimal, got {value!r}"
        return None
    if kind == "date":
        if not DATE.match(value):
            return f"expected YYYY-MM-DD, got {value!r}"
        year, month, day = (int(x) for x in value.split("-"))
        if not (1 <= month <= 12 and 1 <= day <= 31):
            return f"impossible date {value}"
        return None
    return f"unknown schema type {kind}"


def main() -> int:
    errors: list[str] = []
    package = load_package()
    tables: dict[str, list[dict[str, str]]] = {}
    schemas: dict[str, dict] = {}

    for resource in package["resources"]:
        name = resource["name"]
        path = ROOT / resource["path"]
        schema = resource["schema"]
        schemas[name] = schema
        fields = [f["name"] for f in schema["fields"]]
        try:
            header, rows = read_csv(path)
        except ValueError as exc:
            fail(errors, str(exc))
            continue
        if header != fields:
            fail(errors, f"{name}: header {header} != schema {fields}")
        missing = schema.get("missingValues", [""])
        required_names = {"source_id", "title", "url", "date_accessed", "source_type"} if name == "sources" else set()
        if name == "hardware":
            required_names = {"hardware_id", "name", "vendor", "source_id"}
        if name == "models":
            required_names = {"model_id", "name", "source_id"}
        if name == "measurements":
            required_names = {"measurement_id", "source_id", "evidence", "notes"}
        pk = schema["primaryKey"]
        seen: set[str] = set()
        for i, row in enumerate(rows, start=2):
            pk_val = row.get(pk, "")
            if pk_val == "" or pk_val in missing:
                fail(errors, f"{name}:{i} empty primary key {pk}")
            elif pk_val in seen:
                fail(errors, f"{name}:{i} duplicate {pk} {pk_val}")
            else:
                seen.add(pk_val)
            if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", pk_val or ""):
                fail(errors, f"{name}:{i} id {pk_val!r} is not a stable lowercase slug")
            for field in schema["fields"]:
                fname = field["name"]
                value = row.get(fname, "")
                if value in missing:
                    if fname in required_names:
                        fail(errors, f"{name}:{i} {pk_val} missing required {fname}")
                    continue
                if "," in value and field["type"] in {"number", "integer"}:
                    fail(errors, f"{name}:{i} {fname} uses a comma decimal")
                problem = check_type(value, field)
                if problem:
                    fail(errors, f"{name}:{i} {pk_val} {fname}: {problem}")
                enum = field.get("constraints", {}).get("enum")
                if enum and value not in enum:
                    fail(errors, f"{name}:{i} {pk_val} {fname}={value!r} not in {enum}")
                if fname == "cache_hit_ratio":
                    ratio = float(value)
                    if ratio < 0 or ratio > 1:
                        fail(errors, f"{name}:{i} {pk_val} cache_hit_ratio {value} is outside 0 to 1")
                if fname == "url" and not value.startswith("https://"):
                    fail(errors, f"{name}:{i} {pk_val} url is not https")
        tables[name] = rows

    def index(table: str, key: str) -> dict[str, dict[str, str]]:
        return {row[key]: row for row in tables.get(table, [])}

    lookups = {
        "sources": index("sources", "source_id"),
        "hardware": index("hardware", "hardware_id"),
        "models": index("models", "model_id"),
        "measurements": index("measurements", "measurement_id"),
    }

    for resource in package["resources"]:
        name = resource["name"]
        for fk in resource["schema"].get("foreignKeys", []):
            field = fk["fields"][0]
            target_name = fk["reference"]["resource"]
            target_field = fk["reference"]["fields"][0]
            target = lookups[target_name]
            for i, row in enumerate(tables.get(name, []), start=2):
                value = row.get(field, "")
                if value == "":
                    continue
                if value not in target:
                    fail(errors, f"{name}:{i} {row.get(resource['schema']['primaryKey'])} {field}={value!r} missing from {target_name}.{target_field}")

    for i, row in enumerate(tables.get("measurements", []), start=2):
        src = lookups["sources"].get(row["source_id"])
        mid = row["measurement_id"]
        if src is None:
            continue
        if not src.get("url", "").startswith("https://"):
            fail(errors, f"measurements:{i} {mid} source has no https URL")
        if not src.get("date_accessed") and not src.get("date_published"):
            fail(errors, f"measurements:{i} {mid} source has no date")
        if not src.get("date_accessed"):
            fail(errors, f"measurements:{i} {mid} source has no date_accessed")
        evidence = row["evidence"]
        notes = row["notes"]
        if evidence == "derived" and "Derived" not in notes:
            fail(errors, f"measurements:{i} {mid} derived row does not say Derived")
        if evidence == "unverified_claim" and len(notes) < 20:
            fail(errors, f"measurements:{i} {mid} unverified claim has no explanation")
        metric = any(
            row[c]
            for c in (
                "prefill_tok_s",
                "decode_tok_s",
                "decode_tok_s_per_user",
                "ttft_ms",
                "power_w",
                "task_time_s",
                "kv_pool_tokens",
                "cache_hit_ratio",
                "cached_input_tokens",
                "uncached_input_tokens",
                "output_tokens",
            )
        )
        if not metric and "empty" not in notes.lower() and "not stored" not in notes.lower() and "range" not in notes.lower():
            fail(errors, f"measurements:{i} {mid} has no numeric result and does not explain why")

    if errors:
        print(f"{len(errors)} error(s):", file=sys.stderr)
        for err in errors:
            print(f"- {err}", file=sys.stderr)
        return 1
    counts = {name: len(rows) for name, rows in tables.items()}
    print("ok", counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
