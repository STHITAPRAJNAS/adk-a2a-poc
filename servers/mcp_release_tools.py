"""release-tools: an MCP server with the release agent's tools (lab 87).

Four tools, two of which no agent should be able to reach through the gateway:

=====================  =====================================================
check_change_freeze    is this environment in a change freeze right now?
get_release_notes      what changed in a service version
rollback_production    roll a service back in production (dangerous)
read_deploy_secret     read a deployment credential (dangerous)
=====================  =====================================================

All of them are fakes with fixed answers: the lab is about who can reach which
tool, not about what the tools do. The dangerous two say so in their result.

MCP Apps (extension ``io.modelcontextprotocol/ui``): ``check_change_freeze``
names a view, ``ui://release-tools/freeze-card.html``, in ``_meta.ui``. A host
that supports MCP Apps reads that resource (``text/html;profile=mcp-app``),
renders it in a sandboxed iframe, and hands it the tool's result over
``postMessage``. The view can ask the host to call a tool; the host decides
whether to. The A2A proving ground's "Agent-generated UI" lesson renders this
same file.

    python -m servers.mcp_release_tools        # :3001, Streamable HTTP at /mcp
"""

from __future__ import annotations

import os
from typing import Any

from mcp.server.mcpserver import MCPServer

server = MCPServer(
    name="release-tools",
    instructions="Read-only release information, plus two operations an agent must not get.",
)

_FREEZES = {"production": "2026-12-20T00:00:00Z"}
_NOTES = {
    ("checkout-api", "2.14.0"): "Adds idempotency keys to POST /orders; drops the v1 coupon field.",
    ("search-indexer", "0.9.0"): "Rebuilds the index incrementally; first run takes ~20 minutes.",
}


FREEZE_VIEW = "ui://release-tools/freeze-card.html"
MCP_APP_MIME = "text/html;profile=mcp-app"


@server.tool(meta={"ui": {"resourceUri": FREEZE_VIEW, "visibility": ["model", "app"]}})
def check_change_freeze(environment: str) -> dict[str, Any]:
    """Whether an environment is in a change freeze, and until when."""
    until = _FREEZES.get(environment)
    return {"environment": environment, "frozen": until is not None, "until": until}


@server.tool()
def get_release_notes(service: str, version: str) -> dict[str, Any]:
    """Release notes for one version of a service."""
    notes = _NOTES.get((service, version), "No notes recorded for this version.")
    return {"service": service, "version": version, "notes": notes}


@server.tool()
def rollback_production(service: str) -> dict[str, Any]:
    """Roll a service back to its previous version in production."""
    return {"service": service, "rolled_back": True, "warning": "dangerous tool reached"}


@server.tool()
def read_deploy_secret(name: str) -> dict[str, Any]:
    """Read a deployment credential by name."""
    return {"name": name, "value": "not-a-real-secret", "warning": "dangerous tool reached"}


#: The view. No network, no external script: it talks only to its host, over
#: postMessage JSON-RPC, and asks the host (not a server) for any tool call.
FREEZE_CARD_HTML = """<!doctype html>
<meta charset="utf-8">
<style>
  body { font: 14px system-ui, sans-serif; margin: 12px; color: #1d2433; }
  .card { border: 1px solid #c9cfdb; border-radius: 8px; padding: 12px; }
  .frozen { color: #a3261b; font-weight: 600; } .open { color: #1f6b3a; font-weight: 600; }
  button { margin-top: 8px; }
</style>
<div class="card">
  <div id="env">Waiting for the tool result…</div>
  <div id="state"></div>
  <button id="other" type="button">Check staging too</button>
</div>
<script>
  let next = 1;
  const pending = {};
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    const id = next++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve) { pending[id] = resolve; });
  }
  function show(r) {
    document.getElementById("env").textContent = "Environment: " + r.environment;
    const s = document.getElementById("state");
    s.className = r.frozen ? "frozen" : "open";
    s.textContent = r.frozen ? "Change freeze until " + r.until : "No change freeze";
  }
  window.addEventListener("message", function (e) {
    const m = e.data || {};
    if (m.id && pending[m.id]) { pending[m.id](m.result || m.error); delete pending[m.id]; return; }
    if (m.method === "ui/notifications/tool-result") show(m.params.structuredContent);
  });
  document.getElementById("other").addEventListener("click", function () {
    request("tools/call", { name: "check_change_freeze", arguments: { environment: "staging" } })
      .then(function (r) { if (r && r.structuredContent) show(r.structuredContent); });
  });
  request("ui/initialize", { appInfo: { name: "freeze-card", version: "1.0" } })
    .then(function () { send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); });
</script>
"""


@server.resource(FREEZE_VIEW, name="freeze-card", mime_type=MCP_APP_MIME)
def freeze_card() -> str:
    """A small view for check_change_freeze results (MCP Apps)."""
    return FREEZE_CARD_HTML


def main() -> None:
    import anyio

    anyio.run(
        lambda: server.run_streamable_http_async(
            host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "3001")),
        )
    )


if __name__ == "__main__":
    main()
