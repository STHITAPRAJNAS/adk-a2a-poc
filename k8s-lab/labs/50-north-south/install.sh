#!/usr/bin/env bash
# Envoy Gateway — a Gateway API implementation for north-south HTTP.
set -euo pipefail
cd "$(dirname "$0")"
source ../../versions.env
: "${KUBECONFIG:?export KUBECONFIG=\$PWD/../10-cluster/kubeconfig first}"

echo "==> Envoy Gateway ${ENVOY_GATEWAY_VERSION}"
# Gateway API CRDs were installed standalone in lab 40, so skip this chart's
# copy rather than letting two installers own the same CRDs.
helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm \
  --version "${ENVOY_GATEWAY_VERSION}" \
  -n envoy-gateway-system --create-namespace \
  --set crds.gatewayAPI.enabled=false \
  --wait

kubectl -n envoy-gateway-system rollout status deploy/envoy-gateway
echo "ready"
