"""Replicas (lab 84), the SDK's own way: a2a-sdk's cluster mode.

``common.task_ownership`` fixes the two wrong-pod calls by forwarding them to
the pod that runs the task. Since 1.2, a2a-sdk can fix them without any
pod-to-pod traffic, through the shared database alone:

``VersionedTaskStore``
    Every write carries the version it was derived from. A pod that receives
    ``CancelTask`` for a task running elsewhere writes ``CANCELED`` with a new
    version; the owning pod's next save fails with
    ``ConcurrentTaskModificationError`` and it stops, so the cancel sticks.

``TaskEventStream``
    Every applied event is also written to a ``task_events`` table. A pod that
    receives ``SubscribeToTask`` for a task running elsewhere sends the stored
    snapshot and then tails that table (polled every 0.5 s), so the client sees
    the task move.

ADK's ``get_fast_api_app`` builds the request handler itself and only passes
the plain ``DatabaseTaskStore`` it made from ``TASK_STORE_URI``. This module
rebinds ``DefaultRequestHandler`` so that, when it is given such a store, it
gets the versioned store and the event stream over the same engine instead.

Switch: ``A2A_CLUSTER_MODE=1`` (needs ``TASK_STORE_URI`` on a database every
replica reaches). Use it or ``A2A_OWNER_ROUTING``, not both.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def install() -> None:
    """Call before ``get_fast_api_app``: it imports the handler when it builds routes."""
    from a2a.server import request_handlers
    from a2a.server.cluster import DatabaseTaskEventStream, VersionedDatabaseTaskStore

    base = request_handlers.DefaultRequestHandler
    if getattr(base, "_cluster_mode", False):
        return

    class Store(VersionedDatabaseTaskStore):
        """a2a-sdk 1.3.0 creates the version table on the first save only, but
        ``get`` already joins it: a read on a fresh database fails with "no
        such table: task_versions". Make every read create it first."""

        async def get(self, *args: Any, **kwargs: Any) -> Any:
            await self._db._ensure_initialized()  # noqa: SLF001
            await self._ensure_cluster_tables()
            return await super().get(*args, **kwargs)

    def handler(*args: Any, task_store: Any = None, **kwargs: Any) -> Any:
        engine = getattr(task_store, "engine", None)
        if engine is not None and kwargs.get("event_stream") is None:
            task_store = Store(engine)
            kwargs["event_stream"] = DatabaseTaskEventStream(engine)
            logger.info("cluster mode on: versioned task store + shared task_events stream")
        return base(*args, task_store=task_store, **kwargs)

    handler._cluster_mode = True  # type: ignore[attr-defined]
    request_handlers.DefaultRequestHandler = handler  # type: ignore[assignment]
