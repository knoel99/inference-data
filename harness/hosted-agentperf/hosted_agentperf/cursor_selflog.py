"""Estimates from Cursor agents that time themselves.

A native transcript has no timestamps and no usage. The task spec tells the
agent to append ``bench/cursor_runs/<run_id>/steps.jsonl`` and commit it.
Each line is one tool call: ``date +%s.%N`` before and after, the step
index, bytes read and written, and the model id it was launched with.

The model turn is the gap from the end of one tool call to the start of the
next. That gap is prefill plus decode, not either one. Tokens are
``bytes / 4``. The fit

    turn_time_ms = L0 + a * new_tokens + b * output_tokens

is ordinary least squares, per model. ``1000/a`` and ``1000/b`` are the
prefill and decode estimates. Turn 1 versus later turns at the same context
size is the cache comparison. All of these are agent-side wall clocks.
"""

from __future__ import annotations

import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

from hosted_agentperf.regression import fit_ols

BYTES_PER_TOKEN = 4
CELL_RE = re.compile(r"^ctx(\d+)k_(short|long)$")

LOG_HINT = (
    "Before every tool call, including a step 0 line written at the start "
    "with read_bytes 0 and write_bytes 0, append one JSON line with "
    "date +%s.%N. The gap from t_after of one line to t_before of the next "
    "is the model turn. Commit bench/cursor_runs/$RUN_ID/steps.jsonl on your branch."
)


def tokens_from_bytes(n_bytes: int) -> float:
    return n_bytes / BYTES_PER_TOKEN


def load_steps(path: Path) -> list[dict]:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def model_turns(steps: list[dict]) -> list[dict]:
    """One row per gap between a tool call's end and the next call's start."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for step in steps:
        grouped[str(step.get("run_id") or "")].append(step)
    turns = []
    for run_id, rows in grouped.items():
        ordered = sorted(rows, key=lambda row: int(row.get("step") or 0))
        turn_index = 0
        for previous, current in zip(ordered, ordered[1:]):
            start = _seconds(current.get("t_before"))
            end_prev = _seconds(previous.get("t_after"))
            if start is None or end_prev is None:
                continue
            gap_ms = (start - end_prev) * 1000.0
            if gap_ms <= 0:
                continue
            turn_index += 1
            read_bytes = int(current.get("read_bytes") or 0)
            write_bytes = int(current.get("write_bytes") or 0)
            cell = str(current.get("cell") or "")
            context, output_class = _cell_shape(cell)
            if current.get("context_tokens") not in (None, ""):
                context = int(current["context_tokens"])
            turns.append(
                {
                    "run_id": run_id,
                    "model_pinned": str(current.get("model_pinned") or ""),
                    "cell": cell,
                    "step": int(current.get("step") or 0),
                    "turn_index": turn_index,
                    "turn_time_ms": gap_ms,
                    "read_bytes": read_bytes,
                    "write_bytes": write_bytes,
                    "new_tokens": tokens_from_bytes(read_bytes),
                    "output_tokens": tokens_from_bytes(write_bytes),
                    "context_tokens": context,
                    "output_class": output_class,
                }
            )
    return turns


def analyze_turns(turns: list[dict]) -> dict:
    by_model: dict[str, list[dict]] = defaultdict(list)
    for turn in turns:
        by_model[turn["model_pinned"] or "unknown"].append(turn)
    fits = {}
    for model, rows in sorted(by_model.items()):
        fits[model] = _fit(rows)
    return {
        "label": (
            "Estimates from agent-side wall clocks. "
            "new_tokens and output_tokens are bytes/4, not server usage. "
            "turn_time is prefill and decode together."
        ),
        "by_model": fits,
        "cache_effect": _cache_effect(turns),
    }


def analyze_steps(steps: list[dict]) -> dict:
    return analyze_turns(model_turns(steps))


def _fit(rows: list[dict]) -> dict:
    if len(rows) < 3:
        return {"n": len(rows), "error": "need at least 3 model turns"}
    design = [[1.0, row["new_tokens"], row["output_tokens"]] for row in rows]
    response = [row["turn_time_ms"] for row in rows]
    beta = fit_ols(design, response)
    if beta is None:
        return {"n": len(rows), "error": "fit failed"}
    intercept, slope_new, slope_out = beta
    return {
        "n": len(rows),
        "L0_ms": intercept,
        "a_ms_per_new_token": slope_new,
        "b_ms_per_output_token": slope_out,
        "prefill_tok_s_est": (1000.0 / slope_new) if slope_new > 0 else None,
        "decode_tok_s_est": (1000.0 / slope_out) if slope_out > 0 else None,
        "equation": "turn_time_ms = L0 + a * new_tokens + b * output_tokens",
    }


def _cache_effect(turns: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for turn in turns:
        if turn["context_tokens"] is None:
            continue
        key = (turn["model_pinned"], turn["context_tokens"], turn["output_class"])
        groups[key].append(turn)
    rows = []
    for (model, context, output_class), items in sorted(groups.items(), key=lambda item: item[0]):
        first = [item["turn_time_ms"] for item in items if item["turn_index"] == 1]
        later = [item["turn_time_ms"] for item in items if item["turn_index"] > 1]
        if not first or not later:
            continue
        first_median = statistics.median(first)
        later_median = statistics.median(later)
        rows.append(
            {
                "model_pinned": model,
                "context_tokens": context,
                "output_class": output_class,
                "n_turn1": len(first),
                "n_later": len(later),
                "turn1_median_ms": first_median,
                "later_median_ms": later_median,
                "later_minus_turn1_ms": later_median - first_median,
            }
        )
    return rows


def _cell_shape(cell: str) -> tuple[int | None, str]:
    match = CELL_RE.match(cell)
    if not match:
        return None, ""
    return int(match.group(1)) * 1000, match.group(2)


def _seconds(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Fit Cursor self-timed model turns")
    parser.add_argument("steps_jsonl")
    parser.add_argument("--out", default="")
    args = parser.parse_args(argv)
    report = analyze_steps(load_steps(Path(args.steps_jsonl)))
    text = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
