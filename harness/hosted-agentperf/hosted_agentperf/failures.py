"""Failure taxonomy from protocol section 5.7.

One row is one attempt. Quota refusals are E5 even when the status is 429,
so they are not also counted as E1. A successful off-thread request is E6:
the harness was supposed to keep a single main-thread stream. A provider
error on an off-thread request stays E1 or E5; ``off_thread`` still flags it.
"""

from __future__ import annotations

from hosted_agentperf.schema import MAIN_THREAD_SOURCES


def is_off_thread(query_source: str | None) -> bool | None:
    """Return True, False, or None when the source was not observed."""
    if query_source is None:
        return None
    text = str(query_source).strip()
    if text == "":
        return None
    return text not in MAIN_THREAD_SOURCES


def _quota_text(*parts: str | None) -> bool:
    blob = " ".join(part.lower() for part in parts if part)
    markers = (
        "usage",
        "quota",
        "credit",
        "spend limit",
        "rate_limit",
        "ratelimit",
        "insufficient",
    )
    return any(marker in blob for marker in markers)


def classify_claude(row: dict) -> str:
    status = _status(row.get("http_status"))
    error_class = _text(row.get("error_class"))
    stop = _text(row.get("stop_reason"))
    cell = _text(row.get("cell"))
    notes = _text(row.get("error_text"))
    retries_exhausted = _truthy(row.get("retries_exhausted"))
    saw_stop = row.get("saw_message_stop")
    streaming = row.get("streaming")
    model_pinned = _text(row.get("model_pinned"))
    model_served = _text(row.get("model_served"))
    speed = _text(row.get("speed"))
    off_thread = is_off_thread(row.get("query_source"))

    if status == 429 and _quota_text(error_class, notes):
        return "E5"
    if error_class in {"usage_limit", "quota", "rate_limit_usage"}:
        return "E5"
    if retries_exhausted:
        return "E2"
    if status in {429, 500, 529}:
        return "E1"
    if status is not None and status >= 500:
        return "E1"
    cut = streaming is True and saw_stop is False and status == 200
    watchdog = any(token in error_class for token in ("timeout", "watchdog", "stream_idle"))
    if cut or watchdog or _truthy(row.get("stream_cut")):
        return "E3"
    intentional_cap = cell == "max_output" or cell.startswith("D")
    if stop == "max_tokens" and not intentional_cap:
        return "E4"
    if model_pinned and model_served and model_pinned != model_served:
        return "E6"
    if speed == "fast":
        return "E6"
    if off_thread is True:
        return "E6"
    return ""


def classify_cursor(status: str | None, error_code: str | None) -> str:
    state = _text(status).upper()
    error = _text(error_code)
    if _quota_text(state, error) or "RATELIMIT" in error.upper():
        return "E5"
    if state in {"EXPIRED"}:
        return "E3"
    if state in {"ERROR", "FAILED"} or error:
        if state in {"FINISHED", "COMPLETED", "IDLE"} and not error:
            return ""
        if error or state in {"ERROR", "FAILED"}:
            return "E2"
    return ""


def _text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _status(value) -> int | None:
    text = _text(value)
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return _text(value).lower() in {"1", "true", "yes"}
