#!/usr/bin/env bash
# Advertise a simulated accelerator resource on a node.
#
#   ./advertise-gpu.sh <node> [count]
#
# Extended resources live in a node's *status*, which is the kubelet's to write
# and is not reachable through a normal `kubectl label` or `patch`. This uses
# the /status subresource with a JSON-patch, which is the documented way to
# advertise an extended resource without a device plugin.
#
# On a real cluster a device plugin does this continuously. This is a one-shot
# poke: it does not survive a kubelet restart, because nothing re-reports it.
# That difference is the point, not a defect.
set -euo pipefail
NODE="${1:?usage: advertise-gpu.sh <node-name> [count]}"
COUNT="${2:-2}"

# "~1" is the JSON-pointer escape for "/" in the resource name.
kubectl proxy --port=8001 >/dev/null 2>&1 &
PROXY=$!
trap 'kill $PROXY 2>/dev/null || true' EXIT
sleep 2

curl -sS --fail-with-body \
  --header "Content-Type: application/json-patch+json" \
  --request PATCH \
  --data "[{\"op\":\"add\",\"path\":\"/status/capacity/lab.local~1gpu\",\"value\":\"${COUNT}\"}]" \
  "http://localhost:8001/api/v1/nodes/${NODE}/status" >/dev/null

echo "advertised lab.local/gpu=${COUNT} on ${NODE}"
kubectl get node "$NODE" -o jsonpath='{.status.allocatable}' | jq '.["lab.local/gpu"]'
