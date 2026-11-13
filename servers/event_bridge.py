"""The event bridge (lab 93): a queue in front of the release agent.

Nobody calls the release agent over HTTP in this lab. CI puts a
``release.requested`` event on a Redis Stream; this worker reads it, turns it
into an A2A message, sends it to the agent, records what happened, and only
then acknowledges the event. A person's decision arrives later as its own
``change.approved`` event, and the bridge uses it to resume the parked task.

    events ──► Redis Stream ──► bridge ──A2A──► release agent
                (group "bridge")   │
                                   ├──► release-results      what happened
                                   └──► release-events-dead  what it gave up on

Delivery is at least once: an event that was read but not acknowledged (the
worker crashed, the agent was down) is claimed again after
``BRIDGE_RETRY_SECONDS``. So the same event can arrive twice, and
``BRIDGE_DEDUPE`` decides what a second arrival does:

``0``  (the break) send it again: a second task, a second approval ticket.
``1``  (the fix) look before sending. The event's id is the A2A ``messageId``
       and names its ``contextId`` (``evt-<id>``). The bridge first checks its
       own record, then asks the agent (``ListTasks`` by that context) whether
       a task for this event already exists, and only sends if neither knows
       it. That covers the crash between "sent" and "recorded".

Other rules it follows:

* Invalid events (unknown type, a field that fails its pattern) go straight
  to the dead-letter stream: retrying cannot fix them.
* Retryable failures (agent unreachable, JSON-RPC error) are left
  unacknowledged and retried; after ``BRIDGE_MAX_DELIVERIES`` they are dead too.
* The agent never sees the event, only a message built from validated fields.
* ``traceparent`` on the event is passed on, so the trace starts at the source.

Fault for the lab: ``SET bridge:fault:crash-after-send 1`` makes the next
send end with the process exiting before it records or acknowledges anything,
which is what a pod killed at the wrong moment looks like.

    python -m servers.event_bridge
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import sys
from typing import Any

import httpx

from common import events
from common.a2a_wire import (
    A2AWireClient,
    TurnResult,
    function_response_message,
    rpc,
    text_message,
)
from common.config import get_settings

logger = logging.getLogger("servers.event_bridge")

HITL_TOOL = "request_change_approval"
JOB_TOOL = "start_deployment"
CRASH_KEY = "bridge:fault:crash-after-send"
HANDLED = "bridge:handled"


class RetryLater(RuntimeError):
    """Might work next time: leave the event unacknowledged."""


class Bridge:
    def __init__(
        self,
        redis: Any,
        agent_url: str,
        *,
        consumer: str,
        dedupe: bool,
        max_deliveries: int = 3,
        retry_seconds: float = 5.0,
    ):
        self.r = redis
        self.agent_url = agent_url
        self.consumer = consumer
        self.dedupe = dedupe
        self.max_deliveries = max_deliveries
        self.retry_ms = int(retry_seconds * 1000)

    # ── the loop ─────────────────────────────────────────────────────────
    async def setup(self) -> None:
        try:
            await self.r.xgroup_create(events.STREAM, events.GROUP, id="0", mkstream=True)
        except Exception as exc:  # noqa: BLE001 - BUSYGROUP: it already exists
            if "BUSYGROUP" not in str(exc):
                raise

    async def step(self) -> int:
        """Handles what is due: stale entries first, then new ones."""
        _, claimed, *_ = await self.r.xautoclaim(
            events.STREAM,
            events.GROUP,
            self.consumer,
            min_idle_time=self.retry_ms,
            start_id="0-0",
            count=10,
        )
        entries = [e for e in claimed if e and e[1]]
        if not entries:
            got = await self.r.xreadgroup(
                events.GROUP, self.consumer, {events.STREAM: ">"}, count=1, block=1000
            )
            entries = got[0][1] if got else []
        for entry_id, fields in entries:
            await self.handle(entry_id, fields)
        return len(entries)

    async def run_forever(self) -> None:
        await self.setup()
        mode = "on: look before sending" if self.dedupe else "off"
        logger.info(
            "bridge ready: consumer %s on %s, dedupe %s", self.consumer, events.STREAM, mode
        )
        while True:
            try:
                await self.step()
            except Exception as exc:  # noqa: BLE001 - keep consuming; Redis may blip
                # The stream was deleted (a reset): Redis says NOGROUP, or
                # UNBLOCKED to a read that was waiting on it. Make the group again.
                if "NOGROUP" in str(exc) or "UNBLOCKED" in str(exc):
                    await self.setup()
                    continue
                logger.exception("bridge step failed")
                await asyncio.sleep(1)

    # ── one entry ────────────────────────────────────────────────────────
    async def handle(self, entry_id: str, fields: dict[str, str]) -> None:
        raw = fields.get("event", "")
        deliveries = await self._deliveries(entry_id)
        try:
            event = events.parse(raw)
        except events.InvalidEvent as exc:
            await self._dead(entry_id, raw, f"invalid: {exc}", deliveries)
            return
        try:
            await self.process(event, deliveries)
        except events.InvalidEvent as exc:
            await self._dead(entry_id, raw, str(exc), deliveries)
            return
        except RetryLater as exc:
            if deliveries >= self.max_deliveries:
                await self._dead(
                    entry_id, raw, f"gave up after {deliveries} tries: {exc}", deliveries
                )
            else:
                logger.warning(
                    "%s (try %d of %d): %s; will retry",
                    event.id,
                    deliveries,
                    self.max_deliveries,
                    exc,
                )
            return
        await self.r.xack(events.STREAM, events.GROUP, entry_id)

    async def process(self, event: events.Event, deliveries: int) -> None:
        if self.dedupe:
            task_id = await self.r.hget(HANDLED, event.id)
            if task_id:
                logger.info("%s already handled (task %s): nothing sent", event.id, task_id)
                return
        if event.type == events.RELEASE_REQUESTED:
            await self._release(event, deliveries)
        else:
            await self._approval(event)

    async def _release(self, event: events.Event, deliveries: int) -> None:
        if self.dedupe:
            found = await self._find_task(event.context_id)
            if found is not None:
                logger.info(
                    "%s: the agent already has task %s for this event: not sending again",
                    event.id,
                    found.task_id,
                )
                await self._record(event, found)
                return
        message = text_message(
            events.release_prompt(event), context_id=event.context_id if self.dedupe else None
        )
        message["messageId"] = event.id
        logger.info(
            "%s → agent (delivery %d): %s", event.id, deliveries, events.release_prompt(event)
        )
        turn = await self._send(message, event)
        if await self.r.getdel(CRASH_KEY):
            logger.warning(
                "%s: crashing after the send, before recording or acking (injected fault)", event.id
            )
            for handler in logging.getLogger().handlers + logger.handlers:
                handler.flush()
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(1)
        await self._record(event, turn)

    async def _approval(self, event: events.Event) -> None:
        ticket = event.data["ticket_id"]
        parked = await self.r.hgetall(f"bridge:ticket:{ticket}")
        if not parked:
            raise events.InvalidEvent(f"no release is waiting on {ticket}")
        payload = {
            "ticket_id": ticket,
            "approved": event.data["approved"],
            "decided_by": event.data["decided_by"],
            "note": f"decided through event {event.id}",
        }
        message = function_response_message(
            call_id=parked["call_id"],
            name=parked["name"],
            payload=payload,
            task_id=parked["task_id"],
            context_id=parked.get("context_id") or None,
        )
        message["messageId"] = event.id
        logger.info(
            "%s → agent: %s %s on task %s",
            event.id,
            "approve" if event.data["approved"] else "reject",
            ticket,
            parked["task_id"],
        )
        turn = await self._send(message, event)
        await self.r.delete(f"bridge:ticket:{ticket}")
        if turn.pending and turn.pending.name == JOB_TOOL:
            job = turn.tool_responses.get(JOB_TOOL, {}).get("job_id")
            await self._result(
                "release.moved_on", event, parked["task_id"], ticket=ticket, job_id=job
            )
        else:
            await self._result(
                "release.finished",
                event,
                parked["task_id"],
                ticket=ticket,
                state=turn.final_state,
                said=" ".join(turn.texts)[:200],
            )
        await self.r.hset(HANDLED, event.id, parked["task_id"])

    # ── helpers ──────────────────────────────────────────────────────────
    async def _send(self, message: dict[str, Any], event: events.Event) -> TurnResult:
        # The wire client speaks the 0.3 method names the server still accepts
        # without a version header; only ListTasks below needs "1.0".
        headers: dict[str, str] = {}
        if event.traceparent:
            headers["traceparent"] = event.traceparent
        timeout = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=30.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, headers=headers) as http:
                turn = await A2AWireClient(http, self.agent_url).stream(message)
        except httpx.TransportError as exc:
            raise RetryLater(f"agent unreachable: {type(exc).__name__}") from exc
        if turn.error:
            raise RetryLater(f"agent error: {json.dumps(turn.error)[:200]}")
        return turn

    async def _find_task(self, context_id: str) -> TurnResult | None:
        """Look before resending: does the agent already have this event's task?"""
        body = rpc("ListTasks", {"contextId": context_id, "historyLength": 50})
        try:
            async with httpx.AsyncClient(timeout=10.0, headers={"A2A-Version": "1.0"}) as http:
                resp = (await http.post(self.agent_url, json=body)).json()
        except (httpx.TransportError, ValueError) as exc:
            raise RetryLater(f"could not ask the agent: {type(exc).__name__}") from exc
        if "error" in resp:
            raise RetryLater(f"ListTasks failed: {resp['error'].get('message')}")
        tasks = (resp.get("result") or {}).get("tasks") or []
        if not tasks:
            return None
        task = tasks[0]
        turn = TurnResult(task_id=task.get("id"), context_id=task.get("contextId"))
        for message in task.get("history") or []:
            turn.frames.append({"result": {**message, "kind": "message"}})
        turn.frames.append({"result": {**task, "kind": "task"}})
        return turn

    async def _record(self, event: events.Event, turn: TurnResult) -> None:
        ticket = turn.tool_responses.get(HITL_TOOL, {}).get("ticket_id")
        pending = turn.pending
        if turn.is_paused and pending and pending.name == HITL_TOOL and ticket:
            await self.r.hset(
                f"bridge:ticket:{ticket}",
                mapping={
                    "task_id": turn.task_id,
                    "context_id": turn.context_id or "",
                    "call_id": pending.call_id,
                    "name": pending.name,
                    "event_id": event.id,
                },
            )
            await self._result(
                "release.awaiting_approval",
                event,
                turn.task_id,
                ticket=ticket,
                **{k: event.data[k] for k in ("service", "version", "environment")},
            )
        else:
            await self._result(
                "release.finished",
                event,
                turn.task_id,
                state=turn.final_state,
                said=" ".join(turn.texts)[:200],
            )
        await self.r.hset(HANDLED, event.id, turn.task_id or "")

    async def _result(self, kind: str, event: events.Event, task_id: str | None, **detail) -> None:
        doc = {"type": kind, "event_id": event.id, "task_id": task_id, **detail}
        await self.r.xadd(events.RESULTS, {"result": json.dumps(doc)})
        logger.info("%s: %s %s", event.id, kind, json.dumps(detail))

    async def _deliveries(self, entry_id: str) -> int:
        rows = await self.r.xpending_range(
            events.STREAM, events.GROUP, min=entry_id, max=entry_id, count=1
        )
        return int(rows[0]["times_delivered"]) if rows else 1

    async def _dead(self, entry_id: str, raw: str, reason: str, deliveries: int) -> None:
        await self.r.xadd(
            events.DEAD, {"event": raw[:4000], "reason": reason, "deliveries": str(deliveries)}
        )
        await self.r.xadd(
            events.RESULTS,
            {"result": json.dumps({"type": "event.dead", "entry": entry_id, "reason": reason})},
        )
        await self.r.xack(events.STREAM, events.GROUP, entry_id)
        logger.warning("dead-lettered %s: %s", entry_id, reason)


def main() -> None:
    import redis.asyncio as aioredis

    from servers.hardening import configure_logging

    configure_logging()
    settings = get_settings()
    url = os.environ.get("EVENTS_REDIS_URL", "redis://127.0.0.1:6379/0")
    bridge = Bridge(
        aioredis.from_url(url, decode_responses=True),
        os.environ.get("BRIDGE_AGENT_URL", settings.deployment_agent_rpc_url),
        consumer=os.environ.get("BRIDGE_CONSUMER") or socket.gethostname(),
        dedupe=os.environ.get("BRIDGE_DEDUPE", "0").strip().lower() in {"1", "true", "yes", "on"},
        max_deliveries=int(os.environ.get("BRIDGE_MAX_DELIVERIES", "3")),
        retry_seconds=float(os.environ.get("BRIDGE_RETRY_SECONDS", "5")),
    )
    asyncio.run(bridge.run_forever())


if __name__ == "__main__":
    main()
