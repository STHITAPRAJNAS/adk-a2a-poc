#!/usr/bin/env bash
# Starts both servers in the background and waits until both answer.
#
#   scripts/run_all.sh          start both, tail nothing, return
#   scripts/run_all.sh --tail   start both and follow their logs
#
# Logs land in logs/remote.log and logs/orchestrator.log.
# Stop everything with scripts/stop_all.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

PYTHON="${PYTHON:-$( [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3 )}"

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and add your GOOGLE_API_KEY," >&2
  echo "or set POC_FAKE_LLM=1 there to run on the scripted model." >&2
  exit 1
fi

# shellcheck disable=SC2046
export $(grep -E '^(ORCHESTRATOR_PORT|REMOTE_AGENT_PORT|ORCHESTRATOR_HOST|REMOTE_AGENT_HOST)=' .env | xargs -r)
ORCHESTRATOR_HOST="${ORCHESTRATOR_HOST:-127.0.0.1}"
ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-8000}"
REMOTE_AGENT_HOST="${REMOTE_AGENT_HOST:-127.0.0.1}"
REMOTE_AGENT_PORT="${REMOTE_AGENT_PORT:-8001}"

wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      echo "  $name is up  ($url)"
      return 0
    fi
    sleep 1
  done
  echo "  $name did not come up; see its log" >&2
  return 1
}

echo "starting the release-operations agent (A2A server) on :${REMOTE_AGENT_PORT}"
nohup "$PYTHON" -m servers.remote_agent_server > logs/remote.log 2>&1 &
echo $! > logs/remote.pid

# The orchestrator resolves the remote Agent Card at first use, so the remote
# must be answering before a conversation starts. Waiting here keeps the first
# run of the demo from failing on a race.
wait_for "http://${REMOTE_AGENT_HOST}:${REMOTE_AGENT_PORT}/a2a/deployment_agent/.well-known/agent-card.json" \
         "release-operations agent"

echo "starting the ops concierge (A2A client + Dev UI) on :${ORCHESTRATOR_PORT}"
nohup "$PYTHON" -m servers.orchestrator_server > logs/orchestrator.log 2>&1 &
echo $! > logs/orchestrator.pid
wait_for "http://${ORCHESTRATOR_HOST}:${ORCHESTRATOR_PORT}/ops/wiring" "ops concierge"

cat <<MSG

  Dev UI (chat)   http://${ORCHESTRATOR_HOST}:${ORCHESTRATOR_PORT}/dev-ui?app=ops_concierge
  Remote Dev UI   http://${REMOTE_AGENT_HOST}:${REMOTE_AGENT_PORT}/dev-ui?app=deployment_agent
  Agent Card      http://${REMOTE_AGENT_HOST}:${REMOTE_AGENT_PORT}/a2a/deployment_agent/.well-known/agent-card.json
  Jobs            http://${REMOTE_AGENT_HOST}:${REMOTE_AGENT_PORT}/ops/jobs

  Scripted walkthrough : python scripts/demo_client.py
  Raw A2A wire trace   : python scripts/a2a_probe.py run --approve
  Stop everything      : scripts/stop_all.sh
MSG

if [ "${1:-}" = "--tail" ]; then
  tail -f logs/remote.log logs/orchestrator.log
fi
