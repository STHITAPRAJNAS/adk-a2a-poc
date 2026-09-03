"""A2A server for the release-operations agent (default port 8001).

Built with ``get_fast_api_app(..., a2a=True)``. For every directory under
``agents_dir`` that contains an ``agent.json``, ADK attaches:

  ``POST {base}/a2a/<dir>``                              A2A JSON-RPC endpoint
  ``GET  {base}/a2a/<dir>/.well-known/agent-card.json``  the Agent Card

alongside the normal ADK surface (``/list-apps``, ``/run_sse``, the Dev UI).
Both live on one app, which is the point of using the wrapper rather than
``to_a2a()``: the same process serves the protocol *and* the debugger.

This module also adds a small ``/ops`` surface of its own. It is not part of
A2A — it exists so a background deployment job can be watched from outside the
agent turn that started it, which is what makes the long-running demo honest.
"""

from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from common.approvals import APPROVALS  # noqa: E402
from common.config import (  # noqa: E402
    DEPLOYMENT_AGENT_APP_NAME,
    REMOTE_AGENTS_DIR,
    get_settings,
)
from common.jobs import JOBS  # noqa: E402

logger = logging.getLogger(__name__)


def build_app() -> Any:
    """Builds the FastAPI app that serves the remote agent over A2A."""
    settings = get_settings()
    # Suppress ADK's experimental banner unless the operator asked to see it.
    os.environ.setdefault("ADK_SUPPRESS_A2A_EXPERIMENTAL_FEATURE_WARNINGS", "1")

    from fastapi import HTTPException
    from google.adk.cli.fast_api import get_fast_api_app

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await JOBS.aclose()

    app = get_fast_api_app(
        # ``get_fast_api_app`` resolves the A2A scan as ``Path.cwd() / agents_dir``.
        # An absolute path makes that independent of where the process was started.
        agents_dir=str(REMOTE_AGENTS_DIR),
        web=True,          # also serve the ADK Dev UI, for driving this agent directly
        a2a=True,          # mount the A2A JSON-RPC endpoint + Agent Card
        host=settings.remote_agent_host,
        port=settings.remote_agent_port,
        allow_origins=["*"],
        lifespan=lifespan,
    )

    # ---- Non-A2A operator surface ------------------------------------------
    # `start_deployment` is a long-running tool: it returns a job handle and the
    # A2A task parks in INPUT_REQUIRED. Something outside the agent has to watch
    # that job and post the terminal result back. These routes are what it
    # watches.

    @app.get("/ops/jobs", tags=["ops"])
    async def list_jobs() -> dict[str, Any]:
        return {"jobs": [job.to_dict() for job in JOBS.list()]}

    @app.get("/ops/jobs/{job_id}", tags=["ops"])
    async def get_job(job_id: str) -> dict[str, Any]:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"No such job: {job_id}")
        return job.to_dict()

    @app.post("/ops/jobs/{job_id}/cancel", tags=["ops"])
    async def cancel_job(job_id: str) -> dict[str, Any]:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"No such job: {job_id}")
        cancelled = await JOBS.cancel(job_id)
        return {"cancelled": cancelled, "job": job.to_dict()}

    @app.get("/ops/approvals", tags=["ops"])
    async def list_approvals() -> dict[str, Any]:
        return {"tickets": [t.to_dict() for t in APPROVALS.list()]}

    @app.get("/ops/approvals/{ticket_id}", tags=["ops"])
    async def get_approval(ticket_id: str) -> dict[str, Any]:
        ticket = APPROVALS.get(ticket_id)
        if ticket is None:
            raise HTTPException(status_code=404, detail=f"No such ticket: {ticket_id}")
        return ticket.to_dict()

    return app


app = build_app()


def main() -> None:
    import uvicorn

    settings = get_settings()
    base = settings.remote_agent_base_url
    print(f"Release-operations agent (A2A server)  {base}")
    print(f"  Agent Card   {base}/a2a/{DEPLOYMENT_AGENT_APP_NAME}/.well-known/agent-card.json")
    print(f"  A2A JSON-RPC {base}/a2a/{DEPLOYMENT_AGENT_APP_NAME}")
    print(f"  Dev UI       {base}/dev-ui?app={DEPLOYMENT_AGENT_APP_NAME}")
    print(f"  Jobs         {base}/ops/jobs")
    if settings.use_fake_llm:
        print("  model        scripted (POC_FAKE_LLM=1) — no Gemini calls")
    uvicorn.run(
        app,
        host=settings.remote_agent_host,
        port=settings.remote_agent_port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
