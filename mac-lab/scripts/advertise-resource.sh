#!/usr/bin/env bash
# Advertise a FAKE extended resource on a node, so lab 30 can teach "countable
# capacity" scheduling without a real device plugin.
#
#   ./advertise-resource.sh <node-name> [count] [resource-name]
#
# default resource: lab.local/accelerator   default count: 2
#
# This PATCHes the node's status.capacity via the API server (the same surface a
# device plugin ultimately writes). The honest difference from a real plugin: it
# does NOT survive a kubelet restart, because nothing re-reports it — which is
# exactly what a device plugin's continuous reporting buys you.
set -euo pipefail

NODE="${1:?usage: advertise-resource.sh <node-name> [count] [resource]}"
COUNT="${2:-2}"
RES="${3:-lab.local/accelerator}"
RES_ESC="${RES/\//~1}"   # JSON-pointer escape: '/' -> '~1'

PORT="${PROXY_PORT:-8899}"
kubectl proxy --port="$PORT" >/dev/null 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
sleep 1

curl -sS --header 'Content-Type: application/json-patch+json' \
  --request PATCH \
  --data "[{\"op\":\"add\",\"path\":\"/status/capacity/${RES_ESC}\",\"value\":\"${COUNT}\"}]" \
  "http://localhost:${PORT}/api/v1/nodes/${NODE}/status" >/dev/null

echo "advertised ${RES}=${COUNT} on ${NODE}"
kubectl get node "$NODE" -o jsonpath="{.status.allocatable.${RES}}" && echo " allocatable"
