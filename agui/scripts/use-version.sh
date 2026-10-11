#!/usr/bin/env bash
# Switch both agui-server pods to an ag-ui-adk version and wait for the rollout.
#   ./agui/scripts/use-version.sh 0.9.0
#   ./agui/scripts/use-version.sh 0.8.0
set -euo pipefail
V="${1:?usage: use-version.sh 0.8.0|0.9.0}"
kubectl -n agents set image statefulset/agui-server "server=agui-server:$V"
kubectl -n agents rollout status statefulset/agui-server --timeout=300s
kubectl -n agents get pods -l app=agui-server -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image'
