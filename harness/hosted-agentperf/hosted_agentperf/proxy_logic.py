"""Per-request capture state for the mitmproxy addon.

The addon calls these methods from the streaming hooks. Each response chunk
is timestamped by the caller and forwarded immediately. This module does not
import mitmproxy, so the tests can drive it with bytes.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from hosted_agentperf.sse import SseAssembler

MESSAGES_PATH_MARK = "/v1/messages"


def mono_ms() -> float:
    return time.monotonic() * 1000.0


def unix_ms() -> float:
    return time.time() * 1000.0


class ProxyCapture:
    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "bodies").mkdir(parents=True, exist_ok=True)
        self.requests_path = self.directory / "requests.jsonl"
        self.fragments_path = self.directory / "fragments.jsonl"
        self.connections_path = self.directory / "connections.jsonl"
        self._flows: dict[str, dict] = {}
        self._connections: dict[str, dict] = {}

    def note_connection(self, conn_id: str, field: str, ts_mono: float, ts_unix: float) -> None:
        row = self._connections.setdefault(conn_id, {"conn_id": conn_id})
        row[field + "_mono_ms"] = ts_mono
        row[field + "_unix_ms"] = ts_unix
        self._append(self.connections_path, {"conn_id": conn_id, "event": field, "mono_ms": ts_mono, "unix_ms": ts_unix})

    def is_messages(self, path: str, host: str) -> bool:
        return MESSAGES_PATH_MARK in (path or "")

    def start_request(self, flow_id: str, method: str, path: str, host: str) -> dict:
        state = self._flows.setdefault(
            flow_id,
            {
                "flow_id": flow_id,
                "method": method,
                "path": path,
                "host": host,
                "is_messages": self.is_messages(path, host),
                "assembler": SseAssembler(),
            },
        )
        return state

    def request_headers(self, flow_id: str, ts_mono: float) -> None:
        state = self._flows[flow_id]
        state["t_request_headers_mono_ms"] = ts_mono

    def request_chunk(self, flow_id: str, chunk: bytes, ts_mono: float) -> None:
        state = self._flows[flow_id]
        state["t_send_mono_ms"] = ts_mono
        state["t_send_unix_ms"] = unix_ms()
        if not state.get("is_messages"):
            return
        path = self.directory / "bodies" / f"{flow_id}.request.bin"
        with path.open("ab") as handle:
            handle.write(chunk)
            handle.flush()
        state["body_path"] = str(path)
        self._fragment(flow_id, "request", ts_mono, len(chunk))

    def request_done(self, flow_id: str, ts_mono: float, ts_unix: float, header_request_id: str) -> None:
        state = self._flows[flow_id]
        state.setdefault("t_send_mono_ms", ts_mono)
        state.setdefault("t_send_unix_ms", ts_unix)
        if header_request_id:
            state["client_request_id"] = header_request_id

    def response_headers(
        self,
        flow_id: str,
        status: int,
        request_id: str,
        content_type: str,
        ts_mono: float,
        conn_id: str,
    ) -> None:
        state = self._flows[flow_id]
        state["t_headers_mono_ms"] = ts_mono
        state["http_status"] = status
        state["request_id"] = request_id
        state["content_type"] = content_type
        state["streaming"] = "text/event-stream" in content_type.lower() or state.get("is_messages", False)
        if conn_id and conn_id in self._connections:
            state["connection"] = dict(self._connections[conn_id])

    def response_chunk(self, flow_id: str, chunk: bytes, ts_mono: float) -> None:
        state = self._flows[flow_id]
        self._fragment(flow_id, "response", ts_mono, len(chunk))
        if state.get("is_messages"):
            state["assembler"].feed(chunk, ts_mono)

    def response_done(self, flow_id: str, ts_mono: float) -> dict:
        state = self._flows[flow_id]
        assembler: SseAssembler = state["assembler"]
        assembler.finish(ts_mono)
        row = self._row(state, stream_cut=bool(state.get("is_messages")) and not assembler.saw_message_stop and state.get("http_status") == 200)
        if state.get("is_messages"):
            self._append(self.requests_path, row)
        return row

    def error(self, flow_id: str, message: str, ts_mono: float) -> dict:
        state = self._flows.get(flow_id) or {"flow_id": flow_id, "assembler": SseAssembler(), "is_messages": True}
        state["error_text"] = message
        assembler: SseAssembler = state["assembler"]
        assembler.finish(ts_mono)
        row = self._row(state, stream_cut=True)
        row["error_text"] = message
        if state.get("is_messages", True):
            self._append(self.requests_path, row)
        return row

    def _row(self, state: dict, stream_cut: bool) -> dict:
        assembler: SseAssembler = state["assembler"]
        usage = assembler.merged_usage()
        tool_calls = assembler.n_tool_calls
        return {
            "flow_id": state.get("flow_id"),
            "request_id": state.get("request_id") or "",
            "client_request_id": state.get("client_request_id") or "",
            "http_status": state.get("http_status"),
            "host": state.get("host"),
            "path": state.get("path"),
            "content_type": state.get("content_type"),
            "streaming": bool(state.get("streaming")),
            "t_send_mono_ms": state.get("t_send_mono_ms"),
            "t_send_unix_ms": state.get("t_send_unix_ms"),
            "t_headers_mono_ms": state.get("t_headers_mono_ms"),
            "t_message_start_mono_ms": assembler.t_message_start,
            "t_first_delta_mono_ms": assembler.t_first_delta,
            "t_first_text_mono_ms": assembler.t_first_text,
            "t_last_delta_mono_ms": assembler.t_last_delta,
            "t_message_stop_mono_ms": assembler.t_message_stop,
            "model": assembler.model,
            "message_id": assembler.message_id,
            "stop_reason": assembler.stop_reason,
            "input_tokens": usage.get("input_tokens"),
            "cache_creation_tokens": usage.get("cache_creation_tokens"),
            "cache_creation_5m": usage.get("cache_creation_5m"),
            "cache_creation_1h": usage.get("cache_creation_1h"),
            "cache_read_tokens": usage.get("cache_read_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "n_tool_calls": tool_calls,
            "has_tool_call": 1 if tool_calls else 0,
            "saw_message_stop": assembler.saw_message_stop,
            "stream_cut": stream_cut,
            "sse_events": assembler.n_events,
            "sse_fragments": assembler.n_fragments,
            "sse_parse_errors": assembler.parse_errors,
            "sse_overflow": assembler.overflow,
            "body_path": state.get("body_path"),
            "connection": state.get("connection"),
            "phase": state.get("phase"),
            "cell": state.get("cell"),
            "block": state.get("block"),
            "rep": state.get("rep"),
        }

    def _fragment(self, flow_id: str, direction: str, ts_mono: float, size: int) -> None:
        self._append(
            self.fragments_path,
            {
                "flow_id": flow_id,
                "direction": direction,
                "mono_ms": ts_mono,
                "bytes": size,
            },
        )

    def _append(self, path: Path, row: dict) -> None:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")
            handle.flush()
