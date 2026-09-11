#!/usr/bin/env bash
# Run the same A2A negotiation east-west and north-south, then show what each
# path left behind. This is the exercise the whole lab is built around.
set -uo pipefail
cd "$(dirname "$0")"
NS=agents

echo "═══ EAST-WEST — from a pod, inside the mesh ═══"
kubectl -n "$NS" run a2a-caller --rm -i --restart=Never --image=curlimages/curl -- \
  curl -sN http://ops-concierge:8000/a2a/ops_concierge \
    -H 'content-type: application/json' -H 'accept: text/event-stream' \
    -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
         "messageId":"ew1","kind":"message","role":"user",
         "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}' \
  2>/dev/null | grep -o '"state":"[a-z-]*"' | uniq

echo
echo "  no gateway was involved; identity came from a certificate."
echo "  mesh view:"
istioctl ztunnel-config workload --namespace "$NS" 2>/dev/null | head -5 || echo "  (istioctl not installed)"

echo
echo "═══ NORTH-SOUTH — from outside the cluster, through the gateway ═══"
./send-release-request.sh http://a2a.localhost:8080 ops_concierge || \
  echo "  gateway not reachable — is lab 50 applied?"

echo
echo "  gateway access log:"
kubectl -n "$NS" logs -l gateway.envoyproxy.io/owning-gateway-name=north-south --tail=5 2>/dev/null \
  || echo "  (no Envoy Gateway logs — lab 50 not installed)"

echo
echo "Same protocol. Same agents. Same result."
echo "Different evidence, because a boundary was crossed."
