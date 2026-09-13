#!/usr/bin/env bash
# Bring the kind cluster back after a Windows reboot (or ./stop-cluster.sh).
#
# The cluster is kind — Docker containers, not real EKS — so a reboot STOPS it
# but does not DESTROY it. etcd, your deployments and the volumes all persist
# inside the node containers; this script just starts the pieces back up in the
# right order and waits for the API to answer.
#
#   ./scripts/start-cluster.sh
#
# It does NOT export KUBECONFIG into your shell (a script runs in a subshell) —
# it prints the line to run. Better: keep it in ~/.bashrc so every shell has it.
set -euo pipefail

CLUSTER="${CLUSTER:-a2a-lab}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # -> k8s-lab/
KCFG="$HERE/labs/10-cluster/kubeconfig"

echo "==> 1/4  Docker daemon"
# docker-ce runs under systemd inside WSL. If the reboot (or a missing
# systemd=true in /etc/wsl.conf) left it down, start it.
sudo service docker start 2>/dev/null || sudo systemctl start docker
docker info >/dev/null
echo "         docker is up"

echo "==> 2/4  kind node containers"
# Each Kubernetes node is one Docker container. A reboot leaves them 'Exited';
# start every container whose name matches the cluster.
mapfile -t NODES < <(docker ps -a --filter "name=${CLUSTER}" -q)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "         no '${CLUSTER}' containers found." >&2
  echo "         the cluster may need rebuilding: make clean && (cd labs/10-cluster && terraform apply)" >&2
  exit 1
fi
docker start "${NODES[@]}" >/dev/null
echo "         started ${#NODES[@]} node container(s)"

echo "==> 3/4  kubeconfig (this shell only)"
export KUBECONFIG="$KCFG"
echo "         KUBECONFIG=$KCFG"

echo "==> 4/4  waiting for the API server and nodes to be Ready"
# containerd + kubelet inside each node take a few seconds to come back up.
kubectl wait --for=condition=Ready nodes --all --timeout=180s
echo
kubectl get nodes
echo
echo "cluster is up."
echo "  • this shell already has KUBECONFIG; NEW shells need:"
echo "        export KUBECONFIG=$KCFG      (put it in ~/.bashrc once)"
echo "  • GPU LLM was scaled down? bring it back:"
echo "        kubectl -n llm scale deploy/ollama deploy/open-webui --replicas=1"
echo "  • port-forwards never survive a reboot — restart the ones you need."
