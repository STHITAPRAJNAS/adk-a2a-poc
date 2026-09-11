#!/usr/bin/env bash
set -uo pipefail
BASE="${1:-http://a2a.localhost:8081}"; FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

CARD=$(curl -sS --max-time 10 "${BASE}/a2a/ops_concierge/.well-known/agent-card.json" 2>/dev/null)
[ -n "$CARD" ] && ok "card served through the gateway" || no "no card at ${BASE}"

URL=$(echo "$CARD" | jq -r '.supportedInterfaces[0].url // .url // empty' 2>/dev/null)
case "$URL" in
  "${BASE}"*) ok "card advertises the gateway URL ($URL)" ;;
  "") no "card has no RPC url" ;;
  *) no "card advertises ${URL} — an external client will send RPC to the wrong place. Fix servedAgentCard." ;;
esac

echo "  driving one negotiation north-south…"
OUT=$(curl -sN --max-time 90 "${BASE}/a2a/ops_concierge" \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"ns1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}' 2>/dev/null)
echo "$OUT" | grep -q 'input-required' \
  && ok "north-south negotiation parked on the approval gate" \
  || no "no input-required — check the gateway route and its timeouts"

exit $FAIL
