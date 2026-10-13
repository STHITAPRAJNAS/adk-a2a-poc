#!/usr/bin/env bash
# Lab 84 — with two replicas over one task store, SubscribeToTask and
# CancelTask sent to the replica NOT running the task still do the right thing.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"
cd "$(dirname "$0")/.."

if ! kubectl -n "$NS" get deploy deployment-agent-ha >/dev/null 2>&1; then
  skip "lab 84 not applied (no deployment-agent-ha) — skipping"
  exit 0
fi
need_probe
R=$(env_of deployment-agent-ha A2A_OWNER_ROUTING)
[ "$R" = 1 ] && ok "owner routing on" || no "A2A_OWNER_ROUTING is '${R:-unset}' on deployment-agent-ha (step 3)"
N=$(kubectl -n "$NS" get pods -l app=deployment-agent-ha --field-selector=status.phase=Running -o name | wc -l | tr -d ' ')
[ "$N" -ge 2 ] && ok "$N replicas running" || no "need 2 running replicas, have $N"

OUT=$(./labs/84-replicas/replica-probe.sh subscribe 2>&1); RC=$?
case $RC in
  0) ok "subscribe on the other replica follows the task live" ;;
  3) no "subscribe on the other replica is STUCK on the snapshot" ;;
  *) no "subscribe probe failed:"; echo "$OUT" | tail -6 | sed 's/^/      /' ;;
esac
OUT=$(./labs/84-replicas/replica-probe.sh cancel 2>&1); RC=$?
case $RC in
  0) ok "cancel on the other replica stops the work, and the task stays canceled" ;;
  3) no "cancel on the other replica was RESURRECTED by the owner" ;;
  *) no "cancel probe failed:"; echo "$OUT" | tail -6 | sed 's/^/      /' ;;
esac
exit $FAIL
