#!/usr/bin/env bash
# Lab 88 — a release parked at the approval gate survives a Sandbox suspend.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n "$NS" get sandbox release-agent >/dev/null 2>&1; then
  skip "lab 88 not applied (no sandbox/release-agent) — skipping"
  exit 0
fi
need_probe

mode() {
  kubectl -n "$NS" patch sandbox release-agent --type merge -p "{\"spec\":{\"operatingMode\":\"$1\"}}" >/dev/null
}
pods() { kubectl -n "$NS" get pods -l app=release-agent-sandbox --no-headers 2>/dev/null | grep -vc Terminating; }

mode Running
kubectl -n "$NS" wait --for=condition=Ready sandbox/release-agent --timeout=180s >/dev/null \
  && ok "the Sandbox is running" || { no "the Sandbox did not become Ready"; exit $FAIL; }
SB=$(kubectl -n "$NS" get sandbox release-agent -o jsonpath='{.status.serviceFQDN}')
[ -n "$SB" ] && ok "stable name: $SB" || { no "no status.serviceFQDN (is service: true set?)"; exit $FAIL; }
URL="http://$SB:8001/a2a/deployment_agent"
sbprobe() {
  kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 A2A_PROBE_STATE=/tmp/verify88.json \
    python scripts/a2a_prod_probe.py --entry "$URL" --specialist "$URL" "$@" 2>&1
}

OUT=$(sbprobe pause)
echo "$OUT" | grep -q "parked at request_change_approval" && ok "parked a release at the approval gate" \
  || { no "could not park a release:"; echo "$OUT" | tail -5 | sed 's/^/      /'; exit $FAIL; }
BEFORE=$(kubectl -n "$NS" get pods -l app=release-agent-sandbox -o jsonpath='{.items[0].metadata.uid}')

mode Suspended
for _ in $(seq 1 60); do [ "$(pods)" = 0 ] && break; sleep 2; done
[ "$(pods)" = 0 ] && ok "suspended: the pod is gone" || no "the pod is still there after suspending"
kubectl -n "$NS" get pvc --no-headers 2>/dev/null | grep -q "state" \
  && ok "the disk is kept while suspended" || no "no PVC for the Sandbox's state volume"

mode Running
kubectl -n "$NS" wait --for=condition=Ready sandbox/release-agent --timeout=180s >/dev/null \
  && ok "resumed" || { no "the Sandbox did not become Ready again"; exit $FAIL; }
AFTER=$(kubectl -n "$NS" get pods -l app=release-agent-sandbox -o jsonpath='{.items[0].metadata.uid}')
[ "$BEFORE" != "$AFTER" ] && ok "a new pod, on the same disk" || no "the pod was not replaced"

OUT=$(sbprobe resume); RC=$?
[ $RC -eq 0 ] && ok "the approval landed after suspend and resume" \
  || { no "the approval did not land:"; echo "$OUT" | grep -E "✗|states|says" | sed 's/^/      /'; }
exit $FAIL
