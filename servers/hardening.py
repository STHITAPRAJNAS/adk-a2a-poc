"""The production switches, applied the same way to both servers.

Each line here is one lab in ``k8s-lab/labs/8x-*``. All of them default to off
(see ``common.config``), so without the matching environment variables a
server is byte-for-byte the one the earlier labs used.

=====================  ==========================================  ========
switch                 what it changes                             lab
=====================  ==========================================  ========
TASK_STORE_URI         A2A tasks survive a restart                 80
SESSION_SERVICE_URI    so does the paused ADK invocation           80
CANCEL_PROPAGATION     CancelTask reaches the next hop             81
AGENT_AUTH=jwt         the A2A endpoint needs a bearer token       82
DOWNSTREAM_AUTH        what token goes to the next hop             82
TRACE_PROPAGATION      one trace across the hop                    83
=====================  ==========================================  ========
"""

from __future__ import annotations

from typing import Any

from common.config import Settings


def configure_logging() -> None:
    """Show this repo's own decisions in the server log.

    Uvicorn configures only its own loggers, so ``logger.info`` calls in
    ``common.*`` — "caller verified", "cancel → forwarding", "token exchange" —
    would otherwise be swallowed. The labs read them with ``kubectl logs``.
    """
    import logging

    for name in ("common", "servers"):
        log = logging.getLogger(name)
        if not log.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(levelname)s:     [%(name)s] %(message)s"))
            log.addHandler(handler)
            log.setLevel(logging.INFO)
            log.propagate = False


def fast_api_kwargs(settings: Settings) -> dict[str, Any]:
    """Extra ``get_fast_api_app`` arguments for durable state (lab 80)."""
    kwargs: dict[str, Any] = {}
    if settings.task_store_uri:
        kwargs["task_store_uri"] = settings.task_store_uri
    if settings.session_service_uri:
        kwargs["session_service_uri"] = settings.session_service_uri
    return kwargs


def before_app(
    settings: Settings,
    *,
    downstream_cards: dict[str, str] | None = None,
    release_hooks: list[Any] | None = None,
) -> None:
    """Things that must happen before ``get_fast_api_app`` builds the routes."""
    if settings.cancel_propagation:
        from common import cancellation

        cancellation.install(downstream_cards=downstream_cards, release_hooks=release_hooks)


def after_app(app: Any, settings: Settings, *, agent_name: str) -> None:
    """Middleware on the built app. Added inside-out: auth, then tracing."""
    if settings.agent_auth not in ("off", "", "none", "jwt"):
        raise ValueError(f"AGENT_AUTH must be off or jwt, got {settings.agent_auth!r}")
    if settings.agent_auth == "jwt":
        from common.identity import InboundAuthMiddleware, JwksVerifier

        app.add_middleware(
            InboundAuthMiddleware,
            verifier=JwksVerifier(settings.sts_url, audience=agent_name),
            realm=agent_name,
        )

    from common.tracing import TraceContextMiddleware, otel_export_enabled

    if settings.trace_propagation or otel_export_enabled():
        # Outermost, so a request refused by auth still shows up in the trace.
        app.add_middleware(
            TraceContextMiddleware, agent=agent_name, extract=settings.trace_propagation
        )


def describe(settings: Settings) -> list[str]:
    """One line per switch that is on, for the startup banner."""
    from common.tracing import otel_export_enabled

    lines = []
    if settings.task_store_uri:
        lines.append(f"task store   {settings.task_store_uri.split('://', 1)[0]}:// (durable)")
    if settings.session_service_uri:
        lines.append(f"sessions     {settings.session_service_uri.split('://', 1)[0]}://")
    if settings.cancel_propagation:
        lines.append("cancel       propagates downstream")
    if settings.agent_auth == "jwt":
        lines.append(f"auth in      bearer JWT, issuer {settings.sts_url}")
    if settings.downstream_auth not in ("none", "off", ""):
        lines.append(f"auth out     {settings.downstream_auth}")
    if otel_export_enabled():
        lines.append("traces       exported over OTLP")
    if settings.trace_propagation:
        lines.append("traces       traceparent carried across the hop")
    return lines
