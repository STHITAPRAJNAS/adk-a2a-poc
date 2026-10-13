"""Labs 84 and 85: two replicas of one agent, and two agents pointed at each other.

Same harness as ``test_production.py``: real servers as subprocesses on their
own ports, driven over the wire by the probes the cluster labs use.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from test_production import REPO_ROOT, Server  # noqa: E402  (tests/ is on sys.path)

REPLICA_PROBE = [sys.executable, str(REPO_ROOT / "scripts" / "a2a_replica_probe.py")]


@pytest.fixture
def servers(tmp_path):
    started: list[Server] = []

    def run(kind: str, port: int, **env: str) -> Server:
        server = Server(kind, port, tmp_path, **env).start()
        started.append(server)
        return server

    yield run
    for server in reversed(started):
        server.stop()


def _replicas(servers, tmp_path, routing: bool) -> tuple[str, str]:
    shared = {
        "TASK_STORE_URI": f"sqlite+aiosqlite:///{tmp_path}/tasks.db",
        "SESSION_SERVICE_URI": f"sqlite+aiosqlite:///{tmp_path}/sessions.db",
        "COMPLIANCE_SCAN_SECONDS": "5",
        "A2A_OWNER_ROUTING": "1" if routing else "0",
    }
    for port in (18041, 18042):
        servers(
            "specialist",
            port,
            A2A_ADVERTISE_URL=f"http://127.0.0.1:{port}",
            POD_NAME=f"replica-{port}",
            **shared,
        )
    return (
        "http://127.0.0.1:18041/a2a/deployment_agent",
        "http://127.0.0.1:18042/a2a/deployment_agent",
    )


def _replica_probe(command: str, a: str, b: str) -> tuple[int, str]:
    out = subprocess.run(
        [*REPLICA_PROBE, command, "--a", a, "--b", b, "--wait", "6"],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        capture_output=True,
        text=True,
        timeout=180,
    )
    return out.returncode, out.stdout + out.stderr


# -------------------------------------------------------------------- replicas


@pytest.mark.parametrize("routing", [False, True], ids=["store-only", "owner-routing"])
def test_subscribe_on_the_other_replica(servers, tmp_path, routing):
    """Lab 84: SubscribeToTask lands on the pod that is not running the task."""
    a, b = _replicas(servers, tmp_path, routing)
    code, out = _replica_probe("subscribe", a, b)
    if routing:
        assert code == 0 and "followed the task live to INPUT_REQUIRED" in out, out
        assert "forwarded to replica-18041" in out, out
    else:
        assert code == 3 and "STUCK" in out, out


@pytest.mark.parametrize("routing", [False, True], ids=["store-only", "owner-routing"])
def test_cancel_on_the_other_replica(servers, tmp_path, routing):
    """Lab 84: CancelTask lands on the pod that is not running the task."""
    a, b = _replicas(servers, tmp_path, routing)
    code, out = _replica_probe("cancel", a, b)
    if routing:
        assert code == 0 and "stayed canceled" in out, out
    else:
        assert code == 3 and "RESURRECTED" in out, out


# ----------------------------------------------------------------------- loops

LOOP_PROBE = [sys.executable, str(REPO_ROOT / "scripts" / "a2a_loop_probe.py")]


def _looped_pair(servers, tmp_path, **env: str) -> tuple[str, str]:
    """Two concierges, each handing release work to the other: a loop by config."""
    card = json.loads((REPO_ROOT / "agents/ops_concierge/agent.json").read_text())
    urls = {}
    for port in (18051, 18052):
        urls[port] = f"http://127.0.0.1:{port}/a2a/ops_concierge"
        copy = json.loads(json.dumps(card))
        for iface in copy["supportedInterfaces"]:
            iface["url"] = urls[port]
        (tmp_path / f"card-{port}.json").write_text(json.dumps(copy))
    for port, peer in ((18051, 18052), (18052, 18051)):
        servers(
            "concierge",
            port,
            DEPLOYMENT_AGENT_CARD_URL=str(tmp_path / f"card-{peer}.json"),
            A2A_AGENT_ID=f"concierge-{port}",
            **env,
        )
    return urls[18051], urls[18052]


def _loop_probe(a: str, b: str, deadline: float) -> tuple[int, str]:
    out = subprocess.run(
        [*LOOP_PROBE, "--entry", a, "--agents", a, b, "--deadline", str(deadline)],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        capture_output=True,
        text=True,
        timeout=120,
    )
    return out.returncode, out.stdout + out.stderr


def test_loop_without_a_guard_keeps_bouncing(servers, tmp_path):
    a, b = _looped_pair(servers, tmp_path)
    code, out = _loop_probe(a, b, deadline=10)
    assert code == 3 and "LOOP" in out, out


def test_loop_guard_refuses_the_cycle_and_says_why(servers, tmp_path):
    a, b = _looped_pair(servers, tmp_path, A2A_MAX_HOPS="4")
    code, out = _loop_probe(a, b, deadline=30)
    assert code == 0, out
    assert (
        "Delegation loop" in out and "concierge-18051 → concierge-18052 → concierge-18051" in out
    ), out


def test_hop_limit_refuses_a_chain_that_is_too_deep(servers, tmp_path):
    a, b = _looped_pair(servers, tmp_path, A2A_MAX_HOPS="1")
    code, out = _loop_probe(a, b, deadline=30)
    assert code == 0 and "Delegation too deep" in out, out
