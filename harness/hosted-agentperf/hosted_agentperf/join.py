"""Join proxy rows, OTEL llm_request spans, and raw bodies on request_id.

Derived columns are computed here from the raw cells. They are not read back
from the proxy log if the proxy happened to store them.
"""

from __future__ import annotations

import json
from pathlib import Path

from hosted_agentperf.csvutil import as_float, as_int, write_csv
from hosted_agentperf.failures import classify_claude, is_off_thread
from hosted_agentperf.schema import MODEL_PINNED, REQUEST_COLUMNS


def _load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def _common_prefix(left: str, right: str) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def _num(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _diff(end, start):
    end_n = _num(end)
    start_n = _num(start)
    if end_n is None or start_n is None:
        return None
    return end_n - start_n


def _prefer(*values):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        return value
    return None


def join_records(
    proxy_rows: list[dict],
    otel_spans: list[dict],
    otel_logs: list[dict] | None = None,
    bodies: dict[str, str] | None = None,
    meta: dict | None = None,
) -> list[dict]:
    """Return section 7.1 rows keyed by request_id.

    Proxy rows are the spine. A span or log with a request id the proxy did
    not see is kept as its own row so a retry the proxy missed is not dropped.
    """
    meta = meta or {}
    bodies = bodies or {}
    logs = otel_logs or []
    spans_by_id: dict[str, dict] = {}
    for span in otel_spans:
        request_id = str(span.get("request_id") or "").strip()
        if request_id:
            spans_by_id[request_id] = span
    logs_by_id: dict[str, list[dict]] = {}
    for record in logs:
        request_id = str(record.get("request_id") or "").strip()
        if request_id:
            logs_by_id.setdefault(request_id, []).append(record)

    seen: set[str] = set()
    joined: list[dict] = []
    for proxy in proxy_rows:
        request_id = str(proxy.get("request_id") or "").strip()
        if request_id:
            seen.add(request_id)
        joined.append(
            _merge_one(
                proxy,
                spans_by_id.get(request_id, {}),
                logs_by_id.get(request_id, []),
                meta,
            )
        )
    for request_id, span in spans_by_id.items():
        if request_id in seen:
            continue
        joined.append(_merge_one({}, span, logs_by_id.get(request_id, []), meta))

    _attach_prefix(joined, bodies)
    _relative_clock(joined)
    for row in joined:
        _derive(row)
        row["failure_class"] = classify_claude(row) or row.get("failure_class") or ""
        off = is_off_thread(row.get("query_source"))
        row["off_thread"] = "" if off is None else int(off)
    return joined


def join_directory(run_dir: Path, out_path: Path | None = None) -> list[dict]:
    run_dir = Path(run_dir)
    proxy_rows = _load_jsonl(run_dir / "proxy" / "requests.jsonl")
    spans = [
        row
        for row in _load_jsonl(run_dir / "otel" / "events.jsonl")
        if row.get("record_kind") == "span" and row.get("span_name") == "claude_code.llm_request"
    ]
    logs = [
        row
        for row in _load_jsonl(run_dir / "otel" / "events.jsonl")
        if row.get("record_kind") == "log"
    ]
    index_rows = _load_jsonl(run_dir / "bodies" / "index.jsonl")
    bodies = _read_bodies(run_dir, proxy_rows, index_rows)
    meta = {}
    meta_path = run_dir / "run_meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    _apply_cell_windows(proxy_rows, _load_jsonl(run_dir / "cells.jsonl"))
    rows = join_records(proxy_rows, spans, logs, bodies, meta)
    destination = out_path or (run_dir / "requests.csv")
    write_csv(destination, rows, REQUEST_COLUMNS)
    return rows


def _apply_cell_windows(proxy_rows: list[dict], cells: list[dict]) -> None:
    if not cells:
        return
    for proxy in proxy_rows:
        if proxy.get("cell"):
            continue
        stamp = _num(proxy.get("t_send_unix_ms"))
        body = ""
        path = proxy.get("body_path")
        if path and Path(str(path)).is_file():
            body = Path(str(path)).read_text(encoding="utf-8", errors="replace")
        matches = []
        for cell in cells:
            start = _num(cell.get("t_start_unix_ms"))
            end = _num(cell.get("t_end_unix_ms"))
            if stamp is None or start is None or end is None:
                continue
            if stamp < start - 1000 or stamp > end + 5000:
                continue
            nonce = str(cell.get("nonce") or "")
            if nonce and nonce not in body and body:
                continue
            matches.append(cell)
        if not matches and stamp is not None:
            matches = [
                cell
                for cell in cells
                if _num(cell.get("t_start_unix_ms")) is not None
                and _num(cell.get("t_end_unix_ms")) is not None
                and _num(cell["t_start_unix_ms"]) - 1000
                <= stamp
                <= _num(cell["t_end_unix_ms"]) + 5000
            ]
        if len(matches) == 1 or (matches and body):
            chosen = max(matches, key=lambda cell: _num(cell.get("t_start_unix_ms")) or 0)
            for key in ("phase", "cell", "block", "rep", "session_id"):
                if chosen.get(key) not in (None, ""):
                    proxy[key] = chosen[key]


def _read_bodies(run_dir: Path, proxy_rows: list[dict], index_rows: list[dict]) -> dict[str, str]:
    found: dict[str, str] = {}
    for proxy in proxy_rows:
        request_id = str(proxy.get("request_id") or "")
        path = proxy.get("body_path")
        if request_id and path and Path(str(path)).is_file():
            found[request_id] = Path(str(path)).read_text(encoding="utf-8", errors="replace")
    for item in index_rows:
        request_id = str(item.get("request_id") or "")
        name = item.get("request_file") or item.get("request_path")
        if not request_id or not name or request_id in found:
            continue
        path = Path(str(name))
        if not path.is_file():
            path = run_dir / "bodies" / Path(str(name)).name
        if path.is_file():
            found[request_id] = path.read_text(encoding="utf-8", errors="replace")
    return found


def _merge_one(proxy: dict, span: dict, logs: list[dict], meta: dict) -> dict:
    query_source = _prefer(
        _log_attr(logs, "query_source"),
        span.get("query_source"),
        span.get("query_source_safe"),
        proxy.get("query_source"),
    )
    retries = any(
        str(record.get("event_name") or record.get("event.name") or "") == "api_retries_exhausted"
        or str(record.get("event_name") or "") == "claude_code.api_retries_exhausted"
        for record in logs
    )
    error_class = _prefer(span.get("error_class"), _log_attr(logs, "error_class"))
    error_text = _prefer(_log_attr(logs, "error"), _log_attr(logs, "error_message"))
    row = {
        "target": _prefer(proxy.get("target"), meta.get("target"), "claude_code"),
        "phase": _prefer(proxy.get("phase"), meta.get("phase"), "0"),
        "cell": proxy.get("cell", ""),
        "block": _prefer(proxy.get("block"), meta.get("block"), "pilot"),
        "rep": proxy.get("rep", ""),
        "agent_version": _prefer(proxy.get("agent_version"), meta.get("agent_version")),
        "model_pinned": _prefer(proxy.get("model_pinned"), meta.get("model_pinned"), MODEL_PINNED),
        "model_served": _prefer(proxy.get("model"), span.get("model")),
        "effort": _prefer(span.get("effort"), meta.get("effort")),
        "speed": span.get("speed", ""),
        "session_id": _prefer(proxy.get("session_id"), _log_attr(logs, "session_id"), span.get("session_id")),
        "turn_index": proxy.get("turn_index", ""),
        "query_source": query_source or "",
        "request_id": _prefer(proxy.get("request_id"), span.get("request_id")),
        "attempt": _prefer(span.get("attempt"), proxy.get("attempt")),
        "http_status": _prefer(proxy.get("http_status"), span.get("status_code")),
        "t_send": proxy.get("t_send_mono_ms", ""),
        "t_headers": proxy.get("t_headers_mono_ms", ""),
        "t_message_start": proxy.get("t_message_start_mono_ms", ""),
        "t_first_delta": proxy.get("t_first_delta_mono_ms", ""),
        "t_first_text": proxy.get("t_first_text_mono_ms", ""),
        "t_last_delta": proxy.get("t_last_delta_mono_ms", ""),
        "t_message_stop": proxy.get("t_message_stop_mono_ms", ""),
        "ttft_ms_otel": span.get("ttft_ms", ""),
        "first_content_ms_otel": span.get("first_content_ms", ""),
        "duration_ms_otel": span.get("duration_ms", ""),
        "input_tokens": _prefer(proxy.get("input_tokens"), span.get("input_tokens")),
        "cache_creation_tokens": _prefer(proxy.get("cache_creation_tokens"), span.get("cache_creation_tokens")),
        "cache_creation_5m": _prefer(proxy.get("cache_creation_5m"), span.get("cache_creation_5m_tokens")),
        "cache_creation_1h": _prefer(proxy.get("cache_creation_1h"), span.get("cache_creation_1h_tokens")),
        "cache_read_tokens": _prefer(proxy.get("cache_read_tokens"), span.get("cache_read_tokens")),
        "output_tokens": _prefer(proxy.get("output_tokens"), span.get("output_tokens")),
        "stop_reason": _prefer(proxy.get("stop_reason"), span.get("stop_reason")),
        "has_tool_call": proxy.get("has_tool_call", ""),
        "n_tool_calls": proxy.get("n_tool_calls", ""),
        "prefix_shared_chars": "",
        "failure_class": "",
        "error_class": error_class or "",
        "error_text": error_text or "",
        "retries_exhausted": retries,
        "saw_message_stop": proxy.get("saw_message_stop", ""),
        "streaming": proxy.get("streaming", ""),
        "stream_cut": proxy.get("stream_cut", ""),
        "_session_for_prefix": _prefer(proxy.get("session_id"), _log_attr(logs, "session_id")) or "",
        "_body_request_id": str(_prefer(proxy.get("request_id"), span.get("request_id")) or ""),
        "_t_send_mono": proxy.get("t_send_mono_ms", ""),
    }
    return row


def _log_attr(logs: list[dict], key: str):
    for record in logs:
        if record.get(key) not in (None, ""):
            return record.get(key)
    return None


def _attach_prefix(rows: list[dict], bodies: dict[str, str]) -> None:
    order = sorted(
        rows,
        key=lambda row: (
            str(row.get("_session_for_prefix") or ""),
            _num(row.get("_t_send_mono")) or 0,
        ),
    )
    previous: dict[str, str] = {}
    for row in order:
        session = str(row.get("_session_for_prefix") or "")
        request_id = str(row.get("_body_request_id") or "")
        body = bodies.get(request_id)
        if session and body is not None and session in previous:
            row["prefix_shared_chars"] = _common_prefix(previous[session], body)
        if session and body is not None:
            previous[session] = body


def _relative_clock(rows: list[dict]) -> None:
    stamps = []
    for row in rows:
        for key in (
            "t_send",
            "t_headers",
            "t_message_start",
            "t_first_delta",
            "t_first_text",
            "t_last_delta",
            "t_message_stop",
        ):
            value = _num(row.get(key))
            if value is not None:
                stamps.append(value)
    if not stamps:
        return
    origin = min(stamps)
    for row in rows:
        for key in (
            "t_send",
            "t_headers",
            "t_message_start",
            "t_first_delta",
            "t_first_text",
            "t_last_delta",
            "t_message_stop",
        ):
            value = _num(row.get(key))
            if value is not None:
                row[key] = value - origin


def _derive(row: dict) -> None:
    input_tokens = as_int(row.get("input_tokens"))
    creation = as_int(row.get("cache_creation_tokens"))
    cached = as_int(row.get("cache_read_tokens"))
    output_tokens = as_int(row.get("output_tokens"))
    if input_tokens is None or creation is None or cached is None:
        prompt = None
        new = None
    else:
        new = input_tokens + creation
        prompt = new + cached
    row["new_tokens"] = "" if new is None else new
    row["prompt_tokens"] = "" if prompt is None else prompt
    if prompt and cached is not None:
        row["cache_ratio"] = cached / prompt
    else:
        row["cache_ratio"] = ""
    row["ttft_ms"] = _blank_diff(row.get("t_first_delta"), row.get("t_send"))
    row["ttft_text_ms"] = _blank_diff(row.get("t_first_text"), row.get("t_send"))
    window = _diff(row.get("t_last_delta"), row.get("t_first_delta"))
    row["decode_window_ms"] = "" if window is None else window
    if window is not None and window > 0 and output_tokens is not None and output_tokens >= 2:
        row["decode_tps"] = 1000.0 * (output_tokens - 1) / window
    else:
        row["decode_tps"] = ""
    row["turn_ms"] = _blank_diff(row.get("t_message_stop"), row.get("t_send"))
    ttft = as_float(row.get("ttft_ms"))
    first = as_float(row.get("first_content_ms_otel"))
    if ttft is None or first is None:
        row["proxy_offset_ms"] = ""
    else:
        row["proxy_offset_ms"] = ttft - first
    tool_count = as_int(row.get("n_tool_calls"))
    if tool_count is None:
        row["has_tool_call"] = row.get("has_tool_call") or ""
    else:
        row["has_tool_call"] = 1 if tool_count > 0 else 0
        row["n_tool_calls"] = tool_count


def _blank_diff(end, start):
    value = _diff(end, start)
    return "" if value is None else value


def _off_thread_cell(row: dict) -> str:
    value = row.get("off_thread")
    if value is None or value == "":
        return ""
    return str(value).strip()


def regression_rows(rows: list[dict]) -> list[dict]:
    """Rows that enter the C0–C3 quantile fit.

    Off-thread and unknown query source stay out. Failures stay out.
    """
    kept = []
    for row in rows:
        cell = str(row.get("cell") or "")
        if not (cell.startswith("C0") or cell.startswith("C1") or cell.startswith("C2") or cell.startswith("C3")):
            continue
        if str(row.get("failure_class") or "").strip():
            continue
        if _off_thread_cell(row) != "0":
            continue
        if as_float(row.get("ttft_ms")) is None:
            continue
        if as_float(row.get("new_tokens")) is None or as_float(row.get("cache_read_tokens")) is None:
            continue
        kept.append(
            {
                "cell": cell,
                "block": str(row.get("block") or ""),
                "new_tokens": float(row["new_tokens"]),
                "cache_read_tokens": float(row["cache_read_tokens"]),
                "ttft_ms": float(row["ttft_ms"]),
                "output_tokens": as_float(row.get("output_tokens")),
                "decode_window_ms": as_float(row.get("decode_window_ms")),
                "decode_tps": as_float(row.get("decode_tps")),
                "ttft_text_ms": as_float(row.get("ttft_text_ms")),
                "t_first_text": row.get("t_first_text"),
                "cache_ratio": as_float(row.get("cache_ratio")),
                "turn_index": row.get("turn_index"),
                "failure_class": row.get("failure_class") or "",
            }
        )
    return kept
