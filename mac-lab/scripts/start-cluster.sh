#!/usr/bin/env bash
# Bring the kind cluster back after a Mac reboot (or ./stop-cluster.sh).
#
# The cluster is kind — Docker containers, not real EKS — so a reboot STOPS it
# but does not DESTROY it. etcd, your deployments and the volumes all persist
# inside the node containers; this script starts the pieces back up in the right
# order, reapplies the kernel limits Istio needs, and waits for the API.
#
#   ./scripts/start-cluster.sh
#
# It does NOT export KUBECONFIG into your shell (a script runs in a subshell) —
# it prints the line to run. Better: keep it in ~/.zshrc so every shell has it.
set -euo pipefail

CLUSTER="${CLUSTER:-a2a-lab}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # -> mac-lab/
KCFG="$HERE/labs/10-cluster/kubeconfig"

echo "==> 1/4  Docker Desktop"
# On macOS the Docker daemon lives inside Docker Desktop. A reboot leaves it
# stopped until you (or launch-at-login) start the app. Nudge it, then wait.
if ! docker info >/dev/null 2>&1; then
  echo "         Docker not responding — launching Docker Desktop…"
  open -a Docker 2>/dev/null || true
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
docker info >/dev/null || { echo "         Docker still down — start Docker Desktop by hand" >&2; exit 1; }
echo "         docker is up"

echo "==> 2/4  kind node containers"
# Each Kubernetes node is one Docker container. A reboot leaves them 'Exited';
# start every container whose name matches the cluster. (bash 3.2-safe: no
# mapfile — macOS ships bash 3.2.)
NODES=$(docker ps -a --filter "name=${CLUSTER}" -q)
if [ -z "$NODES" ]; then
  echo "         no '${CLUSTER}' containers found." >&2
  echo "         the cluster may need rebuilding: make clean && (cd labs/10-cluster && terraform apply)" >&2
  exit 1
fi
# shellcheck disable=SC2086
docker start $NODES >/dev/null
echo "         started $(echo "$NODES" | wc -l | tr -d ' ') node container(s)"

echo "==> 3/4  kernel limits for Istio (reset when a node restarts)"
# Docker Desktop's VM defaults are too low for Istio's CNI; reapply per node.
for n in $NODES; do
  docker exec "$n" sysctl -w fs.inotify.max_user_instances=8192 >/dev/null 2>&1 || true
  docker exec "$n" sysctl -w fs.inotify.max_user_watches=524288 >/dev/null 2>&1 || true
done
echo "         inotify limits raised on every node"

echo "==> 4/4  waiting for the API server and nodes to be Ready"
export KUBECONFIG="$KCFG"
# containerd + kubelet inside each node take a few seconds to come back up.
kubectl wait --for=condition=Ready nodes --all --timeout=180s
echo
kubectl get nodes
echo
echo "cluster is up."
echo "  • this shell already has KUBECONFIG; NEW shells need:"
echo "        export KUBECONFIG=$KCFG      (put it in ~/.zshrc once)"
echo "  • port-forwards never survive a reboot — restart the ones you need."
