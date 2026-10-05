"""One trace across the A2A hop.

ADK already emits OpenTelemetry spans for every agent run, model call and tool
call, and exports them over OTLP as soon as ``OTEL_EXPORTER_OTLP_ENDPOINT`` is
set. What it does not do is carry the trace *across* the hop: the concierge's
outbound JSON-RPC call has no ``traceparent`` header, and the specialist would
not read one anyway. Turn on the exporter alone and a collector shows two
unrelated traces for one release — the "why is this slow?" question cannot be
answered, because the slow part is in a trace nobody linked.

``TRACE_PROPAGATION=1`` closes the gap from both sides, using nothing but the
OpenTelemetry API that ADK already depends on:

``TraceContextMiddleware``  server side: opens a SERVER span for each
                            ``/a2a/…`` request, as a child of the caller's
                            ``traceparent`` when one arrived.
``inject_trace_headers``    client side: an httpx request hook that writes the
                            current span's ``traceparent`` onto the outbound A2A
                            call.

Context crosses into the agent run the same way the identity token does (see
``common.identity``): a2a-sdk starts the run inside the request, and asyncio
copies the active context into it, so ADK's own spans become children of the
SERVER span.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

_TRACER = trace.get_tracer("adk-a2a-poc.a2a")


def otel_export_enabled() -> bool:
    return bool(
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        or os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
    )


class TraceContextMiddleware:
    """SERVER span per A2A request; parented on the caller when ``extract``."""

    def __init__(self, app: Any, *, agent: str, extract: bool):
        self.app = app
        self._agent = agent
        self._extract = extract

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/a2a/"):
            await self.app(scope, receive, send)
            return
        parent = None
        if self._extract:
            carrier = {
                k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers") or []
            }
            parent = propagate.extract(carrier)

        status_holder: dict[str, int] = {}

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        with _TRACER.start_as_current_span(
            f"A2A {scope['method']} {scope['path']}",
            context=parent,
            kind=SpanKind.SERVER,
            attributes={
                "a2a.agent": self._agent,
                "http.request.method": scope["method"],
                "url.path": scope["path"],
            },
        ) as span:
            await self.app(scope, receive, send_wrapper)
            status = status_holder.get("status", 0)
            span.set_attribute("http.response.status_code", status)
            if status >= 500:
                span.set_status(Status(StatusCode.ERROR))


async def inject_trace_headers(request: httpx.Request) -> None:
    """httpx request hook: put the active span's ``traceparent`` on the wire."""
    propagate.inject(request.headers)
