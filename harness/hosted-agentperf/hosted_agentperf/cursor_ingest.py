"""User-experienced timing for Cursor cloud agents.

A dumped transcript is role and text only, for example::

    {"role":"user","text":"..."}
    {"role":"assistant","thinking":"..."}
    {"role":"assistant","text":"OK"}

It has no timestamps, no token usage, and no model id. A row therefore
carries orchestrator wall times (launch, status checks, completion) plus
message counts and character lengths. ``start_wait_ms`` and ``durationMs``
are that wall clock. Prefill, cache, and decode columns stay empty: this
is not a service decomposition.

``model_pinned`` is the id the orchestrator was asked to launch
(``composer-2.5`` or ``grok-4.7``). ``model_served`` stays empty because
the transcript does not say what ran.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from hosted_agentperf.csvutil import write_csv
from hosted_agentperf.failures import classify_cursor
from hosted_agentperf.schema import CURSOR_STEP_COLUMNS, CURSOR_TURN_COLUMNS

MEASUREMENT = "user_experienced_wall_clock"
NOT_DECOMPOSABLE = (
    "Transcripts have no per-message timestamps and no usage. "
    "start_wait_ms is the orchestrator gap from launch to RUNNING. "
    "durationMs is the gap from launch to the completion notification. "
    "Those are user-experienced times for one task and one cell. "
    "They are not prefill, cache, or decode."
)


def ingest(orchestrator_rows: list[dict], transcripts: dict[str, list[dict]]) -> tuple[list[dict], list[dict], dict]:
    agents = _agents(orchestrator_rows)
    if not agents:
        agents = {agent_id: {"agent_id": agent_id} for agent_id in transcripts}
    rows = []
    for agent_id, meta in agents.items():
        events = transcripts.get(agent_id) or transcripts.get(meta.get("task_id") or "", [])
        rows.append(_row(meta, events))
    report = {
        "measurement": MEASUREMENT,
        "not_decomposable": NOT_DECOMPOSABLE,
        "model_served": "empty on every row; the transcript has no model id",
        "model_pinned": "copied from the orchestrator launch line, not from the transcript",
        "turns": len(rows),
        "empty_on_every_row": [
            column
            for column in CURSOR_TURN_COLUMNS
            if rows and all(row.get(column) in ("", None) for row in rows)
        ],
    }
    return rows, [], report


def ingest_files(orchestrator: Path, transcripts: list[Path], transcript_dir: Path | None, out_dir: Path) -> dict:
    by_agent: dict[str, list[dict]] = {}
    paths = list(transcripts)
    if transcript_dir is not None:
        paths.extend(sorted(Path(transcript_dir).glob("*.jsonl")))
    for path in paths:
        by_agent[path.stem] = _read_jsonl(path)
    rows, steps, report = ingest(_read_jsonl(orchestrator), by_agent)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "cursor_turns.csv", rows, CURSOR_TURN_COLUMNS)
    write_csv(out_dir / "cursor_steps.csv", steps, CURSOR_STEP_COLUMNS)
    (out_dir / "ingest_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def _agents(rows: list[dict]) -> dict[str, dict]:
    agents: dict[str, dict] = {}
    for row in rows:
        agent_id = str(row.get("agent_id") or row.get("agentId") or row.get("id") or "").strip() or "unknown"
        meta = agents.setdefault(agent_id, {"agent_id": agent_id})
        for key in ("phase", "cell", "block", "rep", "task_id", "run_id", "model_pinned", "error_code"):
            if row.get(key) not in (None, ""):
                meta[key] = row[key]
        if row.get("error") and not meta.get("error_code"):
            meta["error_code"] = row["error"]
        kind = str(row.get("type") or row.get("event") or "").lower()
        status = str(row.get("status") or "").upper()
        stamp = _ms(row.get("t") or row.get("timestamp") or row.get("time"))
        if kind in {"launch", "start", "created"}:
            meta["launch"] = stamp
        if status == "CREATING" or kind == "creating":
            meta["creating"] = stamp
        if status == "RUNNING" or kind == "running":
            meta["running"] = stamp
            meta["status"] = "RUNNING"
        if kind in {"finish", "finished", "complete", "completed"} or status in {
            "FINISHED",
            "COMPLETED",
            "ERROR",
            "FAILED",
            "EXPIRED",
        }:
            meta["finish"] = stamp
            meta["status"] = status or meta.get("status") or "FINISHED"
    return agents


def _row(meta: dict, events: list[dict]) -> dict:
    launch = meta.get("launch")
    base = launch if launch is not None else 0.0
    counts = _counts(events)
    row = {column: "" for column in CURSOR_TURN_COLUMNS}
    row.update(
        {
            "target": "cursor_cloud",
            "phase": meta.get("phase") or "",
            "cell": meta.get("cell") or meta.get("task_id") or "",
            "block": meta.get("block") or "",
            "rep": meta.get("rep") if meta.get("rep") is not None else "",
            "model_pinned": meta.get("model_pinned") or "",
            "model_served": "",
            "runtime": "cloud",
            "agent_id": meta.get("agent_id") or "",
            "run_id": meta.get("run_id") or "",
            "turn_index": 0,
            "t_send": _rel(launch, base),
            "t_status_creating": _rel(meta.get("creating"), base),
            "t_status_running": _rel(meta.get("running"), base),
            "t_finished": _rel(meta.get("finish"), base),
            "durationMs": _gap(launch, meta.get("finish")),
            "status": meta.get("status") or "",
            "error_code": meta.get("error_code") or "",
            "measurement": MEASUREMENT,
            **counts,
        }
    )
    row["failure_class"] = classify_cursor(row["status"], row["error_code"])
    row["start_wait_ms"] = _gap(launch, meta.get("running"))
    return row


def _counts(events: list[dict]) -> dict:
    counts = {
        "n_user_messages": 0,
        "n_assistant_texts": 0,
        "n_thinking": 0,
        "user_chars": 0,
        "assistant_text_chars": 0,
        "thinking_chars": 0,
    }
    for event in events:
        role = str(event.get("role") or "")
        if role == "user":
            counts["n_user_messages"] += 1
            counts["user_chars"] += len(str(event.get("text") or ""))
        elif role == "assistant":
            if "thinking" in event:
                counts["n_thinking"] += 1
                counts["thinking_chars"] += len(str(event.get("thinking") or ""))
            if "text" in event:
                counts["n_assistant_texts"] += 1
                counts["assistant_text_chars"] += len(str(event.get("text") or ""))
    return counts


def _ms(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if number > 1e12:
            return number
        if number > 1e9:
            return number * 1000.0
        return None
    text = str(value).strip()
    if text.isdigit():
        return _ms(int(text))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.timestamp() * 1000.0


def _rel(stamp, base) -> float | str:
    if stamp is None:
        return ""
    return float(stamp) - float(base)


def _gap(start, end) -> float | str:
    if start is None or end is None:
        return ""
    return float(end) - float(start)


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Ingest Cursor cloud-agent wall times")
    parser.add_argument("--orchestrator", required=True)
    parser.add_argument("--transcript", action="append", default=[])
    parser.add_argument("--transcript-dir", default="")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(argv)
    report = ingest_files(
        Path(args.orchestrator),
        [Path(path) for path in args.transcript],
        Path(args.transcript_dir) if args.transcript_dir else None,
        Path(args.out_dir),
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
