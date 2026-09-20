#!/usr/bin/env bash
# Cleanly stop the lab without destroying it: halt the kind node containers.
#
# Stopping the node containers halts every pod at once — freeing all the RAM/CPU
# Docker Desktop had reserved — while etcd and volumes stay on disk inside the
# (stopped) containers. Bring it all back with start-cluster.sh; your
# deployments resume at whatever replica counts they had.
#
#   ./scripts/stop-cluster.sh
#
# To pause only some workloads but keep Kubernetes running, don't use this —
# instead scale the deployments you want down: kubectl -n agents scale ... --replicas=0
set -euo pipefail

CLUSTER="${CLUSTER:-a2a-lab}"

# bash 3.2-safe (macOS ships bash 3.2): no mapfile.
NODES=$(docker ps --filter "name=${CLUSTER}" -q)
if [ -z "$NODES" ]; then
  echo "no running '${CLUSTER}' containers — already stopped."
  exit 0
fi

echo "==> stopping $(echo "$NODES" | wc -l | tr -d ' ') kind node container(s) (halts the cluster, frees RAM)"
# shellcheck disable=SC2086
docker stop $NODES >/dev/null
echo "done. restart with: ./scripts/start-cluster.sh"
