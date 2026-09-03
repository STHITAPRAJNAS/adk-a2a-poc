"""Orchestrator server for the ops concierge (default port 8000).

Built with ``get_fast_api_app(..., web=True, a2a=True)``, which makes this agent
an A2A **peer**: a server to whoever calls it, and a client of the
release-operations agent it delegates to.

  ``GET  /dev-ui?app=ops_concierge``                  ADK Dev UI — the chat surface
  ``POST /run_sse``                                   streaming run endpoint
  ``POST /a2a/ops_concierge``                         A2A JSON-RPC endpoint
  ``GET  /a2a/ops_concierge/.well-known/agent-card.json``  this agent's own card

Serving both halves on one process is the shape a real deployment has. An agent
is rarely only a client or only a server: it is a service that other agents call,
which in turn calls the services it depends on. Everything interesting about A2A
— task ids, pause and resume, error propagation — has to survive being chained,
and it only gets exercised once an agent is on both sides of the protocol.

``scripts/a2a_chain_probe.py`` drives that chain from outside, over raw A2A.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from common.config import (  # noqa: E402
    ORCHESTRATOR_AGENTS_DIR,
    ORCHESTRATOR_APP_NAME,
    get_settings,
)

logger = logging.getLogger(__name__)


def build_app() -> Any:
    """Builds the FastAPI app that serves the orchestrator and its Dev UI."""
    settings = get_settings()
    os.environ.setdefault("ADK_SUPPRESS_A2A_EXPERIMENTAL_FEATURE_WARNINGS", "1")

    from google.adk.cli.fast_api import get_fast_api_app

    app = get_fast_api_app(
        agents_dir=str(ORCHESTRATOR_AGENTS_DIR),
        web=True,
        # Expose this agent over A2A too. ADK mounts /a2a/<dir> for every
        # directory under agents_dir that carries an agent.json.
        a2a=True,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
        allow_origins=["*"],
    )

    @app.get("/ops/wiring", tags=["ops"])
    async def wiring() -> dict[str, Any]:
        """Reports how this orchestrator is wired to the remote agent."""
        return {
            "orchestrator": {
                "app_name": ORCHESTRATOR_APP_NAME,
                "base_url": settings.orchestrator_base_url,
                "model": (
                    "scripted (POC_FAKE_LLM=1)"
                    if settings.use_fake_llm
                    else settings.orchestrator_model
                ),
            },
            "remote_agent": {
                "agent_card_url": settings.deployment_agent_card_url,
                "rpc_url": settings.deployment_agent_rpc_url,
                "transport": "A2A JSON-RPC over HTTP",
            },
        }

    return app


app = build_app()


def main() -> None:
    import uvicorn

    settings = get_settings()
    base = settings.orchestrator_base_url
    print(f"Ops concierge (A2A client)  {base}")
    print(f"  Dev UI  {base}/dev-ui?app={ORCHESTRATOR_APP_NAME}")
    print(f"  Wiring  {base}/ops/wiring")
    print(f"  Remote  {settings.deployment_agent_card_url}")
    if settings.use_fake_llm:
        print("  model   scripted (POC_FAKE_LLM=1) — no Gemini calls")
    uvicorn.run(
        app,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
