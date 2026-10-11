#!/usr/bin/env bash
# Run agui/scripts/repro.py inside the cluster: run 1 to agui-server-0, run 2 to
# agui-server-1, run 3 (a reconnect with nothing new) back to agui-server-0.
# Exit 0 = each question stored once (fixed), 3 = duplicate (ag-ui#2603).
set -uo pipefail
NS=agents
P0="http://agui-server-0.agui-server-pods.$NS.svc.cluster.local:8080"
P1="http://agui-server-1.agui-server-pods.$NS.svc.cluster.local:8080"
for p in agui-server-0 agui-server-1; do
  printf '%s  ' "$p"
  kubectl -n "$NS" get pod "$p" -o jsonpath='{.spec.containers[0].image}{"\n"}'
done
kubectl -n "$NS" exec agui-server-0 -- python agui/scripts/repro.py --a "$P0" --b "$P1"
