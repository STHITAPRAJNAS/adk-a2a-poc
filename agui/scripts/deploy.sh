#!/usr/bin/env bash
# Deploy Postgres, two agui-server pods (starting on ag-ui-adk 0.8.0) and the
# demo page into the agents namespace, and wait until they are ready.
set -euo pipefail
cd "$(dirname "$0")/../.."
NS=agents

if ! kubectl -n "$NS" get secret agui-db >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic agui-db --from-literal=password="$(openssl rand -hex 24)"
fi
kubectl apply -f agui/k8s/postgres.yaml
kubectl -n "$NS" rollout status deploy/agui-postgres --timeout=180s
kubectl apply -f agui/k8s/agui-server.yaml -f agui/k8s/frontend.yaml
kubectl -n "$NS" rollout status statefulset/agui-server --timeout=300s
kubectl -n "$NS" rollout status deploy/agui-frontend --timeout=120s
if kubectl get crd authorizationpolicies.security.istio.io >/dev/null 2>&1; then
  kubectl apply -f agui/k8s/mesh-allow.yaml
fi
echo
kubectl -n "$NS" get pods -l app=agui-server -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName,READY:.status.containerStatuses[0].ready'
