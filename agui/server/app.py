"""AG-UI front door for the ops concierge, served by ``ag_ui_adk``.

A browser (agui/frontend) speaks AG-UI to this server; this server runs the
same ``ops_concierge`` ADK app the rest of the repo serves over A2A, and that
agent still reaches ``deployment_agent`` over A2A for release work:

    browser ──AG-UI──► agui-server (×2 pods) ──A2A──► deployment-agent
                             │
                             └── one shared session store (Postgres)

It exists to reproduce ag-ui-protocol/ag-ui#2603 and watch the fix land:

  ag-ui-adk 0.8.0  the "which messages have I already processed?" ledger lives
                   in each pod's memory. AG-UI clients resend the whole history
                   on every run, so a run served by the *other* pod (or by a
                   restarted one) treats an answered question as new, answers it
                   again, and writes the duplicate into the shared session.
  ag-ui-adk 0.9.0  the ledger lives in session state, in the shared store, and
                   is re-read on every run (release/2026-10-10, PR #2932).

The installed ``ag-ui-adk`` version is the only difference between the two
images. Everything else here is instrumentation, so the duplicate is visible:

  X-Served-By      response header naming the pod that served the run
  GET /debug/threads/{thread_id}
                   what the shared session actually holds: every user turn and
                   every answer, with repeats flagged

Environment:

  AGUI_SESSION_DB  SQLAlchemy URL of the shared session store, e.g.
                   ``postgresql+asyncpg://…`` in the cluster or
                   ``sqlite+aiosqlite:///…`` on a laptop. Unset = in memory,
                   which cannot show the bug (nothing is shared).
  AGUI_USER_ID     ADK user id for every thread (default ``agui-demo``)
  POD_NAME         reported in X-Served-By (falls back to the hostname)
"""

from __future__ import annotations

import importlib.metadata
import logging
import os
import socket
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from common.config import DEFAULT_CORS_ORIGINS, get_settings  # noqa: E402

logger = logging.getLogger("agui.server")

APP_NAME = "ops_concierge"
POD = os.environ.get("POD_NAME") or socket.gethostname()
AG_UI_ADK_VERSION = importlib.metadata.version("ag-ui-adk")


def _session_service() -> Any:
    url = os.environ.get("AGUI_SESSION_DB", "").strip()
    if not url:
        from google.adk.sessions import InMemorySessionService

        logger.warning("AGUI_SESSION_DB unset: in-memory sessions, nothing shared between pods")
        return InMemorySessionService()
    from google.adk.sessions import DatabaseSessionService

    return DatabaseSessionService(db_url=url)


def build_app() -> FastAPI:
    os.environ.setdefault("ADK_SUPPRESS_A2A_EXPERIMENTAL_FEATURE_WARNINGS", "1")
    from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

    from agents.ops_concierge.agent import app as concierge_app

    sessions = _session_service()
    agent = ADKAgent.from_app(
        concierge_app,
        user_id=os.environ.get("AGUI_USER_ID", "agui-demo"),
        session_service=sessions,
        # One AG-UI thread = one ADK session, so every pod finds the same
        # session for a thread without any in-memory mapping.
        use_thread_id_as_session_id=True,
    )

    app = FastAPI(title="ops-concierge over AG-UI")
    origins = os.environ.get("CORS_ALLOW_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    regex = [o[len("regex:") :] for o in origins if o.startswith("regex:")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o for o in origins if o and not o.startswith("regex:")],
        allow_origin_regex="|".join(regex) or None,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Served-By", "X-AG-UI-ADK"],
    )

    @app.middleware("http")
    async def served_by(request, call_next):
        response = await call_next(request)
        response.headers["X-Served-By"] = POD
        response.headers["X-AG-UI-ADK"] = AG_UI_ADK_VERSION
        return response

    add_adk_fastapi_endpoint(app, agent, path="/agui")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "pod": POD, "ag_ui_adk": AG_UI_ADK_VERSION}

    @app.get("/debug/threads/{thread_id}")
    async def thread(thread_id: str) -> dict[str, Any]:
        """What the SHARED session holds for a thread, read fresh from the store."""
        session = await sessions.get_session(
            app_name=APP_NAME,
            user_id=os.environ.get("AGUI_USER_ID", "agui-demo"),
            session_id=thread_id,
        )
        if session is None:
            return {"thread_id": thread_id, "exists": False, "turns": [], "duplicates": []}
        turns = []
        for event in session.events:
            parts = (event.content.parts if event.content else None) or []
            text = " ".join(p.text for p in parts if getattr(p, "text", None)).strip()
            if not text:
                continue
            turns.append({"author": event.author, "text": text[:200]})
        asked = Counter(t["text"] for t in turns if t["author"] == "user")
        return {
            "thread_id": thread_id,
            "exists": True,
            "served_by": POD,
            "ag_ui_adk": AG_UI_ADK_VERSION,
            "events": len(session.events),
            "user_turns": sum(asked.values()),
            "turns": turns,
            "duplicates": [{"text": t, "times": n} for t, n in asked.items() if n > 1],
        }

    return app


app = build_app()


def main() -> None:
    import uvicorn

    settings = get_settings()
    host = os.environ.get("AGUI_HOST", "127.0.0.1")
    port = int(os.environ.get("AGUI_PORT", "8080"))
    print(f"ops-concierge over AG-UI  http://{host}:{port}/agui")
    print(f"  ag-ui-adk   {AG_UI_ADK_VERSION}")
    print(f"  sessions    {os.environ.get('AGUI_SESSION_DB', '(in memory)').split('://', 1)[0]}://")
    print(f"  pod         {POD}")
    if settings.use_fake_llm:
        print("  model       scripted (POC_FAKE_LLM=1)")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
