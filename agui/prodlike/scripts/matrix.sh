#!/usr/bin/env bash
# Run the deterministic client matrix (agui/prodlike/loadtest/client_matrix.py)
# from inside a support-desk pod, sending each run to a chosen pod by IP.
# Needs at least 2 ready support-desk pods (3 for scenarios D-F).
#   ./agui/prodlike/scripts/matrix.sh
set -euo pipefail
NS=agents
IPS=$(kubectl -n "$NS" get pods -l app=support-desk --field-selector=status.phase=Running \
  -o jsonpath='{range .items[?(@.status.podIP)]}{.status.podIP}{"\n"}{end}')
URLS=$(for ip in $IPS; do printf 'http://%s:8080 ' "$ip"; done)
kubectl -n "$NS" exec deploy/support-desk -- python agui/prodlike/loadtest/client_matrix.py --pods $URLS
