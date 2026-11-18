"""Minimal OTLP/HTTP JSON receiver for Claude Code llm_request spans.

Binds to 127.0.0.1 only. Accepts ``application/json`` on ``/v1/traces`` and
``/v1/logs``. Protobuf is refused so a protocol mismatch is visible instead
of stored as a silent empty file.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def flatten_attributes(items: Any) -> dict[str, Any]:
    if not isinstance(items, list):
        return {}
    flat: dict[str, Any] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if not isinstance(key, str):
            continue
        flat[key] = _value(item.get("value"))
    return flat


def _value(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    for key in ("stringValue", "boolValue"):
        if key in value:
            return value[key]
    if "intValue" in value:
        try:
            return int(value["intValue"])
        except (TypeError, ValueError):
            return value["intValue"]
    if "doubleValue" in value:
        try:
            return float(value["doubleValue"])
        except (TypeError, ValueError):
            return value["doubleValue"]
    if "arrayValue" in value:
        values = value["arrayValue"].get("values", []) if isinstance(value["arrayValue"], dict) else []
        return [_value(item) for item in values]
    return value


def extract_events(payload: dict) -> list[dict]:
    events: list[dict] = []
    for resource in payload.get("resourceSpans") or []:
        if not isinstance(resource, dict):
            continue
        resource_attrs = flatten_attributes((resource.get("resource") or {}).get("attributes"))
        for scope in resource.get("scopeSpans") or []:
            if not isinstance(scope, dict):
                continue
            for span in scope.get("spans") or []:
                if not isinstance(span, dict):
                    continue
                attrs = flatten_attributes(span.get("attributes"))
                events.append(
                    {
                        "record_kind": "span",
                        "span_name": span.get("name"),
                        "trace_id": span.get("traceId"),
                        "span_id": span.get("spanId"),
                        "start_time_unix_nano": span.get("startTimeUnixNano"),
                        "end_time_unix_nano": span.get("endTimeUnixNano"),
                        "status_code": (span.get("status") or {}).get("code") if isinstance(span.get("status"), dict) else None,
                        **resource_attrs,
                        **attrs,
                    }
                )
    for resource in payload.get("resourceLogs") or []:
        if not isinstance(resource, dict):
            continue
        resource_attrs = flatten_attributes((resource.get("resource") or {}).get("attributes"))
        for scope in resource.get("scopeLogs") or []:
            if not isinstance(scope, dict):
                continue
            for record in scope.get("logRecords") or []:
                if not isinstance(record, dict):
                    continue
                attrs = flatten_attributes(record.get("attributes"))
                body = record.get("body")
                events.append(
                    {
                        "record_kind": "log",
                        "event_name": attrs.get("event.name") or attrs.get("event_name"),
                        "time_unix_nano": record.get("timeUnixNano"),
                        "body": _value(body) if isinstance(body, dict) else body,
                        **resource_attrs,
                        **attrs,
                    }
                )
    return events


class Collector:
    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "events.jsonl"
        self.rejected = self.directory / "rejected.log"

    def accept(self, payload: dict) -> int:
        events = extract_events(payload)
        with self.path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, sort_keys=True) + "\n")
            handle.flush()
        return len(events)


def make_handler(collector: Collector):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length else b""
            content_type = self.headers.get("Content-Type", "")
            if self.path not in {"/v1/traces", "/v1/logs"}:
                self._reply(404, b"unknown path\n")
                return
            if "json" not in content_type.lower():
                with collector.rejected.open("a", encoding="utf-8") as handle:
                    handle.write(f"{self.path} content-type={content_type} bytes={length}\n")
                self._reply(415, b"OTLP JSON required\n")
                return
            try:
                payload = json.loads(raw.decode("utf-8") if raw else "{}")
            except json.JSONDecodeError:
                self._reply(400, b"invalid json\n")
                return
            if not isinstance(payload, dict):
                self._reply(400, b"json object required\n")
                return
            count = collector.accept(payload)
            body = json.dumps({"partialSuccess": {}, "accepted": count}).encode("utf-8")
            self._reply(200, body, "application/json")

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _reply(self, status: int, body: bytes, content_type: str = "text/plain") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def serve(directory: Path, host: str = "127.0.0.1", port: int = 4318) -> None:
    collector = Collector(directory)
    server = ThreadingHTTPServer((host, port), make_handler(collector))
    print(f"OTLP JSON collector on http://{host}:{port} writing {collector.path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Local OTLP/HTTP JSON collector")
    parser.add_argument("--dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4318)
    args = parser.parse_args(argv)
    serve(Path(args.dir), args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
