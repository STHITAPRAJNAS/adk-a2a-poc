#!/usr/bin/env bash
# Check this Mac can run the labs. This is the macOS / Docker Desktop variant of
# the Windows lab's doctor: no GPU layers to walk, but Docker Desktop's Linux VM
# has its own kernel limits that bite Istio, so we check those the way that
# machine can — inside a kind node if one exists, otherwise a throwaway VM probe.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
good() { printf '  \033[32m✓\033[0m %s\n' "$1"; }

CLUSTER="${CLUSTER:-a2a-lab}"

echo "── environment"
if [ "$(uname -s)" = "Darwin" ]; then
  good "macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
else
  warn "not macOS — this is the Mac variant of the lab; on Windows use ../k8s-lab"
fi
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  good "Apple Silicon (arm64) — build the agent image for arm64 (build.sh default)"
elif [ "$ARCH" = "x86_64" ]; then
  warn "Intel Mac (x86_64) — build the agent image with: ./images/build.sh --platform amd64"
else
  warn "unrecognised arch: $ARCH"
fi
# macOS ships bash 3.2 as /bin/bash. Our scripts are written to run on it, but
# note it so a stray bashism is diagnosed here rather than mid-lab.
if [ -n "${BASH_VERSION:-}" ]; then good "bash ${BASH_VERSION%%(*}"; fi

echo
echo "── tools (brew install kind kubernetes-cli helm jq; terraform via hashicorp/tap)"
for t in kind kubectl helm terraform docker; do
  if command -v "$t" >/dev/null 2>&1; then good "$t $($t version --short 2>/dev/null | head -1 || echo present)"
  else bad "$t not installed — brew install $t"; fi
done
for t in istioctl jq; do
  command -v "$t" >/dev/null 2>&1 && good "$t" || warn "$t missing (needed from lab 40 / verify scripts) — brew install $t"
done
# kubectl version skew: the cluster is v1.36 (see versions.env); a client more
# than one minor behind mis-applies newer CRDs (Gateway API, Istio) with
# "unknown field" errors. Warn if the client minor is old.
KMINOR=$(kubectl version --client -o json 2>/dev/null | jq -r '.clientVersion.minor' 2>/dev/null | tr -dc '0-9')
if [ -n "$KMINOR" ] && [ "$KMINOR" -lt 30 ] 2>/dev/null; then
  bad "kubectl client is v1.${KMINOR} but the cluster is v1.36 — too old; brew upgrade kubernetes-cli (and check 'which -a kubectl' isn't a Docker Desktop copy shadowing brew)"
fi

echo
echo "── container runtime (Docker Desktop)"
if ! docker info >/dev/null 2>&1; then
  bad "docker unreachable — start Docker Desktop (the whale in the menu bar) and wait for it to say 'running'"
else
  CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null)
  MEMG=$(( $(docker info --format '{{.MemTotal}}' 2>/dev/null) / 1024 / 1024 / 1024 ))
  [ "${CPUS:-0}" -ge 4 ] && good "${CPUS} CPUs" || warn "${CPUS} CPUs — raise in Docker Desktop ▸ Settings ▸ Resources"
  if [ "$MEMG" -ge 8 ]; then good "${MEMG}GB RAM allotted to Docker"
  else
    bad "${MEMG}GB RAM — four kind nodes plus Istio needs ~8GB"
    warn "      Docker Desktop ▸ Settings ▸ Resources ▸ Memory → 12 GB, then Apply & Restart"
  fi
  # Docker Desktop's built-in Kubernetes fights kind for ports and KUBECONFIG.
  if kubectl config get-contexts 2>/dev/null | grep -q 'docker-desktop'; then
    warn "Docker Desktop's built-in Kubernetes is enabled — turn it OFF (Settings ▸ Kubernetes); let kind own the cluster"
  fi
fi

echo
echo "── kernel limits (Docker Desktop's Linux VM — one kernel for all kind nodes)"
# Istio's CNI agent crash-loops with "couldn't initialize inotify: too many open
# files" when these are at their low defaults. Docker Desktop's VM often ships
# fs.inotify.max_user_instances=128 — too low for four kind nodes + Istio.
# Read the value from inside a kind node if the cluster is up, else from a
# throwaway container (same VM kernel either way).
read_sysctl() {  # $1 = sysctl key -> prints value or empty
  local node
  node="$(docker ps --filter "name=${CLUSTER}-control-plane" -q 2>/dev/null | head -1)"
  if [ -n "$node" ]; then
    docker exec "$node" sysctl -n "$1" 2>/dev/null
  else
    docker run --rm --privileged alpine sysctl -n "$1" 2>/dev/null
  fi
}
if docker info >/dev/null 2>&1; then
  INST=$(read_sysctl fs.inotify.max_user_instances); INST="${INST:-0}"
  WATCH=$(read_sysctl fs.inotify.max_user_watches); WATCH="${WATCH:-0}"
  if [ "$INST" -ge 1024 ] 2>/dev/null; then good "fs.inotify.max_user_instances=${INST}"
  else
    bad "fs.inotify.max_user_instances=${INST} — too low for Istio (lab 40)"
    warn "      raise it in each kind node after the cluster is up:"
    warn "        for n in \$(docker ps --filter name=${CLUSTER} -q); do docker exec \$n sysctl -w fs.inotify.max_user_instances=8192; done"
  fi
  if [ "$WATCH" -ge 65536 ] 2>/dev/null; then good "fs.inotify.max_user_watches=${WATCH}"
  else
    bad "fs.inotify.max_user_watches=${WATCH} — too low"
    warn "      for n in \$(docker ps --filter name=${CLUSTER} -q); do docker exec \$n sysctl -w fs.inotify.max_user_watches=524288; done"
  fi
  warn "  these reset when a node container restarts; re-run start-cluster.sh reapplies them"
fi

echo
echo "── ports (kind maps these from the Mac host into the cluster)"
for p in 8080 8081 8443; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then warn "port $p in use"; else good "port $p free"; fi
done

echo
[ "$FAIL" = 0 ] && echo "ready — start at labs/00-prereqs" || { echo "fix the ✗ items first"; exit 1; }
