#!/usr/bin/env bash
# Stops whatever scripts/run_all.sh started.
set -uo pipefail
cd "$(dirname "$0")/.."

for name in orchestrator remote; do
  pidfile="logs/${name}.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill "$pid" 2>/dev/null; then
      echo "stopped $name (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done

# Belt and braces for servers started by hand rather than by run_all.sh.
pkill -f "servers.orchestrator_server" 2>/dev/null && echo "stopped stray orchestrator"
pkill -f "servers.remote_agent_server" 2>/dev/null && echo "stopped stray remote agent"
exit 0
