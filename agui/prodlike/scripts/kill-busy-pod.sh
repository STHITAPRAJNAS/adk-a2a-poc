#!/usr/bin/env bash
# Wait until a support-desk pod starts paging on-call, then force-kill it, as a
# node failure, an OOM kill or a spot preemption would: mid-turn, after the
# incident row is written, before the answer reaches the browser.
#
# Start this first, then send "checkout-api is down, open an incident" in the
# CopilotKit page. Gives up after 2 minutes.
set -euo pipefail
NS=agents
echo "waiting for a support-desk pod to start paging on-call… (send the outage report now)"
for _ in $(seq 1 240); do
  for pod in $(kubectl -n "$NS" get pods -l app=support-desk --field-selector=status.phase=Running -o name); do
    if kubectl -n "$NS" logs "$pod" --since=2s 2>/dev/null | grep -q "paging on-call"; then
      kubectl -n "$NS" delete "$pod" --force --grace-period=0 >/dev/null 2>&1
      echo "killed ${pod#pod/} while it was paging on-call"
      exit 0
    fi
  done
  sleep 0.5
done
echo "no pod started paging within 2 minutes" >&2
exit 1
