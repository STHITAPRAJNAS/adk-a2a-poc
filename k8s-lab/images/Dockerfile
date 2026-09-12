# One image, both agents. Which one runs is decided by the command, not by the
# build — so there is a single artifact to push, scan and roll back.
#
# Built for linux/amd64 by default, which is what a Windows/WSL2 machine runs.
# Use build.sh --platform arm64 for an arm64 cluster (EKS Graviton node groups).
# A mismatch lands as `exec format error` in a crash loop — an unhelpful message
# for what is really a platform problem.

FROM python:3.11-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, in their own layer: the agent source changes on every
# rebuild, google-adk does not, and this is the difference between a 5-second
# and a 3-minute inner loop.
COPY pyproject.toml ./
# The `extensions` extra pulls in LiteLLM, which ADK requires for non-Gemini
# models (the Ollama path in common.config.resolve_model). Without it, loading
# an agent whose model is a LiteLlm instance fails at import with
# "LiteLLM support requires: pip install google-adk[extensions]".
RUN pip install --no-cache-dir \
        "google-adk[a2a,extensions]==2.8.0" \
        "a2a-sdk==1.1.2" \
        "python-dotenv>=1.0" \
        "uvicorn>=0.30" \
        "httpx>=0.27"

COPY common/         ./common/
COPY agents/         ./agents/
COPY remote_agents/  ./remote_agents/
COPY servers/        ./servers/

# Non-root. Istio ambient does not require it the way sidecar injection could,
# but a container that never needed root should never have it.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin agent \
    && chown -R agent:agent /app
USER 10001

# ADK writes a local session store next to the agent package unless told
# otherwise; point it somewhere writable and ephemeral.
ENV ADK_LOCAL_STORAGE_DIR=/tmp/adk

EXPOSE 8000 8001

# Overridden per deployment. No default that silently starts the wrong agent.
ENTRYPOINT ["python", "-m"]
CMD ["servers.orchestrator_server"]
