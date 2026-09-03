"""Shared fixtures.

The end-to-end tests need a real A2A server on the far end, because the point
of the exercise is the network hop: ``RemoteA2aAgent`` fetches an Agent Card
over HTTP, validates its origin and then speaks JSON-RPC to it. Mocking that out
would test nothing that matters here.

So the session fixture starts the actual remote server on the configured port,
in a background thread, unless one is already listening — which lets the same
tests run against a stack you started with ``make run``.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Both agents must be on the scripted model: the suite asserts on exact tool
# call sequences, and it has to run with no API key in CI.
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


@pytest.fixture(scope="session")
def remote_a2a_server(settings):
    """Guarantees a release-operations agent is answering on the configured port.

    Yields the server's base URL. If something is already listening there the
    fixture assumes it is the PoC's own server and reuses it.
    """
    host, port = settings.remote_agent_host, settings.remote_agent_port
    if _port_is_open(host, port):
        yield settings.remote_agent_base_url
        return

    import uvicorn

    from servers.remote_agent_server import app

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="remote-a2a-server", daemon=True)
    thread.start()

    deadline = time.time() + 30
    while time.time() < deadline:
        if server.started and _port_is_open(host, port):
            break
        time.sleep(0.2)
    else:  # pragma: no cover - only on a badly stuck machine
        server.should_exit = True
        pytest.fail(f"remote A2A server did not start on {host}:{port}")

    try:
        yield settings.remote_agent_base_url
    finally:
        server.should_exit = True
        thread.join(timeout=10)
