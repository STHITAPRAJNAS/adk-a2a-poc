#!/usr/bin/env bash
set -uo pipefail
FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
info() { printf '  \033[33m!\033[0m %s\n' "$1"; }

READY=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ')
[ "$READY" -ge 4 ] && ok "$READY nodes Ready" || no "expected 4 nodes Ready, got ${READY:-0}"

GEN=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=general --no-headers 2>/dev/null | wc -l)
GPU=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=gpu-a10g --no-headers 2>/dev/null | wc -l)
[ "$GEN" -ge 2 ] && ok "node group 'general': $GEN nodes" || no "node group 'general' has $GEN nodes"
[ "$GPU" -ge 1 ] && ok "node group 'gpu-a10g': $GPU nodes" || no "node group 'gpu-a10g' has $GPU nodes"

ZONES=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}' 2>/dev/null | grep -c . )
[ "$ZONES" -ge 3 ] && ok "$ZONES nodes carry a zone label" || no "zone labels missing — topologySpread will be meaningless"

GPU_NODE=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=gpu-a10g -o name 2>/dev/null | head -1 | cut -d/ -f2)
if [ -n "$GPU_NODE" ]; then
  kubectl get node "$GPU_NODE" -o jsonpath='{.spec.taints[*].key}' 2>/dev/null | grep -q 'nvidia.com/gpu' \
    && ok "GPU node tainted at registration" \
    || no "GPU node has no nvidia.com/gpu taint — general workloads will drift onto it"

  if docker exec "$GPU_NODE" ls /dev/dxg >/dev/null 2>&1; then
    ok "GPU device reached the node container (/dev/dxg)"
  else
    info "no /dev/dxg in the node — GPU injection off or failed. Lab 30's simulated path still works."
  fi
fi

exit $FAIL
