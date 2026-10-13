"""Replicas (lab 84): send a task's live operations to the pod that runs it.

A shared task store (lab 80) makes every replica able to *read* any task. It
does not make every replica able to *act* on it. The A2A server keeps the parts
that matter while a task runs in the memory of the pod that started it: the
executor doing the work and the in-process event stream its subscribers read
(``a2a.server.agent_execution.ActiveTaskRegistry``). With two replicas behind a
load balancer, two operations go wrong when they land on the other pod:

``SubscribeToTask``
    The other pod finds the task in the store, sends the stored snapshot, and
    then nothing: no events will ever reach its (empty) local stream. The
    client sits on ``WORKING`` while the task moves on elsewhere.

``CancelTask``
    The other pod writes ``CANCELED`` to the store and answers success. The
    owning pod never hears of it, keeps working, and overwrites the terminal
    state with its next update (``INPUT_REQUIRED``, ``COMPLETED``…). A state the
    spec calls final comes back to life, and the "cancelled" work carries on.

The fix here is the smallest one that keeps every replica equal: each pod
records "I am running task X, reach me at URL" in a table next to the task
store while its executor runs, and a pod that receives one of those two calls
for a task another live pod owns forwards the request there and streams the
answer back. Everything else (``SendMessage``, ``GetTask``, ``ListTasks``…)
stays where the load balancer put it.

Alternatives, and why not here: sticky routing by task id needs a load
balancer that parses JSON-RPC bodies; a shared event bus (Redis, Postgres
LISTEN/NOTIFY) replaces the SDK's in-process streams, which is a bigger change
than a lab should make. Both are fine production answers.

Switch: ``A2A_OWNER_ROUTING=1`` (needs ``TASK_STORE_URI`` on a database every
replica reaches). The URL other pods use for this one is
``A2A_ADVERTISE_URL``, else ``http://$POD_IP:<port>``, else 127.0.0.1.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import Column, DateTime, MetaData, String, Table, delete, select
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

logger = logging.getLogger(__name__)

#: JSON-RPC methods that must reach the task's owner (1.x names and 0.3 names).
OWNER_METHODS = {"SubscribeToTask", "CancelTask", "tasks/resubscribe", "tasks/cancel"}
#: Set on a forwarded request, so the owner never forwards it again.
FORWARDED_HEADER = "x-a2a-forwarded-by"

_metadata = MetaData()
owners = Table(
    "a2a_task_owner",
    _metadata,
    Column("task_id", String(128), primary_key=True),
    Column("owner_url", String(512), nullable=False),
    Column("pod", String(128), nullable=False),
    Column("claimed_at", DateTime(timezone=True), nullable=False),
)


class OwnershipTable:
    """Which pod is running which task right now. Lives next to the task store."""

    def __init__(self, db_url: str, *, self_url: str, pod: str):
        self.self_url = self_url.rstrip("/")
        self.pod = pod
        self._db_url = db_url
        self._engine: AsyncEngine | None = None

    async def _db(self) -> AsyncEngine:
        if self._engine is None:
            self._engine = create_async_engine(self._db_url, pool_pre_ping=True)
            async with self._engine.begin() as conn:
                await conn.run_sync(_metadata.create_all)
        return self._engine

    async def claim(self, task_id: str) -> None:
        engine = await self._db()
        async with engine.begin() as conn:
            await conn.execute(delete(owners).where(owners.c.task_id == task_id))
            await conn.execute(
                owners.insert().values(
                    task_id=task_id,
                    owner_url=self.self_url,
                    pod=self.pod,
                    claimed_at=datetime.now(UTC),
                )
            )

    async def release(self, task_id: str) -> None:
        engine = await self._db()
        async with engine.begin() as conn:
            await conn.execute(
                delete(owners).where(
                    (owners.c.task_id == task_id) & (owners.c.owner_url == self.self_url)
                )
            )

    async def forget(self, task_id: str, owner_url: str) -> None:
        """Drop a claim whose pod no longer answers (it died mid-task)."""
        engine = await self._db()
        async with engine.begin() as conn:
            await conn.execute(
                delete(owners).where(
                    (owners.c.task_id == task_id) & (owners.c.owner_url == owner_url)
                )
            )

    async def owner(self, task_id: str) -> tuple[str, str] | None:
        engine = await self._db()
        async with engine.connect() as conn:
            row = (
                await conn.execute(
                    select(owners.c.owner_url, owners.c.pod).where(owners.c.task_id == task_id)
                )
            ).first()
        return (row[0], row[1]) if row else None


_TABLE: list[OwnershipTable] = []


def advertise_url(port: int) -> str:
    explicit = os.environ.get("A2A_ADVERTISE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    host = os.environ.get("POD_IP", "").strip() or "127.0.0.1"
    return f"http://{host}:{port}"


def install(db_url: str, *, port: int) -> OwnershipTable:
    """Wrap ADK's A2A executor so each run claims its task. Call before get_fast_api_app.

    Same seam as ``common.cancellation.install``: ``get_fast_api_app`` builds
    ``A2aAgentExecutor`` itself, so rebind the name it imports. It wraps
    whatever class is current, so it composes with cancel propagation.
    """
    from google.adk.a2a.executor import a2a_agent_executor

    pod = os.environ.get("POD_NAME", "") or f"pid-{os.getpid()}"
    table = OwnershipTable(db_url, self_url=advertise_url(port), pod=pod)
    _TABLE[:] = [table]
    base = a2a_agent_executor.A2aAgentExecutor
    if getattr(base, "_claims_ownership", False):
        return table

    class OwnershipClaimingExecutor(base):  # type: ignore[misc, valid-type]
        _claims_ownership = True

        async def execute(self, context: Any, event_queue: Any) -> None:  # type: ignore[override]
            task_id = context.task_id
            try:
                await table.claim(task_id)
                logger.info("task %s: running here (%s)", task_id, table.pod)
            except Exception as exc:  # noqa: BLE001 - never block the work on bookkeeping
                logger.warning("task %s: could not record ownership (%s)", task_id, exc)
            try:
                await super().execute(context, event_queue)
            finally:
                try:
                    await table.release(task_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("task %s: could not release ownership (%s)", task_id, exc)

    a2a_agent_executor.A2aAgentExecutor = OwnershipClaimingExecutor
    logger.info("owner routing on: this pod is %s at %s", pod, table.self_url)
    return table


def _task_id(params: dict[str, Any]) -> str | None:
    raw = params.get("id") or params.get("name") or ""
    return raw.rsplit("/", 1)[-1] if isinstance(raw, str) and raw else None


class OwnerRoutingMiddleware:
    """Forwards SubscribeToTask / CancelTask to the pod that runs the task."""

    def __init__(self, app: Any, *, table: OwnershipTable | None = None, timeout: float = 900.0):
        self.app = app
        self._table = table
        self._timeout = timeout

    @property
    def table(self) -> OwnershipTable | None:
        return self._table or (_TABLE[0] if _TABLE else None)

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        table = self.table
        if (
            table is None
            or scope["type"] != "http"
            or scope["method"] != "POST"
            or not scope["path"].startswith("/a2a/")
        ):
            await self.app(scope, receive, send)
            return

        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []
        }
        body = b""
        more = True
        while more:
            message = await receive()
            body += message.get("body", b"")
            more = message.get("more_body", False)

        forward_to = None
        if FORWARDED_HEADER not in headers:
            try:
                rpc = json.loads(body or b"{}")
            except json.JSONDecodeError:
                rpc = {}
            if isinstance(rpc, dict) and rpc.get("method") in OWNER_METHODS:
                task_id = _task_id(rpc.get("params") or {})
                owner = await table.owner(task_id) if task_id else None
                if owner and owner[0] != table.self_url:
                    forward_to = (task_id, rpc["method"], owner)

        if forward_to is None:
            await self.app(scope, _replay(body, receive), send)
            return

        task_id, method, (owner_url, owner_pod) = forward_to
        target = owner_url + scope["path"]
        logger.info("%s for task %s: forwarding to %s, which runs it", method, task_id, owner_pod)
        out_headers = {
            k: v for k, v in headers.items() if k not in ("host", "content-length", "connection")
        }
        out_headers[FORWARDED_HEADER] = table.pod
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout, connect=3.0)) as http:
                async with http.stream("POST", target, content=body, headers=out_headers) as resp:
                    await send(
                        {
                            "type": "http.response.start",
                            "status": resp.status_code,
                            "headers": [
                                (k.encode("latin-1"), v.encode("latin-1"))
                                for k, v in resp.headers.items()
                                if k.lower()
                                not in ("content-length", "transfer-encoding", "connection")
                            ]
                            + [(b"x-a2a-served-by", owner_pod.encode("latin-1"))],
                        }
                    )
                    async for chunk in resp.aiter_raw():
                        await send({"type": "http.response.body", "body": chunk, "more_body": True})
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
        except httpx.ConnectError:
            # The owner is gone (killed mid-task). Its claim is stale; serve the
            # request here from the store, as without this switch.
            logger.warning("task %s: owner %s unreachable; dropping its claim", task_id, owner_pod)
            await table.forget(task_id, owner_url)
            await self.app(scope, _replay(body, receive), send)


def _replay(body: bytes, receive: Any):
    """Hand the app the body already read, then the real client's events.

    After the body, ``receive`` must keep reflecting the client: a streaming
    response watches it for ``http.disconnect``, so answering that early would
    cut every SSE stream short.
    """
    sent = False

    async def wrapped() -> dict:
        nonlocal sent
        if sent:
            return await receive()
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return wrapped
