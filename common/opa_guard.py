"""OPA tool-call guard — policy over *what an agent is allowed to run*.

When ``OPA_URL`` is set, each agent installs this as its ``before_tool_callback``.
ADK calls it immediately before every tool executes, with the tool, its args and
the tool context. The guard asks OPA ``POST /v1/data/tools/allow`` with
``{agent, tool, args}``; if OPA does not return ``allow: true`` it **returns a
result dict**, which makes ADK SKIP the tool and feed that dict back to the model
as the tool's response — so OPA, not the LLM, has the final say on what runs.

Off (the factory returns ``None``) when ``OPA_URL`` is unset — same opt-in shape
as the Ollama model path, so the default Gemini/fake runs are unchanged.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


def make_opa_tool_guard(agent_name: str):
    """Build a ``before_tool_callback`` bound to this agent, or ``None`` if off."""
    opa_url = os.environ.get("OPA_URL", "").strip().rstrip("/")
    if not opa_url:
        return None

    decision_url = f"{opa_url}/v1/data/tools/allow"

    def before_tool_callback(tool, args: dict[str, Any], tool_context) -> Optional[dict]:
        payload = {"input": {"agent": agent_name, "tool": tool.name, "args": dict(args or {})}}
        try:
            resp = httpx.post(decision_url, json=payload, timeout=5.0)
            resp.raise_for_status()
            allowed = bool(resp.json().get("result", False))
        except Exception as exc:  # fail closed — a broken policy engine denies
            logger.warning("OPA guard: decision query failed (%s); denying %s", exc, tool.name)
            return {
                "error": "denied_by_policy",
                "tool": tool.name,
                "message": f"policy check failed: {exc}",
            }

        if allowed:
            logger.info("OPA guard: ALLOW %s → %s", agent_name, tool.name)
            return None  # None → the tool runs normally

        logger.info("OPA guard: DENY %s → %s args=%s", agent_name, tool.name, args)
        return {
            "error": "denied_by_policy",
            "tool": tool.name,
            "args": dict(args or {}),
            "message": f"OPA policy denied {agent_name} from running {tool.name}",
        }

    return before_tool_callback
