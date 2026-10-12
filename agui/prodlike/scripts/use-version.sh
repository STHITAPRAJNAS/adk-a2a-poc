#!/usr/bin/env bash
# Roll the support-desk Deployment to an ag-ui-adk version (a normal rolling
# update, one pod at a time) and wait for it.
#   ./agui/prodlike/scripts/use-version.sh 0.9.0
#   ./agui/prodlike/scripts/use-version.sh 0.8.0
set -euo pipefail
V="${1:?usage: use-version.sh 0.8.0|0.9.0}"
kubectl -n agents set image deploy/support-desk "server=agui-server:$V"
kubectl -n agents rollout status deploy/support-desk --timeout=300s
kubectl -n agents get pods -l app=support-desk -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName'
