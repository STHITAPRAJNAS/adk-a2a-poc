#!/usr/bin/env bash
set -uo pipefail
NS=agents; FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

M=$(kubectl get ns $NS -o jsonpath='{.metadata.labels.istio\.io/dataplane-mode}' 2>/dev/null)
[ "$M" = "ambient" ] && ok "namespace enrolled in ambient" || no "namespace not enrolled (got '${M:-none}')"

kubectl -n istio-system get ds ztunnel >/dev/null 2>&1 && ok "ztunnel DaemonSet present" || no "ztunnel missing"

if command -v istioctl >/dev/null 2>&1; then
  # Dump all workloads and filter by the NAMESPACE column ($1). The older
  # `--namespace` flag was rejected by newer istioctl (client 1.31 vs mesh
  # 1.30), so do the filtering here — robust across the version skew.
  istioctl ztunnel-config workload 2>/dev/null | awk -v ns="$NS" '$1==ns' | grep -q HBONE \
    && ok "workloads speaking HBONE (mTLS)" || no "no HBONE workloads found"
fi

echo "  checking an unauthorised caller is refused…"
# Use a long-lived pod + exec so ztunnel has captured it before we curl (a
# --rm one-shot races capture), and so the http_code is the only thing on
# stdout (kubectl's "--rm ... deleted" message used to get concatenated onto
# it and break the parse). A ztunnel L4 deny RESETS the connection — curl then
# reports 000, not 403; 403 is the L7/waypoint form. Either means refused.
POD="impostor-$$"
kubectl -n $NS run "$POD" --image=curlimages/curl --restart=Never --command -- sleep 120 >/dev/null 2>&1
kubectl -n $NS wait --for=condition=Ready "pod/$POD" --timeout=30s >/dev/null 2>&1
sleep 3
CODE=$(kubectl -n $NS exec "$POD" -- curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
  http://deployment-agent:8001/a2a/deployment_agent/.well-known/agent-card.json 2>/dev/null)
kubectl -n $NS delete pod "$POD" --wait=false >/dev/null 2>&1
case "$CODE" in
  ""|000|403) ok "impostor refused (code ${CODE:-000} — L4 reset)" ;;
  200) no "impostor got 200 — AuthorizationPolicy not applied or not matching" ;;
  *) no "unexpected code ${CODE}" ;;
esac

exit $FAIL
