#!/usr/bin/env bash
# Cleanly stop the lab without destroying it: halt the kind node containers.
#
# Stopping the node containers halts every pod at once — which frees the GPU
# (the model leaves VRAM) and all the RAM/CPU — while etcd and volumes stay on
# disk inside the (stopped) containers. Bring it all back with start-cluster.sh;
# your deployments resume at whatever replica counts they had.
#
#   ./scripts/stop-cluster.sh
#
# To pause ONLY the GPU workloads but keep Kubernetes running, don't use this —
# instead: kubectl -n llm scale deploy/ollama deploy/open-webui --replicas=0
set -euo pipefail

CLUSTER="${CLUSTER:-a2a-lab}"

mapfile -t NODES < <(docker ps --filter "name=${CLUSTER}" -q)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "no running '${CLUSTER}' containers — already stopped."
  exit 0
fi

echo "==> stopping ${#NODES[@]} kind node container(s) (halts the cluster, frees GPU + RAM)"
docker stop "${NODES[@]}" >/dev/null
echo "done. restart with: ./scripts/start-cluster.sh"
