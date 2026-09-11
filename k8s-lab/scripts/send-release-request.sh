#!/usr/bin/env bash
# One A2A negotiation against whatever endpoint you point at, printing the task
# state transitions. Used by several labs.
#
#   ./send-release-request.sh [base-url] [app-name]
#
# default: http://localhost:8000  ops_concierge
set -euo pipefail
BASE="${1:-http://localhost:8000}"
APP="${2:-ops_concierge}"
PROMPT="${PROMPT:-deploy checkout-api 2.14.0 to production}"

curl -sN "${BASE}/a2a/${APP}" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"message/stream\",\"params\":{\"message\":{
        \"messageId\":\"$(date +%s)\",\"kind\":\"message\",\"role\":\"user\",
        \"parts\":[{\"kind\":\"text\",\"text\":\"${PROMPT}\"}]}}}" \
  | tee /tmp/a2a-stream.$$ \
  | grep -o '"state":"[a-z-]*"' | uniq

echo
echo "task id: $(grep -o '"id":"[0-9a-f-]\{36\}"' /tmp/a2a-stream.$$ | head -1 | cut -d'"' -f4)"
rm -f /tmp/a2a-stream.$$
