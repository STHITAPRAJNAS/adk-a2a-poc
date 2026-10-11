#!/usr/bin/env bash
# Build the two agui-server images (ag-ui-adk 0.8.0 = the bug, 0.9.0 = the fix)
# and the demo page, then load all three into the kind cluster.
#
#   ./agui/scripts/build.sh
#   CLUSTER=my-cluster ./agui/scripts/build.sh
#
# Builds for the machine's own architecture (arm64 on an Apple Silicon Mac,
# amd64 on Windows/WSL2), which is what its kind nodes run.
set -euo pipefail
cd "$(dirname "$0")/../.."
CLUSTER="${CLUSTER:-a2a-lab}"

for v in 0.8.0 0.9.0; do
  echo "── agui-server:$v (ag-ui-adk==$v)"
  docker build -f agui/server/Dockerfile --build-arg "AG_UI_ADK_VERSION=$v" -t "agui-server:$v" .
done
echo "── agui-frontend:dev"
docker build -t agui-frontend:dev agui/frontend

echo "── loading into kind cluster '$CLUSTER'"
kind load docker-image agui-server:0.8.0 agui-server:0.9.0 agui-frontend:dev --name "$CLUSTER"
echo "done"
