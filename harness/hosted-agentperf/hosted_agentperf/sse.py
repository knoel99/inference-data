"""Incremental Anthropic SSE parser.

Chunk arrival times are recorded by the caller before ``feed``. The parser
keeps only the incomplete trailing event so a split line can be recognized.
That residue is not a buffered response: completed events are reduced to the
timestamps and usage fields the joiner needs, and the bytes are not retained.
"""

from __future__ import annotations

import json
from typing import Any


def _usage_fields(usage: dict | None) -> dict[str, Any]:
    if not isinstance(usage, dict):
        return {}
    creation = usage.get("cache_creation")
    if not isinstance(creation, dict):
        creation = {}
    return {
        "input_tokens": usage.get("input_tokens"),
        "cache_creation_tokens": usage.get("cache_creation_input_tokens"),
        "cache_read_tokens": usage.get("cache_read_input_tokens"),
        "cache_creation_5m": creation.get("ephemeral_5m_input_tokens"),
        "cache_creation_1h": creation.get("ephemeral_1h_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
    }


class SseAssembler:
    """Parse an SSE byte stream that arrives in arbitrary pieces."""

    def __init__(self, max_residue: int = 16 * 1024 * 1024) -> None:
        self._residue = bytearray()
        self.max_residue = max_residue
        self.overflow = False
        self.n_fragments = 0
        self.n_events = 0
        self.model: str | None = None
        self.stop_reason: str | None = None
        self.message_id: str | None = None
        self.usage_start: dict[str, Any] = {}
        self.usage_final: dict[str, Any] = {}
        self.t_message_start: float | None = None
        self.t_first_delta: float | None = None
        self.t_first_text: float | None = None
        self.t_last_delta: float | None = None
        self.t_message_stop: float | None = None
        self.n_tool_calls = 0
        self.saw_message_stop = False
        self.parse_errors = 0

    def feed(self, chunk: bytes, ts_ms: float) -> None:
        if not chunk:
            return
        self.n_fragments += 1
        self._residue.extend(chunk)
        if len(self._residue) > self.max_residue:
            self.overflow = True
            # Keep a tail so a later delimiter can resynchronize, but do not
            # hold the response.
            del self._residue[:-4096]
        while True:
            separator, length = _find_event_separator(self._residue)
            if separator < 0:
                return
            raw = bytes(self._residue[:separator])
            del self._residue[: separator + length]
            self._consume_event(raw, ts_ms)

    def finish(self, ts_ms: float) -> None:
        """Flush a last event that ended without a trailing blank line."""
        if not self._residue.strip():
            self._residue.clear()
            return
        raw = bytes(self._residue)
        self._residue.clear()
        if raw.endswith(b"\n"):
            self._consume_event(raw, ts_ms)

    def merged_usage(self) -> dict[str, Any]:
        merged = dict(self.usage_start)
        for key, value in self.usage_final.items():
            if value is not None:
                merged[key] = value
        return merged

    def _consume_event(self, raw: bytes, ts_ms: float) -> None:
        payload = _data_payload(raw)
        if payload is None or payload in {b"", b"[DONE]"}:
            return
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            self.parse_errors += 1
            return
        if not isinstance(event, dict):
            return
        self.n_events += 1
        kind = event.get("type")
        if kind == "message_start":
            self.t_message_start = self.t_message_start if self.t_message_start is not None else ts_ms
            message = event.get("message")
            if isinstance(message, dict):
                if isinstance(message.get("model"), str):
                    self.model = message["model"]
                if isinstance(message.get("id"), str):
                    self.message_id = message["id"]
                self.usage_start = _usage_fields(message.get("usage"))
        elif kind == "content_block_start":
            block = event.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self.n_tool_calls += 1
        elif kind == "content_block_delta":
            if self.t_first_delta is None:
                self.t_first_delta = ts_ms
            self.t_last_delta = ts_ms
            delta = event.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "text_delta":
                if self.t_first_text is None:
                    self.t_first_text = ts_ms
        elif kind == "message_delta":
            delta = event.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("stop_reason"), str):
                self.stop_reason = delta["stop_reason"]
            fields = _usage_fields(event.get("usage"))
            if fields:
                self.usage_final.update(fields)
        elif kind == "message_stop":
            self.t_message_stop = ts_ms
            self.saw_message_stop = True


def _find_event_separator(buf: bytearray) -> tuple[int, int]:
    for marker in (b"\r\n\r\n", b"\n\n"):
        index = buf.find(marker)
        if index >= 0:
            return index, len(marker)
    return -1, 0


def _data_payload(raw: bytes) -> bytes | None:
    text = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    data_lines: list[bytes] = []
    for line in text.split(b"\n"):
        if line.startswith(b"data:"):
            data_lines.append(line[5:].lstrip(b" "))
        elif line == b"data":
            data_lines.append(b"")
    if not data_lines:
        return None
    return b"\n".join(data_lines)
