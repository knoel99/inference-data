"""mitmproxy addon: timestamp each SSE chunk without buffering the body.

Load it with mitmdump, not mitmweb. The stream callback is installed in
``responseheaders`` / ``requestheaders``, which is the point at which
mitmproxy still has not buffered the body. Each chunk is timestamped and
returned unchanged.

    mitmdump --listen-host 127.0.0.1 --listen-port 8080 \\
        --set confdir="$HARNESS_WORK/mitmproxy-ca" \\
        -s proxy/sse_timestamp.py

Writes under ``$HARNESS_PROXY_DIR`` (default ``./proxy-capture``):
``fragments.jsonl`` (one line per chunk), ``requests.jsonl`` (one line per
``/v1/messages`` exchange), ``connections.jsonl``, and request bodies.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mitmproxy import ctx  # noqa: E402

from hosted_agentperf.proxy_logic import ProxyCapture, mono_ms, unix_ms  # noqa: E402


def _conn_id(obj) -> str:
    server = getattr(obj, "server", None)
    target = server if server is not None else obj
    return str(getattr(target, "id", id(target)))


class SseTimestamp:
    def __init__(self) -> None:
        directory = os.environ.get("HARNESS_PROXY_DIR", "proxy-capture")
        self.capture = ProxyCapture(Path(directory))

    def running(self) -> None:
        ctx.log.info(f"hosted-agentperf SSE capture writing to {self.capture.directory}")

    def server_connect(self, data) -> None:
        self.capture.note_connection(_conn_id(data), "tcp_connect_start", mono_ms(), unix_ms())

    def server_connected(self, data) -> None:
        self.capture.note_connection(_conn_id(data), "tcp_connected", mono_ms(), unix_ms())

    def tls_established_server(self, data) -> None:
        self.capture.note_connection(_conn_id(data), "tls_established", mono_ms(), unix_ms())

    def requestheaders(self, flow) -> None:
        path = flow.request.path or ""
        host = flow.request.host or ""
        if not self.capture.is_messages(path, host):
            return
        state = self.capture.start_request(flow.id, flow.request.method, path, host)
        state["phase"] = os.environ.get("HARNESS_PHASE", "")
        self.capture.request_headers(flow.id, mono_ms())

        def on_request_chunk(data: bytes) -> bytes:
            # Timestamp before any parse. Return the same bytes.
            self.capture.request_chunk(flow.id, data, mono_ms())
            return data

        flow.request.stream = on_request_chunk

    def request(self, flow) -> None:
        if flow.id not in self.capture._flows:
            return
        header_id = flow.request.headers.get("x-client-request-id", "")
        self.capture.request_done(flow.id, mono_ms(), unix_ms(), header_id)

    def responseheaders(self, flow) -> None:
        if flow.id not in self.capture._flows:
            return
        status = flow.response.status_code if flow.response is not None else 0
        request_id = ""
        content_type = ""
        if flow.response is not None:
            request_id = flow.response.headers.get("request-id", "")
            content_type = flow.response.headers.get("content-type", "")
        server = getattr(flow, "server_conn", None)
        conn = str(getattr(server, "id", "")) if server is not None else ""
        self.capture.response_headers(flow.id, status, request_id, content_type, mono_ms(), conn)

        def on_response_chunk(data: bytes) -> bytes:
            self.capture.response_chunk(flow.id, data, mono_ms())
            return data

        if flow.response is not None:
            flow.response.stream = on_response_chunk

    def response(self, flow) -> None:
        if flow.id not in self.capture._flows:
            return
        self.capture.response_done(flow.id, mono_ms())

    def error(self, flow) -> None:
        if flow.id not in self.capture._flows:
            return
        message = str(flow.error) if getattr(flow, "error", None) else "flow error"
        self.capture.error(flow.id, message, mono_ms())


addons = [SseTimestamp()]
