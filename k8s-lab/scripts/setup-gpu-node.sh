#!/usr/bin/env bash
# Configure containerd *inside* the kind GPU node to use the NVIDIA runtime.
#
# Lab 10 injected the GPU device into the node container. That makes the device
# visible on the node, but the node runs its own containerd, which will happily
# start pods without ever handing the GPU to them. This closes that gap.
#
#   ./setup-gpu-node.sh [node-container-name]
set -euo pipefail
NODE="${1:-a2a-lab-worker3}"

if ! docker ps --format '{{.Names}}' | grep -qx "$NODE"; then
  echo "no such node container: $NODE" >&2
  echo "running kind nodes:" >&2
  docker ps --format '  {{.Names}}' >&2
  exit 1
fi

echo "==> checking the GPU actually reached ${NODE}"
if ! docker exec "$NODE" ls /dev/dxg >/dev/null 2>&1; then
  echo "  /dev/dxg not present inside ${NODE}." >&2
  echo "  The extra_mounts injection did not work. Re-check step 3 of" >&2
  echo "  docs/windows-wsl2-gpu.md, then recreate the cluster." >&2
  exit 1
fi
echo "  /dev/dxg present"

echo "==> installing the NVIDIA container toolkit inside ${NODE}"
docker exec "$NODE" bash -c '
  set -e
  if command -v nvidia-ctk >/dev/null 2>&1; then
    echo "  already installed"; exit 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl gnupg ca-certificates >/dev/null
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y -qq nvidia-container-toolkit >/dev/null
'

echo "==> pointing the node's containerd at the nvidia runtime"
docker exec "$NODE" bash -c '
  set -e
  nvidia-ctk runtime configure --runtime=containerd --set-as-default
  # The node has no systemd; restart containerd directly and wait for it.
  pkill -HUP containerd || true
  sleep 3
'

echo "==> verifying"
docker exec "$NODE" bash -c 'ctr version >/dev/null 2>&1' \
  && echo "  containerd responding" \
  || echo "  containerd did not come back — check: docker logs ${NODE}"

cat <<MSG

${NODE} is ready for the device plugin.

Next: lab 30 installs it, which is what finally turns the device into a
schedulable nvidia.com/gpu resource.

If the plugin reports "No devices found. Waiting indefinitely." that is the
known WSL2 issue — see docs/windows-wsl2-gpu.md. Take the simulated path rather
than losing a day; the scheduling lessons are identical.
MSG
