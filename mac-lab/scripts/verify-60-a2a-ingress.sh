#!/usr/bin/env bash
# Gate 6 (Mac / standalone agentgateway) — the A2A-aware proxy on :8081.
#
# We run agentgateway in pass-through, so the concierge still serves its OWN card
# (naming its Service, not the gateway). That's the "card is the contract" lesson,
# surfaced here as a NOTE rather than a failure — rewriting the card to name the
# gateway is a deliberate step you'd add for real external clients.
set -uo pipefail
BASE="${1:-http://a2a.localhost:8081}"; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; }

CARD=$(curl -sS --max-time 10 "${BASE}/a2a/ops_concierge/.well-known/agent-card.json" 2>/dev/null)
[ -n "$CARD" ] && ok "card served through the gateway (${BASE})" || no "no card at ${BASE} — is agentgateway up and NodePort 30081 mapped?"

URL=$(echo "$CARD" | jq -r '.supportedInterfaces[0].url // .url // empty' 2>/dev/null)
case "$URL" in
  "${BASE}"*) ok "card advertises the gateway URL ($URL)" ;;
  "") [ -n "$CARD" ] && note "card served but has no url field" ;;
  *) note "card advertises ${URL} (the backend Service) — pass-through; rewrite the card to name the gateway for real external clients" ;;
esac

echo "  driving one negotiation north-south through agentgateway…"
OUT=$(curl -sN --max-time 90 "${BASE}/a2a/ops_concierge" \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"ns1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}' 2>/dev/null)
echo "$OUT" | grep -q 'input-required' \
  && ok "negotiation parked on the approval gate (A2A flowed through the proxy)" \
  || no "no input-required — check 'kubectl -n agentgateway-system logs deploy/agentgateway' and the route"

exit $FAIL
