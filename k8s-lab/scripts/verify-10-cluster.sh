#!/usr/bin/env bash
set -uo pipefail
FAIL=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

READY=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ')
[ "$READY" -ge 4 ] && ok "$READY nodes Ready" || no "expected 4 nodes Ready, got ${READY:-0}"

kubectl -n kube-system get ds kindnet >/dev/null 2>&1 && ok "CNI running" || no "kindnet missing"
kubectl -n kube-system get deploy coredns >/dev/null 2>&1 && ok "coredns present" || no "coredns missing"

PENDING=$(kubectl get pods -A --no-headers 2>/dev/null | grep -c Pending)
[ "$PENDING" = 0 ] && ok "no pending pods" || no "$PENDING pods Pending — likely low memory"

exit $FAIL
