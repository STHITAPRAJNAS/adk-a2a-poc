#!/usr/bin/env bash
# Gate 1 (Mac variant) — a 3-node cluster: 1 control-plane + a 2-node 'general'
# node group. No GPU node group on the Mac lab, so no GPU/taint checks here.
set -uo pipefail
FAIL=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }

READY=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ')
[ "$READY" -ge 3 ] && ok "$READY nodes Ready" || no "expected 3 nodes Ready, got ${READY:-0}"

GEN=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=general --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "$GEN" -ge 2 ] && ok "node group 'general': $GEN nodes" || no "node group 'general' has $GEN nodes"

# There must be NO gpu-a10g node group on the Mac lab.
GPU=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=gpu-a10g --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "$GPU" -eq 0 ] && ok "no GPU node group (expected on Mac)" || no "found $GPU gpu-a10g node(s) — set gpu_worker_count=0"

ZONES=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}' 2>/dev/null | grep -c . )
[ "$ZONES" -ge 2 ] && ok "$ZONES nodes carry a zone label" || no "zone labels missing — topologySpread will be meaningless"

exit $FAIL
