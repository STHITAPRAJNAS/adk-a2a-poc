#!/usr/bin/env bash
# Deploy the production-like setup into the agents namespace, starting on
# ag-ui-adk 0.8.0:
#
#   support-desk-web ×2 (CopilotKit + runtime) ──► adk-lb (nginx, round robin)
#        ──► support-desk ×3 (ADK + ag-ui-adk) ──► agui-postgres (shared)
#
# Reuses agui/'s Postgres and its agui-db Secret (created here if missing).
set -euo pipefail
cd "$(dirname "$0")/../../.."
NS=agents

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"
if ! kubectl -n "$NS" get secret agui-db >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic agui-db --from-literal=password="$(openssl rand -hex 24)"
fi
kubectl apply -f agui/k8s/postgres.yaml
kubectl -n "$NS" rollout status deploy/agui-postgres --timeout=180s

kubectl -n "$NS" create configmap adk-lb-conf \
  --from-file=default.conf.template=agui/prodlike/k8s/adk-lb.conf.template \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f agui/prodlike/k8s/support-desk.yaml -f agui/prodlike/k8s/adk-lb.yaml -f agui/prodlike/k8s/web.yaml
kubectl -n "$NS" rollout restart deploy/adk-lb >/dev/null

kubectl -n "$NS" rollout status deploy/support-desk --timeout=300s
kubectl -n "$NS" rollout status deploy/adk-lb --timeout=120s
kubectl -n "$NS" rollout status deploy/support-desk-web --timeout=180s
echo
kubectl -n "$NS" get pods -l 'app in (support-desk,adk-lb,support-desk-web,agui-postgres)' \
  -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName,READY:.status.containerStatuses[0].ready'
