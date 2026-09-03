"""Runtime configuration, loaded once from the repo-root ``.env``.

Kept deliberately dependency-light: ``python-dotenv`` ships with ADK, so the
PoC needs nothing beyond ``google-adk[a2a]`` to boot.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent

_TRUTHY = {"1", "true", "yes", "on"}


def load_env() -> None:
    """Loads ``<repo>/.env`` without clobbering variables already exported.

    ADK performs its own ``.env`` walk when it imports an agent package, but the
    server entry points and the demo scripts read configuration *before* any
    agent is imported, so they need the file loaded up front too.
    """
    load_dotenv(REPO_ROOT / ".env", override=False)


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default) or default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:  # pragma: no cover - config typo guard
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in _TRUTHY


@dataclass(frozen=True, slots=True)
class Settings:
    """Everything both servers and both demo scripts need to agree on."""

    orchestrator_host: str
    orchestrator_port: int
    remote_agent_host: str
    remote_agent_port: int

    orchestrator_model: str
    deployment_agent_model: str

    deployment_agent_card_url: str

    compliance_scan_seconds: int
    deployment_job_seconds: int

    use_fake_llm: bool

    @property
    def orchestrator_base_url(self) -> str:
        return f"http://{self.orchestrator_host}:{self.orchestrator_port}"

    @property
    def remote_agent_base_url(self) -> str:
        return f"http://{self.remote_agent_host}:{self.remote_agent_port}"

    @property
    def deployment_agent_rpc_url(self) -> str:
        """The A2A JSON-RPC endpoint ``get_fast_api_app(a2a=True)`` mounts.

        ADK mounts one agent per directory under ``/a2a/<app_name>`` and serves
        that agent's card at ``<prefix>/.well-known/agent-card.json``.
        """
        return f"{self.remote_agent_base_url}/a2a/{DEPLOYMENT_AGENT_APP_NAME}"


#: Directory name of the remote agent package. ADK derives the A2A mount path,
#: the Dev UI app name and the session ``app_name`` from this single string.
DEPLOYMENT_AGENT_APP_NAME = "deployment_agent"

#: Directory name of the orchestrator agent package.
ORCHESTRATOR_APP_NAME = "ops_concierge"

#: ``agents_dir`` handed to ``get_fast_api_app`` for each server.
ORCHESTRATOR_AGENTS_DIR = REPO_ROOT / "agents"
REMOTE_AGENTS_DIR = REPO_ROOT / "remote_agents"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Reads settings once per process."""
    load_env()
    remote_host = _env("REMOTE_AGENT_HOST", "127.0.0.1")
    remote_port = _env_int("REMOTE_AGENT_PORT", 8001)
    default_card = (
        f"http://{remote_host}:{remote_port}"
        f"/a2a/{DEPLOYMENT_AGENT_APP_NAME}/.well-known/agent-card.json"
    )
    return Settings(
        orchestrator_host=_env("ORCHESTRATOR_HOST", "127.0.0.1"),
        orchestrator_port=_env_int("ORCHESTRATOR_PORT", 8000),
        remote_agent_host=remote_host,
        remote_agent_port=remote_port,
        orchestrator_model=_env("ORCHESTRATOR_MODEL", "gemini-2.5-flash"),
        deployment_agent_model=_env("DEPLOYMENT_AGENT_MODEL", "gemini-2.5-flash"),
        deployment_agent_card_url=_env("DEPLOYMENT_AGENT_CARD_URL", default_card),
        compliance_scan_seconds=_env_int("COMPLIANCE_SCAN_SECONDS", 12),
        deployment_job_seconds=_env_int("DEPLOYMENT_JOB_SECONDS", 25),
        use_fake_llm=_env_bool("POC_FAKE_LLM", False),
    )
