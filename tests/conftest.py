"""Shared fixtures.

The tests need real servers, because the point of the exercise is the network
hop: ``RemoteA2aAgent`` fetches an Agent Card over HTTP, validates its origin
and then speaks JSON-RPC to it. Mocking that out would test nothing that matters
here.

So the session fixtures start the actual servers on their configured ports, in
background threads, unless something is already listening — which lets the same
tests run against a stack started with ``./scripts/run_all.sh``.

Two fixtures, because the two agents play different roles:

``remote_a2a_server``   the release-operations agent (:8001), a pure A2A server.
``orchestrator_server`` the concierge (:8000), an A2A server *and* a client of
                        the one above. Depends on it, since the chain has to be
                        stood up inside out.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Both agents run on the scripted model by default: the suite asserts on exact
# tool-call sequences and task-state transitions, and it must run with no API key.
#
# Set POC_TEST_LIVE=1 (with a GOOGLE_API_KEY in .env) to run the identical suite
# against real Gemini instead. That is the check the scripted model cannot give
# you: whether the agents' *instructions* actually make a real model call the
# tools in the right order. Expect it to be slower, to cost quota, and to be
# occasionally flaky in a way the scripted run never is — a failure there is
# usually a prompt problem, not a protocol problem.
if os.environ.get("POC_TEST_LIVE", "").strip().lower() in ("1", "true", "yes", "on"):
    os.environ["POC_FAKE_LLM"] = "0"
else:
    os.environ["POC_FAKE_LLM"] = "1"
os.environ.setdefault("ADK_SUPPRESS_A2A_EXPERIMENTAL_FEATURE_WARNINGS", "1")
# Keep the simulated work short so the suite stays quick.
os.environ.setdefault("COMPLIANCE_SCAN_SECONDS", "1")
os.environ.setdefault("DEPLOYMENT_JOB_SECONDS", "6")

from common.config import get_settings  # noqa: E402


def _port_is_open(host: str, port: int, timeout: float = 0.4) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@contextmanager
def _serve(build_app, host: str, port: int, name: str):
    """Runs a FastAPI app on a background thread until the block exits.

    Reuses whatever is already bound to the port, so the suite works both on a
    cold machine and against a stack the developer already has running.
    """
    if _port_is_open(host, port):
        yield f"http://{host}:{port}"
        return

    import uvicorn

    config = uvicorn.Config(build_app(), host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name=name, daemon=True)
    thread.start()

    deadline = time.time() + 30
    while time.time() < deadline:
        if server.started and _port_is_open(host, port):
            break
        time.sleep(0.2)
    else:  # pragma: no cover - only on a badly stuck machine
        server.should_exit = True
        pytest.fail(f"{name} did not start on {host}:{port}")

    try:
        yield f"http://{host}:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@pytest.fixture(scope="session")
def remote_a2a_server(settings):
    """The release-operations agent (:8001) — a pure A2A server."""

    def build():
        from servers.remote_agent_server import app

        return app

    with _serve(
        build, settings.remote_agent_host, settings.remote_agent_port, "deployment-agent"
    ) as base_url:
        yield base_url


@pytest.fixture(scope="session")
def orchestrator_server(settings, remote_a2a_server):
    """The concierge (:8000) — an A2A server that is also an A2A client.

    Depends on ``remote_a2a_server`` because the concierge resolves the
    downstream Agent Card on first use, and standing the chain up inside out
    keeps that from racing.
    """

    def build():
        from servers.orchestrator_server import app

        return app

    with _serve(
        build, settings.orchestrator_host, settings.orchestrator_port, "ops-concierge"
    ) as base_url:
        yield base_url
