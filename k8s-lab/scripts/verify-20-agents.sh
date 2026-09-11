#!/usr/bin/env bash
set -uo pipefail
NS=agents; FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

for d in ops-concierge deployment-agent; do
  R=$(kubectl -n $NS get deploy $d -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${R:-0}" -ge 1 ] && ok "$d ready" || no "$d not ready"
done

kubectl -n $NS exec deploy/ops-concierge -- test -f /etc/a2a/deployment-agent.json 2>/dev/null \
  && ok "peer agent card mounted" || no "peer card missing at /etc/a2a/deployment-agent.json"

CARD_URL=$(kubectl -n $NS exec deploy/ops-concierge -- cat /etc/a2a/deployment-agent.json 2>/dev/null | jq -r '.url // empty')
case "$CARD_URL" in
  *deployment-agent.agents.svc.cluster.local*) ok "peer card points at the Service" ;;
  *) no "peer card url looks wrong: ${CARD_URL:-<none>}" ;;
esac

echo "  driving one negotiation…"
OUT=$(kubectl -n $NS run verify-$$ --rm -i --restart=Never --image=curlimages/curl -- \
  curl -sN http://ops-concierge:8000/a2a/ops_concierge \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"v1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}' 2>/dev/null)

echo "$OUT" | grep -q 'input-required' \
  && ok "negotiation reached input-required — the A2A hop worked and parked" \
  || no "no input-required state; check ops-concierge logs"

exit $FAIL
