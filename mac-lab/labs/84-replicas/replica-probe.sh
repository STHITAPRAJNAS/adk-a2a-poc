#!/usr/bin/env bash
# Lab 84 — run the replica probe from the probe pod against the two
# deployment-agent-ha pods, by pod IP: A runs the release, B gets the call.
#
#   ./labs/84-replicas/replica-probe.sh subscribe
#   ./labs/84-replicas/replica-probe.sh cancel
set -euo pipefail
CMD="${1:?usage: replica-probe.sh subscribe|cancel}"
NS=agents
IPS=$(kubectl -n "$NS" get pods -l app=deployment-agent-ha --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}' | head -2)
A=$(echo "$IPS" | sed -n 1p)
B=$(echo "$IPS" | sed -n 2p)
if [ -z "$A" ] || [ -z "$B" ]; then
  echo "need two running deployment-agent-ha pods; have: ${IPS:-none}" >&2
  exit 1
fi
POD_A=$(kubectl -n "$NS" get pods -l app=deployment-agent-ha -o jsonpath="{.items[?(@.status.podIP==\"$A\")].metadata.name}")
POD_B=$(kubectl -n "$NS" get pods -l app=deployment-agent-ha -o jsonpath="{.items[?(@.status.podIP==\"$B\")].metadata.name}")
echo "A = $POD_A ($A)   B = $POD_B ($B)"
kubectl -n "$NS" exec a2a-probe -- python scripts/a2a_replica_probe.py "$CMD" \
  --a "http://$A:8001/a2a/deployment_agent" --b "http://$B:8001/a2a/deployment_agent"
