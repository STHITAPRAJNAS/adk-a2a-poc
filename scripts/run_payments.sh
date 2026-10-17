#!/usr/bin/env bash
# Starts the four AP2 services (lab 86) in the background.
#
#   scripts/run_payments.sh      merchant :8410, wallet :8411, processor :8412,
#                                approval page :8413
#
# Then start the release agent with AP2_MERCHANT_URL=http://127.0.0.1:8410 to
# give it the buying tools. Logs land in logs/ap2-<role>.log.
# Stop with scripts/stop_all.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p logs

PYTHON="${PYTHON:-$( [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3 )}"

if ! "$PYTHON" -c "import ap2.sdk" 2>/dev/null; then
  echo "The AP2 SDK is not installed. Run: make install-payments" >&2
  exit 1
fi

export AP2_MERCHANT_URL="${AP2_MERCHANT_URL:-http://127.0.0.1:8410}"
export AP2_CREDENTIAL_PROVIDER_URL="${AP2_CREDENTIAL_PROVIDER_URL:-http://127.0.0.1:8411}"
export AP2_PROCESSOR_URL="${AP2_PROCESSOR_URL:-http://127.0.0.1:8412}"
export AP2_TRUSTED_SURFACE_URL="${AP2_TRUSTED_SURFACE_URL:-http://127.0.0.1:8413}"

wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      echo "  $name is up  ($url)"
      return 0
    fi
    sleep 1
  done
  echo "  $name did not come up; see logs/ap2-$name.log" >&2
  return 1
}

for role in trusted-surface processor credential-provider merchant; do
  nohup "$PYTHON" -m payments.server "$role" > "logs/ap2-${role}.log" 2>&1 &
  echo $! > "logs/ap2-${role}.pid"
done
wait_for "$AP2_TRUSTED_SURFACE_URL/.well-known/jwks.json" trusted-surface
wait_for "$AP2_PROCESSOR_URL/.well-known/jwks.json" processor
wait_for "$AP2_CREDENTIAL_PROVIDER_URL/.well-known/jwks.json" credential-provider
wait_for "$AP2_MERCHANT_URL/a2a/northwind_sales/.well-known/agent-card.json" merchant

cat <<MSG

  Merchant card   $AP2_MERCHANT_URL/a2a/northwind_sales/.well-known/agent-card.json
  Approval page   $AP2_TRUSTED_SURFACE_URL/requests

  Try:  python scripts/ap2_probe.py card
        python scripts/ap2_probe.py direct
        python scripts/ap2_probe.py --code 246810 autonomous --buys eu,us,eu
MSG
