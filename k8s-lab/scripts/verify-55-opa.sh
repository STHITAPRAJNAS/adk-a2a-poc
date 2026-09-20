#!/usr/bin/env bash
# Gate 5.5 — OPA policy, both layers.
#   network layer: Envoy ext_authz (card allowed, POST needs x-change-ticket)
#   application layer: the tools policy engine answers over REST (start_deployment
#                      to production is denied) — provable before any agent wiring.
set -uo pipefail
NS=agents
BASE="${BASE:-http://a2a.localhost:8080}"
FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

REQ='{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{"messageId":"m1","kind":"message","role":"user","parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}'

echo "── network layer (Envoy ext_authz → OPA)"
C=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE/a2a/ops_concierge/.well-known/agent-card.json")
[ "$C" = 200 ] && ok "GET card allowed ($C)" || no "GET card got $C (want 200)"

C=$(curl -sS -m 12 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
      -H 'accept: text/event-stream' -d "$REQ" "$BASE/a2a/ops_concierge")
[ "$C" = 403 ] && ok "POST without x-change-ticket denied ($C)" || no "POST without ticket got $C (want 403)"

C=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
      -H 'accept: text/event-stream' -H 'x-change-ticket: CHG-0001' -d "$REQ" "$BASE/a2a/ops_concierge")
[ "$C" = 200 ] && ok "POST with x-change-ticket allowed ($C)" || no "POST with ticket got $C (want 200)"

echo "── application layer (tools policy over OPA REST)"
probe() {  # $1=json input  -> prints "true"/"false"
  kubectl -n "$NS" run opa-probe-$$-$RANDOM --rm -i --restart=Never --image=curlimages/curl -q -- \
    curl -sS -m 8 http://opa:8181/v1/data/tools/allow -d "$1" 2>/dev/null | tr -d ' \n'
}
D=$(probe '{"input":{"agent":"deployment_agent","tool":"start_deployment","args":{"environment":"production"}}}')
echo "$D" | grep -q '"result":false' && ok "start_deployment→production DENIED by tools policy" || no "prod deploy check: ${D:-<empty>}"

D=$(probe '{"input":{"agent":"deployment_agent","tool":"start_deployment","args":{"environment":"staging"}}}')
echo "$D" | grep -q '"result":true' && ok "start_deployment→staging ALLOWED by tools policy" || no "staging deploy check: ${D:-<empty>}"

D=$(probe '{"input":{"agent":"ops_concierge","tool":"transfer_to_agent","args":{"agent_name":"deployment_agent"}}}')
echo "$D" | grep -q '"result":true' && ok "concierge→transfer(deployment_agent) ALLOWED" || no "concierge transfer check: ${D:-<empty>}"

exit $FAIL
