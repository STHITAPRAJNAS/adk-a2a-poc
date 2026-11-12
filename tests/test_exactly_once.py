"""Lab 91: a deployment that starts once, even when its response is lost.

The CD system (servers/cd_server.py) is told to lose its next response: it
starts the deployment, then answers after the caller has stopped waiting.
``start_deployment`` retries, as it should. Without an idempotency key the
retry starts a second deployment; with ``IDEMPOTENT_DEPLOYS=1`` the retry
carries the approval ticket as its ``Idempotency-Key`` and gets the first
deployment back.
"""

from __future__ import annotations

import os
import subprocess
import sys

import test_production
from test_production import REPO_ROOT, _specialist_url, probe

#: The two-agent fixture from test_production, reused here.
stack = test_production.stack

CD_PORT = 18091
CD_URL = f"http://127.0.0.1:{CD_PORT}"


def cd_probe(*args: str) -> tuple[int, str]:
    out = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "cd_probe.py"), *args],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    return out.returncode, out.stdout + out.stderr


def _release_with_a_lost_response(stack, tmp_path, **env: str):
    stack("cd", CD_PORT, CD_DB=str(tmp_path / "ledger.db"))
    specialist = stack("specialist", 18001, CD_URL=CD_URL, CD_TIMEOUT_SECONDS="1", **env)
    stack("concierge", 18000, **_specialist_url(18001))
    state = tmp_path / "s.json"
    code, out = probe(state, 18000, 18001, "pause")
    assert code == 0, out
    code, out = cd_probe("lose-next", CD_URL, "1", "--delay", "3")
    assert code == 0, out
    code, out = probe(state, 18000, 18001, "resume")
    assert code == 0, out
    return specialist, out


def test_retry_without_a_key_deploys_twice(stack, tmp_path):
    specialist, resumed = _release_with_a_lost_response(stack, tmp_path)
    assert "dep-0002 after 2 attempt(s)" in resumed, resumed
    code, out = cd_probe("list", CD_URL)
    assert code == 6 and "DEPLOYED 2 TIMES" in out, out
    assert "CD attempt 1/3" in specialist.logs()


def test_retry_with_the_ticket_as_key_deploys_once(stack, tmp_path):
    specialist, resumed = _release_with_a_lost_response(stack, tmp_path, IDEMPOTENT_DEPLOYS="1")
    assert "dep-0001 after 2 attempt(s)" in resumed and "replayed" in resumed, resumed
    code, out = cd_probe("list", CD_URL)
    assert code == 0 and "deployments in the CD ledger: 1" in out, out
    assert "replayed" in specialist.logs()


def test_a_key_names_one_operation(stack, tmp_path):
    stack("cd", CD_PORT, CD_DB=str(tmp_path / "ledger.db"))
    code, out = cd_probe("deploy", CD_URL, "--ticket", "CHG-1", "--key", "CHG-1")
    assert code == 0 and "started dep-0001" in out, out
    code, out = cd_probe("deploy", CD_URL, "--ticket", "CHG-1", "--key", "CHG-1")
    assert code == 0 and "replayed dep-0001" in out, out
    code, out = cd_probe(
        "deploy", CD_URL, "--ticket", "CHG-1", "--key", "CHG-1", "--version", "9.9.9"
    )
    assert code == 2 and "422" in out, out
    code, out = cd_probe("list", CD_URL)
    assert code == 0 and "deployments in the CD ledger: 1" in out, out
