"""The production-hardening switches, each shown failing and then fixed.

These mirror ``k8s-lab/labs/80-83`` one for one, on real server processes:

* durable tasks       — restart the specialist while a task waits for approval
* cancel propagation  — cancel the front door, ask the specialist what happened
* delegated identity  — who may call whom, with which token
* trace propagation   — one trace across the hop, or two unrelated ones

Unlike the rest of the suite, these need *several differently configured*
servers, and the durability tests kill one mid-conversation, so each server
runs as a subprocess on its own port (18xxx) with its own environment, and the
conversation is driven by ``scripts/a2a_prod_probe.py`` exactly as the labs do.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PROBE = [sys.executable, str(REPO_ROOT / "scripts" / "a2a_prod_probe.py")]

BASE_ENV = {
    "POC_FAKE_LLM": "1",
    "ADK_SUPPRESS_A2A_EXPERIMENTAL_FEATURE_WARNINGS": "1",
    "COMPLIANCE_SCAN_SECONDS": "0",
    "DEPLOYMENT_JOB_SECONDS": "30",
    # Behave as in a pod: ADK uses in-memory sessions on Kubernetes.
    "KUBERNETES_SERVICE_HOST": "10.0.0.1",
    "NO_COLOR": "1",
}


def _free(port: int) -> bool:
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", port)) != 0


class Server:
    """One agent (or the token service) as a subprocess with its own env."""

    MODULES = {
        "specialist": ("servers.remote_agent_server", "REMOTE_AGENT_PORT"),
        "concierge": ("servers.orchestrator_server", "ORCHESTRATOR_PORT"),
        "sts": ("servers.sts_server", "STS_PORT"),
    }

    def __init__(self, kind: str, port: int, log_dir: Path, **env: str):
        self.kind, self.port = kind, port
        self.module, port_var = self.MODULES[kind]
        self.env = {**os.environ, **BASE_ENV, port_var: str(port), **env}
        self.log = log_dir / f"{kind}-{port}.log"
        self.proc: subprocess.Popen | None = None

    def start(self) -> Server:
        if not _free(self.port):
            pytest.skip(f"port {self.port} is busy")
        with self.log.open("ab") as log:
            self.proc = subprocess.Popen(
                [sys.executable, "-m", self.module],
                cwd=REPO_ROOT,
                env=self.env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        deadline = time.time() + 60
        while time.time() < deadline:
            if self.proc.poll() is not None:
                pytest.fail(f"{self.kind} exited:\n{self.log.read_text()[-2000:]}")
            try:
                if httpx.get(f"http://127.0.0.1:{self.port}/health", timeout=1).status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.3)
        pytest.fail(f"{self.kind} did not come up on {self.port}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        deadline = time.time() + 10
        while not _free(self.port) and time.time() < deadline:
            time.sleep(0.2)

    def logs(self) -> str:
        return self.log.read_text(errors="replace")


def probe(state: Path, entry: int, specialist: int, *args: str, sts: int | None = None):
    cmd = [
        *PROBE,
        "--state",
        str(state),
        "--entry",
        f"http://127.0.0.1:{entry}/a2a/ops_concierge",
        "--specialist",
        f"http://127.0.0.1:{specialist}/a2a/deployment_agent",
    ]
    if sts:
        cmd += ["--sts", f"http://127.0.0.1:{sts}"]
    out = subprocess.run(
        [*cmd, *args],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        capture_output=True,
        text=True,
        timeout=180,
    )
    return out.returncode, out.stdout + out.stderr


CARD_DIR = Path(tempfile.mkdtemp(prefix="a2a-cards-"))


@pytest.fixture
def stack(tmp_path):
    started: list[Server] = []

    def run(kind: str, port: int, **env: str) -> Server:
        server = Server(kind, port, tmp_path, **env).start()
        started.append(server)
        return server

    yield run
    for server in reversed(started):
        server.stop()


def _specialist_url(port: int) -> dict[str, str]:
    """Points the concierge at a specialist on ``port``.

    The card baked into the repo names 127.0.0.1:8001, and ``RemoteA2aAgent``
    calls whatever URL the card says — so, as the Helm chart does in the
    cluster, hand the concierge a card *file* that names the real endpoint.
    """
    card = json.loads((REPO_ROOT / "remote_agents/deployment_agent/agent.json").read_text())
    for iface in card["supportedInterfaces"]:
        iface["url"] = f"http://127.0.0.1:{port}/a2a/deployment_agent"
    path = CARD_DIR / f"deployment-agent-{port}.json"
    path.write_text(json.dumps(card))
    return {"DEPLOYMENT_AGENT_CARD_URL": str(path)}


# ------------------------------------------------------------------ durability


@pytest.mark.parametrize(
    ("stores", "resume_ok", "symptom"),
    [
        ("none", False, "still says working"),
        ("tasks", False, "COMPLETED, BUT WRONG"),
        ("both", True, "moved on"),
    ],
    ids=["in-memory", "task-store-only", "task-and-session-store"],
)
def test_restart_mid_approval(stack, tmp_path, stores, resume_ok, symptom):
    """Lab 80: which stores have to be durable for a paused task to survive."""
    env: dict[str, str] = {}
    if stores in ("tasks", "both"):
        env["TASK_STORE_URI"] = f"sqlite+aiosqlite:///{tmp_path}/tasks.db"
    if stores == "both":
        env["SESSION_SERVICE_URI"] = f"sqlite+aiosqlite:///{tmp_path}/sessions.db"

    specialist = stack("specialist", 18001, **env)
    stack("concierge", 18000, **_specialist_url(18001))
    state = tmp_path / "state.json"

    code, out = probe(state, 18000, 18001, "pause")
    assert code == 0, out

    specialist.stop()
    stack("specialist", 18001, **env)

    code, out = probe(state, 18000, 18001, "resume")
    assert (code == 0) is resume_ok, out
    assert symptom in out, out


# ---------------------------------------------------------------------- cancel


@pytest.mark.parametrize("propagate", [False, True], ids=["adk-default", "propagating"])
def test_cancel_reaches_the_specialist(stack, tmp_path, propagate):
    """Lab 81: cancel the front door's task while it waits at the gate."""
    flag = {"CANCEL_PROPAGATION": "1"} if propagate else {}
    stack("specialist", 18011, **flag)
    stack("concierge", 18010, **_specialist_url(18011), **flag)
    state = tmp_path / "state.json"

    code, out = probe(state, 18010, 18011, "pause")
    assert code == 0, out
    ticket = json.loads(state.read_text())["ticket_id"]

    code, out = probe(state, 18010, 18011, "cancel")
    assert "front-door task is now canceled" in out, out
    tickets = httpx.get("http://127.0.0.1:18011/ops/approvals").json()["tickets"]
    ticket_state = {t["id"]: t["state"] for t in tickets}[ticket]
    if propagate:
        assert code == 0 and "PROPAGATED" in out, out
        assert ticket_state == "voided"
    else:
        assert code == 3 and "ORPHANED" in out, out
        assert ticket_state == "pending"


# -------------------------------------------------------------------- identity


SECRETS: dict[str, str] = {}


@pytest.fixture
def identity_stack(stack):
    secret = secrets.token_hex(16)
    SECRETS.update({"ops_concierge": secret, "audit_agent": secrets.token_hex(16)})
    clients = ",".join(f"{name}={value}" for name, value in SECRETS.items())
    sts_env = {"STS_URL": "http://127.0.0.1:18030", "STS_CLIENTS": clients}
    stack("sts", 18030, **sts_env)
    stack("specialist", 18021, AGENT_AUTH="jwt", STS_URL=sts_env["STS_URL"])

    def concierge(mode: str) -> None:
        stack(
            "concierge",
            18020,
            **_specialist_url(18021),
            AGENT_AUTH="jwt",
            DOWNSTREAM_AUTH=mode,
            STS_URL=sts_env["STS_URL"],
            STS_CLIENT_ID="ops_concierge",
            STS_CLIENT_SECRET=secret,
        )

    return concierge


def _id_probe(state: Path, *args: str):
    return probe(state, 18020, 18021, *args, sts=18030)


def test_identity_no_token_is_refused(identity_stack, tmp_path):
    identity_stack("exchange")
    code, out = _id_probe(tmp_path / "s.json", "pause")
    assert code == 1 and '"http_status": 401' in out and "a bearer token is required" in out


def test_identity_passthrough_is_refused_downstream(identity_stack, tmp_path):
    """Forwarding the caller's own token: the specialist rejects its audience."""
    identity_stack("passthrough")
    code, out = _id_probe(tmp_path / "s.json", "--user", "alice", "pause")
    assert code == 1, out
    assert "Completed with no answer" in out, out


def test_identity_exchange_carries_the_user_and_the_actor(identity_stack, tmp_path):
    identity_stack("exchange")
    state = tmp_path / "s.json"
    code, out = _id_probe(state, "--user", "alice", "pause")
    assert code == 0, out
    ticket = json.loads(state.read_text())["ticket_id"]
    tickets = httpx.get("http://127.0.0.1:18021/ops/approvals").json()["tickets"]
    assert {t["id"]: t["requested_by"] for t in tickets}[ticket] == "alice via ops_concierge"

    code, out = _id_probe(state, "resume")
    assert code == 0 and "moved on" in out, out


def test_identity_scope_is_enforced_for_the_real_user(identity_stack, tmp_path):
    """Bob may ask but not ship: refused at the approval gate, by name."""
    identity_stack("exchange")
    code, out = _id_probe(tmp_path / "s.json", "--user", "bob", "pause")
    assert code == 4, out
    assert "bob via ops_concierge lacks the release:deploy scope" in out


def test_identity_user_token_cannot_be_replayed_at_the_specialist(identity_stack, tmp_path):
    identity_stack("exchange")
    token = httpx.post("http://127.0.0.1:18030/dev/login", json={"user": "alice"}).json()[
        "access_token"
    ]
    resp = httpx.post(
        "http://127.0.0.1:18021/a2a/deployment_agent",
        json={"jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": "x"}},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401
    assert "token audience is 'ops_concierge'" in resp.json()["error_description"]


def test_token_service_refuses_what_rfc8693_says_to_refuse(identity_stack):
    """The exchange rules themselves: client auth, 'issued to you', targets, scopes."""
    base = "http://127.0.0.1:18030"
    alice = httpx.post(f"{base}/dev/login", json={"user": "alice"}).json()["access_token"]
    grant = "urn:ietf:params:oauth:grant-type:token-exchange"
    form = {"grant_type": grant, "subject_token": alice, "audience": "deployment_agent"}

    def exchange(client: str, secret: str, **overrides: str) -> httpx.Response:
        return httpx.post(f"{base}/token", data={**form, **overrides}, auth=(client, secret))

    concierge = ("ops_concierge", SECRETS["ops_concierge"])
    assert exchange("ops_concierge", "not-the-secret").json()["error"] == "invalid_client"
    # A genuine, authenticated agent still may not exchange a token issued to
    # someone else: that is the confused-deputy check.
    stolen = exchange("audit_agent", SECRETS["audit_agent"])
    assert stolen.status_code == 400 and stolen.json()["error"] == "invalid_grant"
    assert exchange(*concierge, audience="billing_agent").json()["error"] == "invalid_target"
    bob = httpx.post(f"{base}/dev/login", json={"user": "bob"}).json()["access_token"]
    widened = exchange(*concierge, subject_token=bob, scope="release:deploy")
    assert widened.json()["error"] == "invalid_scope"

    ok = exchange(*concierge).json()
    payload = ok["access_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    assert claims["sub"] == "alice" and claims["aud"] == "deployment_agent"
    assert claims["act"] == {"sub": "ops_concierge"}


# --------------------------------------------------------------------- tracing


class _Sink(BaseHTTPRequestHandler):
    spans: list[dict] = []

    def do_POST(self):  # noqa: N802 - http.server API
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
            ExportTraceServiceRequest,
        )

        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.end_headers()
        if not self.path.endswith("/v1/traces"):  # ADK exports metrics too
            return
        req = ExportTraceServiceRequest()
        req.ParseFromString(body)
        for rs in req.resource_spans:
            svc = next(
                (a.value.string_value for a in rs.resource.attributes if a.key == "service.name"),
                "?",
            )
            for ss in rs.scope_spans:
                for sp in ss.spans:
                    _Sink.spans.append({"svc": svc, "trace": sp.trace_id.hex(), "name": sp.name})

    def log_message(self, *args):
        pass


@pytest.mark.parametrize("propagate", [False, True], ids=["export-only", "propagated"])
def test_one_trace_across_the_hop(stack, tmp_path, propagate):
    """Lab 83: exporting spans is not enough; the hop has to carry traceparent."""
    _Sink.spans = []
    server = HTTPServer(("127.0.0.1", 0), _Sink)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    otel = {
        "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{server.server_port}",
        "OTEL_BSP_SCHEDULE_DELAY": "300",  # export within a fraction of a second
    }
    if propagate:
        otel["TRACE_PROPAGATION"] = "1"
    try:
        stack("specialist", 18041, OTEL_SERVICE_NAME="deployment-agent", **otel)
        stack(
            "concierge", 18040, OTEL_SERVICE_NAME="ops-concierge", **_specialist_url(18041), **otel
        )
        code, out = probe(tmp_path / "s.json", 18040, 18041, "pause")
        assert code == 0, out
        deadline = time.time() + 20
        while time.time() < deadline:
            if {s["svc"] for s in _Sink.spans} >= {"ops-concierge", "deployment-agent"}:
                time.sleep(1.0)  # let the last batch land
                break
            time.sleep(0.3)
    finally:
        server.shutdown()

    traces = defaultdict(set)
    for span in _Sink.spans:
        traces[span["svc"]].add(span["trace"])
    assert traces["ops-concierge"] and traces["deployment-agent"], _Sink.spans[:5]
    shared = traces["ops-concierge"] & traces["deployment-agent"]
    assert bool(shared) is propagate
