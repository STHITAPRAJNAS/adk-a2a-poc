#!/usr/bin/env bash
# Istio in ambient mode, via Helm.
#
# Four charts, in this order, and the order matters:
#   base      CRDs and cluster roles
#   istiod    the control plane
#   cni       wires pods into the mesh (ambient needs this; sidecar mode does not)
#   ztunnel   the per-node L4 proxy that does mTLS
set -euo pipefail
cd "$(dirname "$0")"
source ../../versions.env

: "${KUBECONFIG:?export KUBECONFIG=\$PWD/../10-cluster/kubeconfig first}"

echo "==> Gateway API CRDs (${GATEWAY_API_VERSION})"
# Installed standalone rather than letting Istio or Envoy Gateway own them.
# Both want them; whichever you install second would otherwise either skip them
# or fight over the version.
kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/${GATEWAY_API_CHANNEL}-install.yaml"

helm repo add istio https://istio-release.storage.googleapis.com/charts >/dev/null 2>&1 || true
helm repo update istio >/dev/null

echo "==> istio-base ${ISTIO_VERSION}"
helm upgrade --install istio-base istio/base \
  -n istio-system --create-namespace --version "${ISTIO_VERSION}" --wait

echo "==> istiod (profile=ambient)"
helm upgrade --install istiod istio/istiod \
  -n istio-system --version "${ISTIO_VERSION}" \
  --set profile=ambient \
  --wait

echo "==> istio-cni"
helm upgrade --install istio-cni istio/cni \
  -n istio-system --version "${ISTIO_VERSION}" \
  --set profile=ambient \
  --wait

echo "==> ztunnel"
helm upgrade --install ztunnel istio/ztunnel \
  -n istio-system --version "${ISTIO_VERSION}" --wait

echo
kubectl -n istio-system get pods
echo
echo "ztunnel is a DaemonSet — one per node, not one per pod. That is the"
echo "whole difference from sidecars."
