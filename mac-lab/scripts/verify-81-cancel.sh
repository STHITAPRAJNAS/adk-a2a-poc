#!/usr/bin/env bash
# Lab 81 — CancelTask on the front door reaches the specialist's task, and the
# specialist lets go of its approval ticket.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

A=$(env_of ops-concierge CANCEL_PROPAGATION)
B=$(env_of deployment-agent CANCEL_PROPAGATION)
if [ -z "$A" ] && [ -z "$B" ]; then
  skip "lab 81 not applied (no CANCEL_PROPAGATION on the agents) — skipping"
  exit 0
fi
need_probe
[ "$A" = 1 ] && ok "ops-concierge forwards cancels" || no "CANCEL_PROPAGATION not 1 on ops-concierge"
[ "$B" = 1 ] && ok "deployment-agent releases holds on cancel" || no "CANCEL_PROPAGATION not 1 on deployment-agent"

OUT=$(probe pause 2>&1)
echo "$OUT" | grep -q "parked at" && ok "parked a release at the approval gate" \
  || { no "could not park a release:"; echo "$OUT" | tail -6 | sed 's/^/      /'; exit 1; }
TICKET=$(echo "$OUT" | grep -o 'CHG-[0-9A-F]*' | head -1)

OUT=$(probe cancel 2>&1); RC=$?
case $RC in
  0) ok "downstream task canceled too (PROPAGATED)" ;;
  3) no "downstream task ORPHANED — still input-required" ;;
  *) no "cancel failed:"; echo "$OUT" | tail -6 | sed 's/^/      /' ;;
esac

T=$(kubectl -n "$NS" exec deploy/deployment-agent -- env NO_COLOR=1 python scripts/a2a_prod_probe.py \
      --specialist http://127.0.0.1:8001/a2a/deployment_agent tickets 2>/dev/null | grep "$TICKET")
echo "$T" | grep -q voided && ok "ticket $TICKET voided" || no "ticket $TICKET: ${T:-not found}"
exit $FAIL
