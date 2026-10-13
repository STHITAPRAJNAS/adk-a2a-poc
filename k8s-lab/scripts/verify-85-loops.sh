#!/usr/bin/env bash
# Lab 85 — a delegation loop between loop-a and loop-b is refused, quickly, and
# the caller is told why.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n "$NS" get deploy loop-a >/dev/null 2>&1; then
  skip "lab 85 not applied (no loop-a) — skipping"
  exit 0
fi
need_probe
for d in loop-a loop-b; do
  H=$(env_of "$d" A2A_MAX_HOPS)
  [ "${H:-0}" -ge 2 ] 2>/dev/null && ok "$d guards loops (A2A_MAX_HOPS=$H)" \
    || no "A2A_MAX_HOPS is '${H:-unset}' on $d (step 2 sets 4)"
done

A=http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge
B=http://loop-b.agents.svc.cluster.local:8000/a2a/ops_concierge
OUT=$(kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/a2a_loop_probe.py \
        --entry "$A" --agents "$A" "$B" --deadline 30 2>&1); RC=$?
case $RC in
  0) ok "the request ended instead of bouncing" ;;
  3) no "LOOP: still bouncing after 30s (restart loop-a and loop-b to stop it)" ;;
  *) no "loop probe failed:"; echo "$OUT" | tail -6 | sed 's/^/      /' ;;
esac
echo "$OUT" | grep -q "Delegation loop" && ok "the caller was told it was a delegation loop" \
  || no "the answer did not name the loop"
exit $FAIL
