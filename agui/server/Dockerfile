# The AG-UI front door (agui/server/app.py), wrapping the same ops_concierge ADK
# app the rest of the repo serves over A2A.
#
# One Dockerfile, two images: the ONLY difference between them is the
# ag-ui-adk version, which is the whole point of the experiment.
#
#   docker build -f agui/server/Dockerfile --build-arg AG_UI_ADK_VERSION=0.8.0 -t agui-server:0.8.0 .
#   docker build -f agui/server/Dockerfile --build-arg AG_UI_ADK_VERSION=0.9.0 -t agui-server:0.9.0 .
#
# Build context is the repo root (common/ and agents/ are needed).
# agui/scripts/build.sh does both and loads them into the kind cluster.

FROM python:3.11-slim-bookworm

ARG AG_UI_ADK_VERSION=0.9.0

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Same agent stack as images/Dockerfile, plus:
#   ag-ui-adk  the variable under test
#   asyncpg    the Postgres driver for the shared session store
#   greenlet   SQLAlchemy's async engine needs it; without it ADK fails with
#              "Failed to create database engine" (a NameError underneath)
RUN pip install --no-cache-dir \
        "google-adk[a2a]==2.8.0" \
        "a2a-sdk==1.1.2" \
        "python-dotenv>=1.0" \
        "uvicorn>=0.30" \
        "httpx>=0.27" \
        "PyJWT[crypto]>=2.8" \
        "sqlalchemy>=2.0" \
        "aiosqlite>=0.20" \
        "asyncpg>=0.29" \
        "greenlet>=3.0" \
        "opentelemetry-exporter-otlp-proto-http>=1.30" \
        "ag-ui-adk==${AG_UI_ADK_VERSION}"

COPY common/  ./common/
COPY agents/  ./agents/
COPY agui/    ./agui/

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin agui \
    && chown -R agui:agui /app
USER 10001

ENV AGUI_HOST=0.0.0.0 AGUI_PORT=8080
EXPOSE 8080
CMD ["python", "-m", "agui.server.app"]
