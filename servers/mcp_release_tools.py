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


@server.tool()
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
