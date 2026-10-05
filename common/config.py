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

    # --- production hardening (k8s-lab labs 80-83) -------------------------
    # Every switch below defaults to off, so the plain `make run` path and the
    # earlier labs behave exactly as before. Each lab turns one on and shows
    # what changes.

    #: A2A task store. None = in memory, which forgets every task on restart.
    #: e.g. ``sqlite+aiosqlite:////data/tasks.db`` or ``postgresql+asyncpg://…``
    task_store_uri: str | None
    #: ADK session store (where the paused invocation itself lives). None =
    #: ADK's default local SQLite under ADK_LOCAL_STORAGE_DIR.
    session_service_uri: str | None
    #: Forward CancelTask to the downstream task(s) this agent opened.
    cancel_propagation: bool
    #: Carry W3C ``traceparent`` across the A2A hop, in and out.
    trace_propagation: bool
    #: Inbound auth on the A2A endpoint: ``off`` or ``jwt``.
    agent_auth: str
    #: What this agent sends downstream: ``none``, ``passthrough`` (the
    #: caller's own token — the anti-pattern) or ``exchange`` (RFC 8693).
    downstream_auth: str
    #: The lab token service (servers/sts_server.py).
    sts_url: str
    sts_client_id: str
    sts_client_secret: str

    @property
    def orchestrator_base_url(self) -> str:
        return f"http://{self.orchestrator_host}:{self.orchestrator_port}"

    @property
    def remote_agent_base_url(self) -> str:
        return f"http://{self.remote_agent_host}:{self.remote_agent_port}"

    @property
    def orchestrator_rpc_url(self) -> str:
        """The concierge's own A2A JSON-RPC endpoint.

        The concierge is an A2A peer, not just a client: other agents (and the
        chain probe) reach it here, and it reaches the deployment agent at
        ``deployment_agent_rpc_url``.
        """
        return f"{self.orchestrator_base_url}/a2a/{ORCHESTRATOR_APP_NAME}"

    @property
    def orchestrator_card_url(self) -> str:
        return f"{self.orchestrator_rpc_url}/.well-known/agent-card.json"

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


def resolve_model(model_name: str):
    """Return a model object ``LlmAgent`` will accept.

    Default behaviour is unchanged: a bare model id string (a Gemini model)
    is returned as-is and ADK's built-in registry handles it.

    When ``OLLAMA_API_BASE`` is set, the id is routed through LiteLLM to an
    Ollama server instead — so the same agents can run on a local/in-cluster
    GPU with no Gemini key. A model id that already carries a provider prefix
    (``ollama_chat/...``, ``openai/...``) is passed through untouched;
    otherwise ``ollama_chat/`` is assumed, which is the provider that speaks
    Ollama's chat + tool-calling API.
    """
    api_base = os.environ.get("OLLAMA_API_BASE", "").strip()
    if not api_base:
        return model_name

    # Imported lazily: litellm is only needed on the Ollama path, and it is a
    # heavy import to pay for on the default Gemini path.
    from google.adk.models.lite_llm import LiteLlm

    litellm_model = model_name if "/" in model_name else f"ollama_chat/{model_name}"
    return LiteLlm(model=litellm_model, api_base=api_base)


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
        task_store_uri=os.environ.get("TASK_STORE_URI", "").strip() or None,
        session_service_uri=os.environ.get("SESSION_SERVICE_URI", "").strip() or None,
        cancel_propagation=_env_bool("CANCEL_PROPAGATION", False),
        trace_propagation=_env_bool("TRACE_PROPAGATION", False),
        agent_auth=_env("AGENT_AUTH", "off").strip().lower(),
        downstream_auth=_env("DOWNSTREAM_AUTH", "none").strip().lower(),
        sts_url=_env("STS_URL", "http://127.0.0.1:8010").rstrip("/"),
        sts_client_id=_env("STS_CLIENT_ID", ""),
        sts_client_secret=os.environ.get("STS_CLIENT_SECRET", ""),
    )
