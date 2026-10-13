"""The HTTP client an agent uses to call the next agent over A2A.

One place to build it, because three concerns ride on every downstream call
and each is switched on by a different lab:

* identity (lab 82) — ``DOWNSTREAM_AUTH``: attach a token for the next hop
* tracing  (lab 83) — ``TRACE_PROPAGATION``: attach ``traceparent``
* loops    (lab 85) — ``A2A_MAX_HOPS``: attach the delegation trail
* cancel   (lab 81) — the propagated ``CancelTask`` must go out with both

``RemoteA2aAgent`` takes this client for the normal conversation, and
``common.cancellation`` reuses it for the cancel it forwards.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from common.config import Settings, get_settings
from common.hops import add_trail
from common.identity import TokenExchanger, make_downstream_auth_hook
from common.tracing import inject_trace_headers


@lru_cache(maxsize=1)
def _exchanger() -> TokenExchanger | None:
    settings = get_settings()
    if not (settings.sts_client_id and settings.sts_client_secret):
        return None
    return TokenExchanger(
        settings.sts_url,
        client_id=settings.sts_client_id,
        client_secret=settings.sts_client_secret,
    )


def request_hooks(audience: str, settings: Settings | None = None) -> list[Any]:
    settings = settings or get_settings()
    hooks: list[Any] = []
    if settings.trace_propagation:
        hooks.append(inject_trace_headers)
    if settings.max_hops:
        hooks.append(add_trail)
    auth = make_downstream_auth_hook(
        settings.downstream_auth, audience=audience, exchanger=_exchanger()
    )
    if auth is not None:
        hooks.append(auth)
    return hooks


def make_downstream_client(audience: str, *, timeout: float = 900.0) -> httpx.AsyncClient | None:
    """An httpx client with the configured hooks, or None when none are on.

    None lets ``RemoteA2aAgent`` build its own client exactly as it did before
    any of this existed, so the default path is untouched.
    """
    hooks = request_hooks(audience)
    if not hooks:
        return None
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=10.0),
        event_hooks={"request": hooks},
    )


async def load_card(source: str) -> dict[str, Any]:
    """Reads an Agent Card from a file path or an http(s) URL."""
    if source.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.get(source)
            resp.raise_for_status()
            return resp.json()
    return json.loads(Path(source).read_text())


def rpc_url_from_card(card: dict[str, Any]) -> str:
    """The JSON-RPC URL a card advertises, in either card generation."""
    for iface in card.get("supportedInterfaces") or []:
        if iface.get("url") and (iface.get("protocolBinding") or "JSONRPC") == "JSONRPC":
            return iface["url"]
    if card.get("url"):
        return card["url"]
    raise ValueError(f"card {card.get('name')!r} advertises no JSON-RPC URL")


def surface_downstream_error(callback_context: Any) -> Any:
    """``after_agent_callback`` for a ``RemoteA2aAgent``: say why the call failed.

    When the next agent answers with a JSON-RPC error (a refused token in lab
    82, a refused loop in lab 85), ADK's ``RemoteA2aAgent`` logs it and records
    an event that has ``error_message`` but no content and no ``error_code``.
    The A2A server turns that into a COMPLETED task with no text: the caller
    learns nothing. Returning the reason as content makes it the remote agent's
    answer, so it reaches the user.
    """
    from google.genai import types

    session = callback_context.session
    for event in reversed(session.events):
        if event.invocation_id != callback_context.invocation_id:
            break
        mine = event.author == callback_context.agent_name
        if mine and event.error_message and not event.content:
            reason = event.error_message.removeprefix("A2A request failed: ")
            return types.Content(
                role="model",
                parts=[
                    types.Part(
                        text=f"{callback_context.agent_name} could not take this request: {reason}"
                    )
                ],
            )
    return None
