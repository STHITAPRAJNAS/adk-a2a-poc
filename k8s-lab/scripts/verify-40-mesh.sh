#!/usr/bin/env bash
set -uo pipefail
NS=agents; FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

M=$(kubectl get ns $NS -o jsonpath='{.metadata.labels.istio\.io/dataplane-mode}' 2>/dev/null)
[ "$M" = "ambient" ] && ok "namespace enrolled in ambient" || no "namespace not enrolled (got '${M:-none}')"

kubectl -n istio-system get ds ztunnel >/dev/null 2>&1 && ok "ztunnel DaemonSet present" || no "ztunnel missing"

if command -v istioctl >/dev/null 2>&1; then
  istioctl ztunnel-config workload --namespace $NS 2>/dev/null | grep -q HBONE \
    && ok "workloads speaking HBONE (mTLS)" || no "no HBONE workloads found"
fi

echo "  checking an unauthorised caller is refused…"
CODE=$(kubectl -n $NS run impostor-$$ --rm -i --restart=Never --image=curlimages/curl -- \
  curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
  http://deployment-agent:8001/a2a/deployment_agent/.well-known/agent-card.json 2>/dev/null | tail -1)
case "$CODE" in
  000|403) ok "impostor refused (code ${CODE})" ;;
  200) no "impostor got 200 — AuthorizationPolicy not applied or not matching" ;;
  *) no "unexpected code ${CODE}" ;;
esac

exit $FAIL
