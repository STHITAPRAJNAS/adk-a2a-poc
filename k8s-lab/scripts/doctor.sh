#!/usr/bin/env bash
# Check this Mac can run the labs. Everything it catches is a failure that would
# otherwise surface two labs later as a confusing pod crash.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
warn() { printf '  \033[33m! \033[0m%s\n' "$1"; }
bad()  { printf '  \033[31m✗ \033[0m%s\n' "$1"; FAIL=1; }
good() { printf '  \033[32m✓ \033[0m%s\n' "$1"; }

echo "tools"
for t in kind kubectl helm terraform docker; do
  if command -v "$t" >/dev/null 2>&1; then good "$t $($t version --short 2>/dev/null | head -1 || echo present)"
  else bad "$t not installed — brew install $t"; fi
done
for t in istioctl jq yq; do
  command -v "$t" >/dev/null 2>&1 && good "$t" || warn "$t missing (needed from lab 40 / verification scripts)"
done

echo
echo "container runtime"
if ! docker info >/dev/null 2>&1; then
  bad "docker daemon unreachable — start Docker Desktop, OrbStack or 'colima start'"
else
  ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null)
  CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null)
  MEMB=$(docker info --format '{{.MemTotal}}' 2>/dev/null)
  MEMG=$(( MEMB / 1024 / 1024 / 1024 ))
  case "$ARCH" in
    aarch64|arm64) good "architecture $ARCH" ;;
    *) warn "architecture $ARCH — expected arm64 on a Mac Studio. Images will be slow or fail." ;;
  esac
  [ "$CPUS" -ge 4 ] && good "${CPUS} CPUs" || warn "${CPUS} CPUs — give the VM at least 4"
  [ "$MEMG" -ge 8 ] && good "${MEMG}GB RAM" || bad "${MEMG}GB RAM — four kind nodes need ~8GB. Raise the VM's memory."
fi

echo
echo "ports"
for p in 8080 8443; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "port $p already in use — change http_node_port in labs/10-cluster"
  else good "port $p free"; fi
done

echo
[ "$FAIL" = 0 ] && echo "ready — start at labs/00-prereqs" || { echo "fix the ✗ items first"; exit 1; }
