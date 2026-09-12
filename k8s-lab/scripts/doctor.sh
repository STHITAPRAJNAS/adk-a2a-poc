#!/usr/bin/env bash
# Check this machine can run the labs. Walks the four layers a GPU has to
# survive on WSL2, so a failure is attributed to the right one.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
good() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

echo "── environment"
if grep -qi microsoft /proc/version 2>/dev/null; then
  good "running inside WSL2"
else
  warn "not WSL2 — the labs assume a Linux shell; on Windows run them inside WSL"
fi
case "$PWD" in
  /mnt/[a-z]/*) warn "repo is on the Windows filesystem ($PWD) — builds will be slow. Move it to ~/ inside WSL." ;;
  *) good "repo is on the WSL filesystem" ;;
esac

echo
echo "── tools"
for t in kind kubectl helm terraform docker; do
  if command -v "$t" >/dev/null 2>&1; then good "$t $($t version --short 2>/dev/null | head -1 || echo present)"
  else bad "$t not installed"; fi
done
for t in istioctl jq; do
  command -v "$t" >/dev/null 2>&1 && good "$t" || warn "$t missing (needed from lab 40)"
done

echo
echo "── container runtime"
if ! docker info >/dev/null 2>&1; then
  bad "docker unreachable — enable WSL integration in Docker Desktop settings"
else
  CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null)
  MEMG=$(( $(docker info --format '{{.MemTotal}}' 2>/dev/null) / 1024 / 1024 / 1024 ))
  [ "${CPUS:-0}" -ge 4 ] && good "${CPUS} CPUs" || warn "${CPUS} CPUs — raise processors= in C:\\Users\\<you>\\.wslconfig"
  if [ "$MEMG" -ge 8 ]; then good "${MEMG}GB RAM"
  else
    bad "${MEMG}GB RAM — four kind nodes plus Istio needs ~8GB"
    warn "      Docker Desktop has no memory slider on the WSL2 backend."
    warn "      Set memory=12GB in C:\\Users\\<you>\\.wslconfig, then: wsl --shutdown"
  fi
fi

echo
echo "── GPU, layer by layer"
if [ -e /dev/dxg ]; then good "layer 1/2: /dev/dxg present (Windows driver → WSL)"
else bad "layer 1/2: no /dev/dxg — install the NVIDIA driver on WINDOWS, not in WSL"; fi

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  good "layer 2: nvidia-smi → $(nvidia-smi -L | head -1)"
else
  bad "layer 2: nvidia-smi not working in WSL"
fi

if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
  good "layer 3: nvidia runtime registered with docker"
else
  bad "layer 3: nvidia runtime missing — sudo nvidia-ctk runtime configure --runtime=docker --set-as-default"
fi

if timeout 90 docker run --rm -v /dev/null:/var/run/nvidia-container-devices/all \
     ubuntu:24.04 nvidia-smi -L >/dev/null 2>&1; then
  good "layer 3: volume-mount device injection works — kind can have a GPU node"
else
  bad "layer 3: injection failed — sudo nvidia-ctk config --set accept-nvidia-visible-devices-as-volume-mounts=true --in-place && restart docker"
  warn "      you can still do the whole lab: terraform apply -var enable_gpu=false"
fi

echo
echo "── ports"
for p in 8080 8081 8443; do
  if ss -ltn 2>/dev/null | grep -q ":${p} "; then warn "port $p in use"; else good "port $p free"; fi
done

echo
[ "$FAIL" = 0 ] && echo "ready — start at labs/00-prereqs" || { echo "fix the ✗ items first (GPU ones are optional: see above)"; exit 1; }
