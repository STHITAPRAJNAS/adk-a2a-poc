#!/usr/bin/env bash
# Build the agent image for the cluster's architecture and make it available to
# kind.
#
#   ./build.sh                 build + load into kind (simple, no registry)
#   ./build.sh --registry      build + push to localhost:5001 (faster rebuilds)
#   ./build.sh --platform arm64   override arch, e.g. for Graviton node groups
set -euo pipefail

cd "$(dirname "$0")/.."
source ./versions.env

REPO_ROOT="$(cd .. && pwd)"
IMAGE_NAME="${IMAGE_NAME:-adk-a2a-agent}"
IMAGE_TAG="${IMAGE_TAG:-dev}"
CLUSTER="${CLUSTER:-a2a-lab}"
PLATFORM="linux/amd64"
USE_REGISTRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) USE_REGISTRY=1; shift ;;
    --platform) PLATFORM="linux/$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ "$USE_REGISTRY" = "1" ]; then
  IMAGE="localhost:${LOCAL_REGISTRY_PORT}/${IMAGE_NAME}:${IMAGE_TAG}"
else
  IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
fi

echo "building ${IMAGE} for ${PLATFORM}"
echo "  context: ${REPO_ROOT}   (the repo root — the agent packages live there)"

docker build \
  --platform "${PLATFORM}" \
  -f images/Dockerfile \
  -t "${IMAGE}" \
  "${REPO_ROOT}"

if [ "$USE_REGISTRY" = "1" ]; then
  docker push "${IMAGE}"
  echo "pushed ${IMAGE}"
  echo "  charts should use repository: localhost:${LOCAL_REGISTRY_PORT}/${IMAGE_NAME}"
else
  # kind nodes have their own containerd; an image in your local Docker is not
  # visible to them until it is loaded in.
  kind load docker-image "${IMAGE}" --name "${CLUSTER}"
  echo "loaded ${IMAGE} into kind cluster ${CLUSTER}"
  echo "  charts should use pullPolicy: IfNotPresent — there is no registry to pull from"
fi
