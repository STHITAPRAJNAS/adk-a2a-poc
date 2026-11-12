"""Budgets (lab 89): a token budget that travels with the request.

Lab 85 caps how many agents a request may pass through. It does not cap what
the request costs: a chain of agents, each making a few model calls, spends
tokens nobody owns. A budget fixes that the same way the trail does: it rides
on every outbound A2A call, and each agent charges its own model calls to it.

    X-A2A-Budget: 2400        tokens left for this request, as the sender saw it

An agent receiving a request takes the smaller of that header and its own
limit (``A2A_TOKEN_BUDGET``). Before each model call it checks what is left;
after it, it subtracts the tokens the model reports (``usage_metadata``). When
nothing is left it stops with a sentence instead of calling the model, and a
request that arrives with nothing left is refused with a JSON-RPC error. The
next hop is told what remains, so a downstream agent cannot spend the caller's
money twice.

The limit is soft by one call: a call that starts with budget left is allowed
to finish even if it overspends.

Traces (lab 83): ADK already records ``gen_ai.usage.input_tokens`` and
``gen_ai.usage.output_tokens`` on each model span (OpenTelemetry GenAI
conventions, still in Development) on each ``generate_content`` span.
OpenTelemetry has no standard cost attribute, so the running totals go on the
agent's ``invoke_agent`` span as ``a2a.budget.limit``, ``a2a.budget.spent``
and, with a price set, ``a2a.budget.cost_usd``.

Switch: ``A2A_TOKEN_BUDGET=<tokens>`` on every agent (0 = off). Optional
``A2A_TOKEN_PRICE_PER_MILLION`` (dollars) turns token counts into a cost.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BUDGET_HEADER = "x-a2a-budget"
#: JSON-RPC server-defined error range, next to lab 85's -32010 / -32011.
BUDGET_ERROR = -32012


@dataclass
class Budget:
    agent: str
    limit: int
    spent: int = 0
    calls: int = 0
    received: int | None = None

    @property
    def remaining(self) -> int:
        return self.limit - self.spent


_BUDGET: contextvars.ContextVar[Budget | None] = contextvars.ContextVar("a2a_budget", default=None)


def price_per_token() -> float:
    try:
        return float(os.environ.get("A2A_TOKEN_PRICE_PER_MILLION", "0") or 0) / 1_000_000
    except ValueError:
        return 0.0


def current() -> Budget | None:
    return _BUDGET.get()


async def add_budget(request: httpx.Request) -> None:
    """httpx request hook: tell the next agent what is left."""
    budget = _BUDGET.get()
    if budget is not None:
        request.headers[BUDGET_HEADER] = str(max(budget.remaining, 0))


def _record(budget: Budget) -> None:
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        span.set_attribute("a2a.budget.limit", budget.limit)
        span.set_attribute("a2a.budget.spent", budget.spent)
        if price_per_token():
            span.set_attribute("a2a.budget.cost_usd", round(budget.spent * price_per_token(), 6))
    except Exception:  # noqa: BLE001 - tracing must never break the agent
        pass


def before_model(callback_context: Any, llm_request: Any) -> Any:
    """``before_model_callback``: stop with a sentence once the budget is spent."""
    budget = _BUDGET.get()
    if budget is None or budget.remaining > 0:
        return None
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    logger.warning("budget spent on %s: %d of %d tokens", budget.agent, budget.spent, budget.limit)
    text = (
        f"Budget exhausted: {budget.agent} has spent {budget.spent} of the {budget.limit} "
        "tokens this request was allowed, so it stopped before another model call."
    )
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))


def after_model(callback_context: Any, llm_response: Any) -> Any:
    """``after_model_callback``: charge the tokens the model reported."""
    budget = _BUDGET.get()
    usage = getattr(llm_response, "usage_metadata", None)
    if budget is None or usage is None:
        return None
    tokens = usage.total_token_count or (
        (usage.prompt_token_count or 0) + (usage.candidates_token_count or 0)
    )
    budget.spent += tokens
    budget.calls += 1
    _record(budget)
    return None


class BudgetMiddleware:
    """Starts this agent's share of the request's budget; refuses an empty one."""

    def __init__(self, app: Any, *, agent: str, limit: int):
        self.app = app
        self._agent = agent
        self._limit = limit

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/a2a/"):
            await self.app(scope, receive, send)
            return
        received = None
        for k, v in scope.get("headers") or []:
            if k.decode("latin-1").lower() == BUDGET_HEADER:
                try:
                    received = int(v.decode("latin-1").strip())
                except ValueError:
                    received = None
        limit = self._limit if received is None else min(self._limit, received)
        if limit <= 0:
            logger.warning("refusing a request with no budget left at %s", self._agent)
            await _refuse(
                send,
                f"Budget exhausted: the request reached {self._agent} with no tokens left.",
                received,
            )
            return
        budget = Budget(agent=self._agent, limit=limit, received=received)
        token = _BUDGET.set(budget)
        try:
            await self.app(scope, receive, send)
        finally:
            _BUDGET.reset(token)
            if budget.calls:
                cost = budget.spent * price_per_token()
                logger.info(
                    "budget on %s: spent %d of %d tokens in %d model call(s)%s",
                    self._agent,
                    budget.spent,
                    budget.limit,
                    budget.calls,
                    f" (${cost:.4f})" if cost else "",
                )


async def _refuse(send: Any, message: str, received: int | None) -> None:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": BUDGET_ERROR, "message": message, "data": {"received": received}},
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
