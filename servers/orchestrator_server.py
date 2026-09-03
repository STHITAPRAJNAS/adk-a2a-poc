"""Orchestrator server for the ops concierge (default port 8000).

Built with ``get_fast_api_app(..., web=True)``. This is the chat/UI layer:

  ``GET  /dev-ui?app=ops_concierge``  ADK Dev UI — the chat surface
  ``POST /run_sse``                   streaming run endpoint the UI (and the
                                      demo client) drives
  ``POST /apps/{app}/users/{u}/sessions``  session management

No ``a2a=True`` here: this side is an A2A *client*. The A2A hop happens inside
the agent, in ``RemoteA2aAgent``.
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
        a2a=False,
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
