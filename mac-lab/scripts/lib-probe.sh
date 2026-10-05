#!/usr/bin/env bash
# Shared by verify-80..83. Bash 3.2-safe (macOS ships 3.2).
NS=agents
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()   { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
skip() { printf '  \033[2m– %s\033[0m\n' "$1"; }

# env_of DEPLOY VAR -> value of VAR on the deployment's agent container, or ""
env_of() {
  kubectl -n "$NS" get deploy "$1" \
    -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name==\"$2\")].value}" 2>/dev/null
}

need_probe() {
  if ! kubectl -n "$NS" get pod a2a-probe >/dev/null 2>&1; then
    skip "no probe pod — run: make probe"
    exit 0
  fi
  kubectl -n "$NS" wait --for=condition=Ready pod/a2a-probe --timeout=90s >/dev/null
}

# probe ARGS... -> runs the production probe inside the cluster
probe() {
  kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/a2a_prod_probe.py "$@"
}

restart_pod() {  # restart_pod RELEASE
  kubectl -n "$NS" delete pod -l "app.kubernetes.io/instance=$1" --wait=false >/dev/null
  sleep 2
  kubectl -n "$NS" rollout status "deploy/$1" --timeout=180s >/dev/null
}
