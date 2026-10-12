"""Support desk: the ADK app behind the production-like ag-ui#2603 setup.

A small but realistic on-call assistant. It answers questions, looks up service
status, and **opens incidents**, which is a real side effect: a row in the
``incidents`` table of the same Postgres that holds the ADK sessions. When a
turn is run twice, the damage is visible in the database, not just in the chat.

    check_service_status(service)            read-only
    open_incident(service, summary, severity) writes one row per call

The UI shares state with the agent (CopilotKit ``useCoAgent``): the
``environment`` the on-call engineer has selected. Tools read it from session
state, so the incident lands in the environment the user was looking at.

Every model response is stamped with the pod that produced it
(``custom_metadata.served_by``), so ``GET /debug/threads/{id}`` can say which
replica wrote each answer, for any model, scripted or real.

Model: the scripted rule engine below with ``POC_FAKE_LLM=1`` (deterministic,
no API key; it quotes the question and names the pod, so a duplicate is easy to
see in the chat), otherwise ``SUPPORT_DESK_MODEL`` (default the orchestrator
model) through ``common.config.resolve_model``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.apps import App
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools import ToolContext
from google.genai import types
from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, Text, select
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from common.config import get_settings, resolve_model
from common.fake_llm import Conversation, ScriptedLlm, _call, _text

logger = logging.getLogger("agui.support_desk")

POD = os.environ.get("POD_NAME") or socket.gethostname()

SERVICES = {
    "checkout-api": "degraded: p99 latency 2.4s (SLO 800ms) since 09:12 UTC",
    "payments": "healthy",
    "search": "healthy",
    "auth": "partial outage: 4% of logins failing in eu-west",
}
DEFAULT_SERVICE = "checkout-api"

# Paging on-call takes a while in real life (a call to the paging provider, an
# acknowledgement). It is also the window in which a pod can die mid-turn: the
# incident row exists, the answer never reaches the browser.
PAGING_SECONDS = float(os.environ.get("SUPPORT_DESK_PAGING_SECONDS", "0"))
# How long the scripted model "thinks" per call, like a real model's latency.
# A pod that dies in this window has stored the user turn but done nothing yet.
THINK_SECONDS = float(os.environ.get("SUPPORT_DESK_THINK_SECONDS", "0"))

# ---------------------------------------------------------------------------
# The incidents table: the side effect a duplicated turn repeats
# ---------------------------------------------------------------------------

_metadata = MetaData()
incidents = Table(
    "support_desk_incidents",
    _metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("thread_id", String(128), index=True, nullable=False),
    Column("service", String(64), nullable=False),
    Column("environment", String(32), nullable=False),
    Column("severity", String(8), nullable=False),
    Column("summary", Text, nullable=False),
    Column("opened_by_pod", String(128), nullable=False),
    Column("opened_at", DateTime(timezone=True), nullable=False),
)

_engine: AsyncEngine | None = None
_memory: list[dict[str, Any]] = []  # used only when no database is configured


async def _db() -> AsyncEngine | None:
    global _engine
    url = os.environ.get("AGUI_SESSION_DB", "").strip()
    if not url:
        return None
    if _engine is None:
        _engine = create_async_engine(url, pool_pre_ping=True)
        async with _engine.begin() as conn:
            await conn.run_sync(_metadata.create_all)
    return _engine


async def record_incident(row: dict[str, Any]) -> int:
    engine = await _db()
    if engine is None:
        _memory.append({"id": len(_memory) + 1, **row})
        return len(_memory)
    async with engine.begin() as conn:
        result = await conn.execute(incidents.insert().values(**row))
        return int(result.inserted_primary_key[0])


async def incidents_for(thread_id: str | None) -> list[dict[str, Any]]:
    engine = await _db()
    if engine is None:
        rows = [r for r in _memory if thread_id is None or r["thread_id"] == thread_id]
        return [{**r, "opened_at": r["opened_at"].isoformat()} for r in rows]
    query = select(incidents).order_by(incidents.c.id)
    if thread_id:
        query = query.where(incidents.c.thread_id == thread_id)
    async with engine.connect() as conn:
        rows = (await conn.execute(query)).mappings().all()
    return [{**dict(r), "opened_at": r["opened_at"].isoformat()} for r in rows]


async def incident_totals() -> dict[str, int]:
    """Across all threads: incidents, and how many of them repeat an earlier one."""
    engine = await _db()
    if engine is None:
        rows = _memory
    else:
        async with engine.connect() as conn:
            rows = (await conn.execute(select(incidents))).mappings().all()
    keys = [(r["thread_id"], r["service"], r["summary"]) for r in rows]
    return {"all_threads_incidents": len(keys), "all_threads_repeated": len(keys) - len(set(keys))}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def _environment(tool_context: ToolContext) -> str:
    return str(tool_context.state.get("environment") or "production")


def check_service_status(service: str, tool_context: ToolContext) -> dict[str, Any]:
    """Look up the current health of a service in the selected environment.

    Args:
        service: Service name, e.g. "checkout-api", "payments", "search", "auth".
    """
    env = _environment(tool_context)
    status = SERVICES.get(service, "unknown service")
    if env != "production" and status != "unknown service":
        status = "healthy"
    return {"service": service, "environment": env, "status": status}


async def open_incident(
    service: str, summary: str, severity: str, tool_context: ToolContext
) -> dict[str, Any]:
    """Open an incident and page the on-call engineer for a service.

    Args:
        service: The affected service.
        summary: One line describing the impact.
        severity: "sev1" (customer-facing outage) to "sev3" (minor).
    """
    row = {
        "thread_id": tool_context.session.id,
        "service": service,
        "environment": _environment(tool_context),
        "severity": severity if severity in ("sev1", "sev2", "sev3") else "sev2",
        "summary": summary[:500],
        "opened_by_pod": POD,
        "opened_at": datetime.now(timezone.utc),
    }
    number = await record_incident(row)
    logger.warning(
        "opened INC-%04d for thread %s; paging on-call (%.0fs)", number, row["thread_id"], PAGING_SECONDS
    )
    if PAGING_SECONDS:
        await asyncio.sleep(PAGING_SECONDS)
    return {"incident_id": f"INC-{number:04d}", **{k: row[k] for k in ("service", "environment", "severity")}}


# ---------------------------------------------------------------------------
# Scripted model
# ---------------------------------------------------------------------------

_INCIDENT_WORDS = ("incident", "outage", " down", "broken", "page ", "paging", "escalate")
_STATUS_WORDS = ("status", "healthy", "health", "how is", "how's", "latency")


def _this_turn(conversation: Conversation) -> list[types.Part]:
    """Parts after the latest user text: the tool calls and results of this turn."""
    contents = conversation.contents
    for i in range(len(contents) - 1, -1, -1):
        c = contents[i]
        if c.role == "user" and any(p.text and p.text.strip() for p in c.parts or []):
            return [p for later in contents[i + 1 :] for p in later.parts or []]
    return []


def _result(parts: list[types.Part], name: str) -> dict[str, Any] | None:
    for p in reversed(parts):
        if p.function_response is not None and p.function_response.name == name:
            r = p.function_response.response
            return r if isinstance(r, dict) else {"result": r}
    return None


def _service_in(text: str) -> str:
    lowered = text.lower()
    for name in SERVICES:
        if name in lowered or name.split("-")[0] in lowered:
            return name
    return DEFAULT_SERVICE


def _decide(conversation: Conversation) -> LlmResponse:
    asked = conversation.last_user_text()
    lowered = f" {asked.lower()} "
    quote = f'You asked: "{asked[:90]}". ' if asked else ""
    by = f" (answered by {POD})"
    turn = _this_turn(conversation)
    service = _service_in(asked)

    if any(w in lowered for w in _INCIDENT_WORDS):
        opened = _result(turn, "open_incident")
        if opened is None:
            severity = "sev1" if "outage" in lowered or " down" in lowered else "sev2"
            return _call(
                "open_incident",
                service=service,
                summary=re.sub(r"\s+", " ", asked)[:200],
                severity=severity,
            )
        return _text(
            f"{quote}Opened {opened.get('incident_id')} ({opened.get('severity')}) for "
            f"{opened.get('service')} in {opened.get('environment')} and paged on-call.{by}"
        )

    if any(w in lowered for w in _STATUS_WORDS):
        status = _result(turn, "check_service_status")
        if status is None:
            return _call("check_service_status", service=service)
        return _text(
            f"{quote}{status.get('service')} in {status.get('environment')}: "
            f"{status.get('status')}.{by}"
        )

    return _text(
        f"{quote}I'm the support desk. I can check a service's status "
        '("how is checkout-api?") or open an incident and page on-call '
        f'("checkout-api is down, open an incident").{by}'
    )


# ---------------------------------------------------------------------------
# The agent
# ---------------------------------------------------------------------------

_INSTRUCTION = """\
You are the support desk for an on-call engineering team.

The engineer is looking at the {environment?} environment.

- To answer questions about a service's health, call check_service_status.
- When the engineer reports an outage or asks you to open an incident, call
  open_incident exactly once, then confirm the incident id.
- Otherwise answer briefly.
"""


def _stamp_served_by(callback_context: CallbackContext, llm_response: LlmResponse) -> LlmResponse | None:
    """Record which replica produced each model response, for the audit view."""
    meta = dict(llm_response.custom_metadata or {})
    meta["served_by"] = POD
    llm_response.custom_metadata = meta
    return None


class _ThinkingScriptedLlm(ScriptedLlm):
    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):
        if THINK_SECONDS:
            await asyncio.sleep(THINK_SECONDS)
        async for response in super().generate_content_async(llm_request, stream):
            yield response


def build_agent() -> LlmAgent:
    settings = get_settings()
    if settings.use_fake_llm:
        model: Any = _ThinkingScriptedLlm(model="poc-scripted-model/support_desk", decider=_decide)
    else:
        model = resolve_model(os.environ.get("SUPPORT_DESK_MODEL", settings.orchestrator_model))
    return LlmAgent(
        name="support_desk",
        model=model,
        instruction=_INSTRUCTION,
        tools=[check_service_status, open_incident],
        after_model_callback=_stamp_served_by,
    )


root_agent = build_agent()
app = App(name="support_desk", root_agent=root_agent)


def register_debug_routes(api: FastAPI) -> None:
    """Extra read-only endpoints the audit panel and the load test use."""

    @api.get("/debug/incidents")
    async def list_incidents(thread: str | None = None) -> dict[str, Any]:
        rows = await incidents_for(thread)
        seen: dict[tuple[str, str, str], int] = {}
        for r in rows:
            key = (r["thread_id"], r["service"], r["summary"])
            seen[key] = seen.get(key, 0) + 1
            r["repeat"] = seen[key] > 1
        return {"thread_id": thread, "incidents": rows, **await incident_totals()}

