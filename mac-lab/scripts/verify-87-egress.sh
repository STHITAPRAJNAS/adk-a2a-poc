#!/usr/bin/env bash
# Lab 87 — the release agent has one way out, and it allows two tools.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n tools get deploy tools-gateway >/dev/null 2>&1; then
  skip "lab 87 not applied (no tools-gateway) — skipping"
  exit 0
fi
if ! kubectl -n agents get networkpolicy release-agent-egress >/dev/null 2>&1; then
  no "lockdown.yaml not applied (step 3)"
  exit $FAIL
fi

DIRECT=http://release-tools.tools.svc.cluster.local:3001/mcp
GATED=http://tools-gateway.tools.svc.cluster.local:3000/mcp
agentprobe() {
  kubectl -n "$NS" exec deploy/deployment-agent -- env NO_COLOR=1 python scripts/mcp_probe.py "$@" 2>&1
}

agentprobe web https://example.com >/dev/null; RC=$?
[ $RC -eq 3 ] && ok "the release agent cannot reach the internet" \
  || no "the release agent reached https://example.com: NetworkPolicy is not enforced, or the lockdown does not select it"

agentprobe list "$DIRECT" >/dev/null; RC=$?
[ $RC -eq 3 ] && ok "the release agent cannot reach the MCP server directly" \
  || no "the release agent reached release-tools directly (exit $RC)"

OUT=$(agentprobe list "$GATED"); RC=$?
if [ $RC -ne 0 ]; then
  no "the tools gateway did not answer:"; echo "$OUT" | tail -3 | sed 's/^/      /'
else
  N=$(echo "$OUT" | grep -cE "^  [a-z_]+ ")
  echo "$OUT" | grep -q "check_change_freeze" && echo "$OUT" | grep -q "get_release_notes" && [ "$N" -eq 2 ] \
    && ok "through the gateway it sees exactly the two safe tools" \
    || { no "the gateway shows $N tool(s), not the two safe ones:"; echo "$OUT" | sed 's/^/      /'; }
fi

agentprobe call "$GATED" check_change_freeze '{"environment":"production"}' >/dev/null \
  && ok "a safe tool call works through the gateway" || no "the safe tool call failed through the gateway"
agentprobe call "$GATED" rollback_production '{"service":"checkout-api"}' >/dev/null; RC=$?
[ $RC -eq 2 ] && ok "the dangerous tool is refused by the gateway" \
  || no "rollback_production was not refused by the gateway (exit $RC)"
exit $FAIL
