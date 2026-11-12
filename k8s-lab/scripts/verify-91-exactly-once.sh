#!/usr/bin/env bash
# Lab 91 — a lost CD response, retried, still gives ONE deployment per approval.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n "$NS" get deploy cd-system >/dev/null 2>&1; then
  skip "lab 91 not applied (no cd-system) — skipping"
  exit 0
fi
need_probe
CD=http://cd-system.agents.svc.cluster.local:8420
cdprobe() { kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/cd_probe.py "$@"; }

U=$(env_of deployment-agent CD_URL)
K=$(env_of deployment-agent IDEMPOTENT_DEPLOYS)
[ -n "$U" ] && ok "the release agent calls the CD system ($U)" \
  || no "CD_URL is not set on deployment-agent (Before you start, step 3)"
[ "$K" = 1 ] && ok "it sends the approval ticket as Idempotency-Key" \
  || no "IDEMPOTENT_DEPLOYS is '${K:-unset}' on deployment-agent (step 3 sets 1)"

cdprobe reset "$CD" >/dev/null 2>&1
OUT=$(probe pause 2>&1) || { no "release did not park:"; echo "$OUT" | tail -4 | sed 's/^/      /'; exit 1; }
cdprobe lose-next "$CD" >/dev/null 2>&1
OUT=$(probe resume 2>&1); RC=$?
[ $RC -eq 0 ] && ok "approved; the release agent called the CD system with one answer lost" \
  || { no "resume failed:"; echo "$OUT" | tail -4 | sed 's/^/      /'; }
grep -q "after [2-9] attempt" <<<"$OUT" && ok "it retried after the lost answer" \
  || no "no retry seen (was the answer lost? is CD_URL set?)"

LIST=$(cdprobe list "$CD" 2>&1); RC=$?
case $RC in
  0) grep -q "ledger: 1$" <<<"$LIST" && ok "the ledger holds one deployment for the approval" \
       || no "unexpected ledger: $(head -1 <<<"$LIST")" ;;
  6) no "$(grep DEPLOYED <<<"$LIST" | sed 's/^✗ //')" ;;
  *) no "could not read the CD ledger" ;;
esac
exit $FAIL
