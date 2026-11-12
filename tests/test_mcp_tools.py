"""Lab 87: the MCP tool server and the probe the lab drives it with.

The gateway and the NetworkPolicy only exist in the cluster; this checks the
two pieces that run in this repo: the server's four tools, and the probe's
exit codes (0 worked, 2 refused, 3 could not connect) that verify-87 reads.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

import pytest
from test_production import REPO_ROOT  # noqa: E402  (tests/ is on sys.path)

PROBE = [sys.executable, str(REPO_ROOT / "scripts" / "mcp_probe.py")]
PORT = 18071
URL = f"http://127.0.0.1:{PORT}/mcp"


@pytest.fixture(scope="module")
def mcp_server():
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", PORT)) == 0:
            pytest.skip(f"port {PORT} is busy")
    proc = subprocess.Popen(
        [sys.executable, "-m", "servers.mcp_release_tools"],
        cwd=REPO_ROOT,
        env={**os.environ, "PORT": str(PORT)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 30
    while time.time() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", PORT)) == 0:
                break
        time.sleep(0.3)
    yield URL
    proc.terminate()
    proc.wait(timeout=10)


def probe(*args: str) -> tuple[int, str]:
    out = subprocess.run(
        [*PROBE, *args],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    return out.returncode, out.stdout + out.stderr


def test_server_lists_all_four_tools(mcp_server):
    code, out = probe("list", mcp_server)
    assert code == 0, out
    for tool in (
        "check_change_freeze",
        "get_release_notes",
        "rollback_production",
        "read_deploy_secret",
    ):
        assert tool in out, out


def test_safe_tool_answers(mcp_server):
    code, out = probe("call", mcp_server, "check_change_freeze", '{"environment": "production"}')
    assert code == 0 and '"frozen": true' in out, out


def test_unknown_tool_is_refused(mcp_server):
    code, out = probe("call", mcp_server, "no_such_tool")
    assert code == 2 and "refused" in out, out


def test_unreachable_server_reads_as_blocked():
    code, out = probe("list", "http://127.0.0.1:18079/mcp")
    assert code == 3 and "blocked" in out, out


def test_freeze_tool_names_an_mcp_apps_view(mcp_server):
    code, out = probe("list", mcp_server)
    assert code == 0 and "view (MCP Apps): ui://release-tools/freeze-card.html" in out, out


def test_view_is_an_mcp_app_resource(mcp_server):
    code, out = probe("read", mcp_server, "ui://release-tools/freeze-card.html")
    assert code == 0 and "text/html;profile=mcp-app" in out, out


def test_proving_ground_hosts_the_same_view():
    """The Agent-generated UI lesson renders the file this server serves."""
    from servers.mcp_release_tools import FREEZE_CARD_HTML

    js = (REPO_ROOT / "a2a-proving-ground/js/lessons/07b-genui.js").read_text()
    block = js.split("FREEZE_CARD_HTML:begin")[1].split("FREEZE_CARD_HTML:end")[0]
    copy = block.split("`", 2)[1]
    assert copy.strip() == FREEZE_CARD_HTML.strip()
