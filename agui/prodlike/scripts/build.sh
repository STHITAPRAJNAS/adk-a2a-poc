#!/usr/bin/env bash
# Build the images for the production-like setup and load them into kind:
#   agui-server:0.8.0 / :0.9.0   the ADK app (same images as agui/; only the
#                                ag-ui-adk version differs)
#   support-desk-web:dev         the CopilotKit front end + runtime
#
#   ./agui/prodlike/scripts/build.sh
#   CLUSTER=my-cluster ./agui/prodlike/scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLUSTER="${CLUSTER:-a2a-lab}"

for v in 0.8.0 0.9.0; do
  echo "── agui-server:$v (ag-ui-adk==$v)"
  docker build -f agui/server/Dockerfile --build-arg "AG_UI_ADK_VERSION=$v" -t "agui-server:$v" .
done
echo "── support-desk-web:dev (CopilotKit)"
docker build -t support-desk-web:dev agui/prodlike/web

echo "── loading into kind cluster '$CLUSTER'"
kind load docker-image agui-server:0.8.0 agui-server:0.9.0 support-desk-web:dev --name "$CLUSTER"
echo "done"
