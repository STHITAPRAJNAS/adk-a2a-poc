"""CancelTask that reaches every hop, and lets go of what each hop was holding.

What ADK does out of the box: ``A2aAgentExecutor.cancel`` publishes a
``canceled`` status for the task it was asked about, and stops there. On a
chain that is not enough. Cancel the concierge's task while it waits at the
approval gate and

* the concierge's task says ``canceled``;
* the specialist's task — a *different* task, one hop in — still says
  ``input-required``, forever;
* the approval ticket that task opened is still sitting in a human's queue.

Lab 81 shows exactly that, then turns this module on (``CANCEL_PROPAGATION=1``).

``PropagatingCancelExecutor`` replaces ADK's executor and, on cancel, after
publishing ``canceled`` for its own task as ADK would:

1. **Forwards it.** It reads the session behind the task, finds the downstream
   task ids ``RemoteA2aAgent`` recorded there (``a2a:task_id`` in event custom
   metadata — the same ids ``a2a_chain_probe.py`` prints), and sends each one
   ``CancelTask``, through the same authenticated, traced client the
   conversation used.
2. **Releases local holds.** A leaf agent has no downstream; what it has is a
   pending approval ticket and possibly a running deployment job, both named in
   session state by the tools. It voids the ticket and stops the job.

Its own ``canceled`` status goes out *before* either step: see the comment in
``cancel`` for why the order is load-bearing.

Downstream failures are logged, not raised: the caller asked for *this* task to
stop, and it does. A downstream that refuses is reported in the logs so an
operator can chase it — which is the honest version of best-effort.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

A2A_TASK_ID_KEY = "a2a:task_id"

#: Filled in by ``install()``; read by every executor ADK constructs.
_DOWNSTREAM_CARDS: dict[str, str] = {}
_LOCAL_RELEASE: list[Any] = []
_ORIGINAL_EXECUTOR: list[Any] = []


def _user_id_for(context: Any) -> str:
    """The session user ADK derives for this request (mirrors ADK's converter)."""
    try:
        from google.adk.a2a.converters.request_converter import _get_user_id

        return _get_user_id(context)
    except Exception:  # noqa: BLE001 - private helper; fall back to its logic
        user = getattr(getattr(context, "call_context", None), "user", None)
        if user is not None and getattr(user, "user_name", None):
            return user.user_name
        return f"A2A_USER_{context.context_id}"


def downstream_task_ids(session: Any) -> dict[str, list[str]]:
    """Downstream task ids per remote agent name, oldest first, deduplicated."""
    found: dict[str, list[str]] = {}
    for event in getattr(session, "events", None) or []:
        meta = getattr(event, "custom_metadata", None) or {}
        task_id = meta.get(A2A_TASK_ID_KEY)
        author = getattr(event, "author", None)
        if isinstance(task_id, str) and author in _DOWNSTREAM_CARDS:
            ids = found.setdefault(author, [])
            if task_id not in ids:
                ids.append(task_id)
    return found


async def _forward_cancel(author: str, task_ids: list[str]) -> None:
    from common.downstream import load_card, make_downstream_client, rpc_url_from_card

    rpc_url = rpc_url_from_card(await load_card(_DOWNSTREAM_CARDS[author]))
    client = make_downstream_client(author, timeout=15.0) or httpx.AsyncClient(timeout=15.0)
    async with client:
        for task_id in task_ids:
            body = {
                "jsonrpc": "2.0",
                "id": f"cancel-{task_id}",
                "method": "CancelTask",
                "params": {"id": task_id},
            }
            try:
                resp = await client.post(rpc_url, json=body, headers={"A2A-Version": "1.0"})
                payload = resp.json() if resp.content else {}
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("cancel → %s task %s: unreachable (%s)", author, task_id, exc)
                continue
            if resp.status_code >= 400:
                logger.warning("cancel → %s task %s: HTTP %s", author, task_id, resp.status_code)
            elif "error" in payload:
                # TaskNotCancelable (-32002) for one that already finished is
                # expected for older ids in the session; anything else is news.
                err = payload["error"]
                logger.info(
                    "cancel → %s task %s: %s %s",
                    author,
                    task_id,
                    err.get("code"),
                    err.get("message"),
                )
            else:
                state = ((payload.get("result") or {}).get("status") or {}).get("state")
                logger.info("cancel → %s task %s: now %s", author, task_id, state)


def _make_executor_class(base: Any):
    class PropagatingCancelExecutor(base):
        """ADK's executor, with a cancel that reaches downstream and lets go."""

        async def cancel(self, context: Any, event_queue: Any) -> None:  # type: ignore[override]
            # Publish our own ``canceled`` FIRST. a2a-sdk has already stopped
            # the producer by the time it calls us, and the event queue closes
            # as soon as that winds down: an event enqueued after a network
            # round trip is silently dropped and the task keeps its old state.
            await super().cancel(context, event_queue)

            try:
                runner = await self._resolve_runner()
                session = await runner.session_service.get_session(
                    app_name=runner.app_name,
                    user_id=_user_id_for(context),
                    session_id=context.context_id,
                )
            except Exception as exc:  # noqa: BLE001 - never fail the cancel itself
                logger.warning("cancel %s: could not load its session (%s)", context.task_id, exc)
                return
            if session is None:
                return

            for author, ids in downstream_task_ids(session).items():
                logger.info("cancel %s: forwarding to %s task(s) %s", context.task_id, author, ids)
                try:
                    await _forward_cancel(author, ids)
                except Exception as exc:  # noqa: BLE001 - best effort, but loud
                    logger.warning(
                        "cancel %s: forwarding to %s failed (%s)", context.task_id, author, exc
                    )
            for release in _LOCAL_RELEASE:
                try:
                    await release(session)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("cancel %s: release hook failed (%s)", context.task_id, exc)

    return PropagatingCancelExecutor


def install(
    *, downstream_cards: dict[str, str] | None = None, release_hooks: list[Any] | None = None
) -> None:
    """Swap ADK's executor for the propagating one. Call before get_fast_api_app.

    ``get_fast_api_app`` constructs ``A2aAgentExecutor(runner=…)`` itself and
    offers no parameter for a different class, so this rebinds the name it
    imports. That is a seam, not a fork: the subclass only overrides
    ``cancel`` and defers to ADK for everything else.

    ``downstream_cards`` maps a ``RemoteA2aAgent`` name to where its card lives
    (file path or URL); ``release_hooks`` are ``async (session) -> None``
    callables that let go of local holds.
    """
    from google.adk.a2a.executor import a2a_agent_executor

    _DOWNSTREAM_CARDS.clear()
    _DOWNSTREAM_CARDS.update(downstream_cards or {})
    _LOCAL_RELEASE[:] = list(release_hooks or [])
    if not _ORIGINAL_EXECUTOR:
        _ORIGINAL_EXECUTOR.append(a2a_agent_executor.A2aAgentExecutor)
    a2a_agent_executor.A2aAgentExecutor = _make_executor_class(_ORIGINAL_EXECUTOR[0])
    logger.info("cancel propagation on: downstream=%s", sorted(_DOWNSTREAM_CARDS))
