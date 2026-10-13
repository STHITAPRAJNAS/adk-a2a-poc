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
A2A_OWNER_ROUTING      subscribe/cancel reach the pod that runs    84
                       the task, with several replicas
A2A_MAX_HOPS           a delegation loop is refused, not followed  85
SURFACE_DOWNSTREAM_    a downstream refusal reaches the user as    85
  ERRORS               text (on by default with A2A_MAX_HOPS)
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
    port: int | None = None,
) -> None:
    """Things that must happen before ``get_fast_api_app`` builds the routes."""
    if settings.cancel_propagation:
        from common import cancellation

        cancellation.install(downstream_cards=downstream_cards, release_hooks=release_hooks)
    if settings.owner_routing:
        import logging

        if not settings.task_store_uri:
            logging.getLogger("servers").warning(
                "A2A_OWNER_ROUTING needs TASK_STORE_URI on a shared database; ignoring it"
            )
        else:
            from common import task_ownership

            # After cancellation.install: it wraps whatever executor is current.
            task_ownership.install(settings.task_store_uri, port=port or 8000)


def after_app(app: Any, settings: Settings, *, agent_name: str) -> None:
    """Middleware on the built app, placed INSIDE ADK's CORS middleware.

    ``add_middleware`` would wrap the app outermost, outside CORS, and then a
    401 from the token check would leave without CORS headers: a browser sees
    an opaque "Failed to fetch" instead of the challenge. Appending to
    ``user_middleware`` puts these innermost, so CORS decorates every response
    they produce. Order among them: tracing, then auth, so a refused request
    still shows up in the trace.
    """
    from starlette.middleware import Middleware

    if settings.agent_auth not in ("off", "", "none", "jwt"):
        raise ValueError(f"AGENT_AUTH must be off or jwt, got {settings.agent_auth!r}")

    from common.tracing import TraceContextMiddleware, otel_export_enabled

    if settings.trace_propagation or otel_export_enabled():
        app.user_middleware.append(
            Middleware(TraceContextMiddleware, agent=agent_name, extract=settings.trace_propagation)
        )
    if settings.agent_auth == "jwt":
        from common.identity import InboundAuthMiddleware, JwksVerifier

        app.user_middleware.append(
            Middleware(
                InboundAuthMiddleware,
                verifier=JwksVerifier(settings.sts_url, audience=agent_name),
                realm=agent_name,
            )
        )
    if settings.max_hops:
        # After auth: an unauthenticated caller is refused before its trail is read.
        import os

        from common.hops import HopGuardMiddleware

        # The trail names deployed agents, not codebases: two deployments of
        # the same app are two agents. A2A_AGENT_ID tells them apart.
        agent_id = os.environ.get("A2A_AGENT_ID", "").strip() or agent_name
        app.user_middleware.append(
            Middleware(HopGuardMiddleware, agent=agent_id, max_hops=settings.max_hops)
        )
    if settings.owner_routing and settings.task_store_uri:
        from common.task_ownership import OwnerRoutingMiddleware

        # Innermost: forward only requests that passed every check above. The
        # owner checks the forwarded request again with the same headers.
        app.user_middleware.append(Middleware(OwnerRoutingMiddleware))


def describe(settings: Settings, *, port: int | None = None) -> list[str]:
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
    if settings.owner_routing and settings.task_store_uri:
        from common.task_ownership import advertise_url

        lines.append(
            "replicas     subscribe/cancel forwarded to the owning pod "
            f"({advertise_url(port or 8000)})"
        )
    if settings.max_hops:
        lines.append(f"loops        refused; at most {settings.max_hops} hops")
    if settings.surface_downstream_errors:
        lines.append("errors       a downstream refusal is shown to the user")
    return lines
