"""Loops (lab 85): refuse a delegation that comes back around, or goes too deep.

An agent that delegates to "whoever handles releases" trusts a card to say who
that is. Point two agents' cards at each other (a typo, a stale registry entry,
two teams each configuring the other as the specialist) and a single request
bounces A → B → A → B … Each hop opens a new task, holds a connection and an
LLM turn, and waits on the next one. Nothing in A2A stops it: every hop is a
valid request.

The guard here travels like ``traceparent`` (lab 83): every outbound A2A call
carries the delegation trail so far, the names of the agents the request has
already passed through, oldest first::

    X-A2A-Trail: ops_concierge,deployment_agent

An agent receiving a request refuses it when its own name is already in the
trail (a cycle) or when the trail is already ``A2A_MAX_HOPS`` long (a chain
deeper than anyone intended). The refusal is a JSON-RPC error, so the calling
agent ends its turn with a reason instead of waiting forever.

A header keeps it binding-neutral within HTTP and invisible to agents that
ignore it. In a fleet you would standardise it as an A2A extension and carry it
in message metadata, so it survives non-HTTP bindings too.

Switch: ``A2A_MAX_HOPS=<n>`` on every agent (0 = off). The name an agent puts
in the trail is ``A2A_AGENT_ID``, else its app name: two deployments of the same
code are two agents and need two ids.
"""

from __future__ import annotations

import contextvars
import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

TRAIL_HEADER = "x-a2a-trail"
#: JSON-RPC server-defined error range (-32000..-32099).
LOOP_ERROR = -32010
DEPTH_ERROR = -32011

#: The trail for the request being served, including this agent.
_TRAIL: contextvars.ContextVar[tuple[str, ...] | None] = contextvars.ContextVar(
    "a2a_trail", default=None
)


def parse_trail(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


async def add_trail(request: httpx.Request) -> None:
    """httpx request hook: put the trail so far (ending with this agent) on the wire.

    Outside an A2A request (a turn started from the Dev UI, say) there is no
    trail yet and the header is left off; the next agent starts one, so a loop
    is still caught, one hop later.
    """
    trail = _TRAIL.get()
    if trail:
        request.headers[TRAIL_HEADER] = ",".join(trail)


class HopGuardMiddleware:
    """Refuses cycles and over-deep chains on the A2A endpoint; records the trail."""

    def __init__(self, app: Any, *, agent: str, max_hops: int):
        self.app = app
        self._agent = agent
        self._max = max_hops

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/a2a/"):
            await self.app(scope, receive, send)
            return
        raw = ""
        for k, v in scope.get("headers") or []:
            if k.decode("latin-1").lower() == TRAIL_HEADER:
                raw = v.decode("latin-1")
        trail = parse_trail(raw)

        if self._agent in trail:
            path = " → ".join([*trail, self._agent])
            logger.warning("refusing a delegation loop: %s", path)
            await _refuse(
                send,
                LOOP_ERROR,
                f"Delegation loop: {self._agent} is already in this request's trail ({path}).",
                trail,
            )
            return
        if len(trail) >= self._max:
            path = " → ".join([*trail, self._agent])
            logger.warning("refusing a chain deeper than %d hops: %s", self._max, path)
            await _refuse(
                send,
                DEPTH_ERROR,
                f"Delegation too deep: {len(trail) + 1} hops, "
                f"the limit here is {self._max} ({path}).",
                trail,
            )
            return

        token = _TRAIL.set((*trail, self._agent))
        try:
            await self.app(scope, receive, send)
        finally:
            _TRAIL.reset(token)


async def _refuse(send: Any, code: int, message: str, trail: list[str]) -> None:
    # The id is unknown without reading the body; null is what JSON-RPC uses
    # when the request could not be processed far enough to know it.
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": code, "message": message, "data": {"trail": trail}},
        }
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
