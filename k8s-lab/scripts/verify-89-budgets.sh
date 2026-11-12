#!/usr/bin/env bash
# Lab 89 — a token budget rides on every hop; each agent charges its model
# calls to it and stops, with a sentence, when it is spent.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

C=$(env_of ops-concierge A2A_TOKEN_BUDGET)
D=$(env_of deployment-agent A2A_TOKEN_BUDGET)
if [ -z "$C$D" ]; then
  skip "lab 89 not applied (no A2A_TOKEN_BUDGET on either agent) — skipping"
  exit 0
fi
need_probe
for pair in "ops-concierge:$C" "deployment-agent:$D"; do
  d=${pair%%:*}; v=${pair#*:}
  [ "${v:-0}" -gt 0 ] 2>/dev/null && ok "$d has a budget (A2A_TOKEN_BUDGET=$v)" \
    || no "A2A_TOKEN_BUDGET is '${v:-unset}' on $d (step 1 sets 100000)"
done

OUT=$(probe pause 2>&1); RC=$?
case $RC in
  0) ok "the release parked at the gate within its budget" ;;
  5) ok "the release stopped at the budget, and said so" ;;
  *) no "release probe failed:"; echo "$OUT" | tail -6 | sed 's/^/      /' ;;
esac

LOG=$(kubectl -n "$NS" logs deploy/deployment-agent --since=2m 2>/dev/null)
SPENT=$(echo "$LOG" | grep "budget on" | tail -1 | sed 's/.*budget on //')
if [ -n "$SPENT" ]; then
  ok "the release agent charged its model calls: $SPENT"
elif grep -q "refusing a request with no budget left" <<<"$LOG"; then
  ok "the release agent refused a request that arrived with no budget left"
else
  no "no budget lines in the release agent's log (old image? run make image)"
fi
exit $FAIL
