#!/usr/bin/env bash
# Lab 80 — a task parked at the approval gate survives its pod being deleted.
#   pause → delete the specialist pod → resume → the release moves on
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

T=$(env_of deployment-agent TASK_STORE_URI)
S=$(env_of deployment-agent SESSION_SERVICE_URI)
if [ -z "$T" ] && [ -z "$S" ]; then
  skip "lab 80 not applied (deployment-agent has no TASK_STORE_URI) — skipping"
  exit 0
fi
need_probe
[ -n "$T" ] && ok "task store    $T" || no "TASK_STORE_URI not set on deployment-agent"
[ -n "$S" ] && ok "session store $S" || no "SESSION_SERVICE_URI not set — the resume will 'complete' wrongly"

OUT=$(probe pause 2>&1)
if echo "$OUT" | grep -q "parked at request_change_approval"; then
  ok "parked a release at the approval gate"
else
  no "could not park a release:"; echo "$OUT" | tail -8 | sed 's/^/      /'; exit 1
fi

restart_pod deployment-agent
ok "deleted the specialist pod; a new one is serving"

OUT=$(probe resume 2>&1); RC=$?
if [ $RC -eq 0 ]; then
  ok "approval landed after the restart: $(echo "$OUT" | grep '✓' | tail -1 | sed 's/^✓ //')"
else
  no "the resume did not land:"; echo "$OUT" | grep -E "✗|states|says" | sed 's/^/      /'
fi
exit $FAIL
