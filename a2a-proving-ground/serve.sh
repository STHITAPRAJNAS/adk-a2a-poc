#!/usr/bin/env bash
# Serve A2A Proving Ground on http://localhost:PORT and open it in your browser.
#
#   ./serve.sh            # port 8765
#   ./serve.sh 9000       # another port
#   NO_OPEN=1 ./serve.sh  # don't open a browser
#
# Works on macOS, Linux and WSL. Needs Python 3 (already on macOS and most
# Linux distros). Stop with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8765}"
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3 not found. Alternatives from this folder:" >&2
  echo "  npx --yes serve -l $PORT ." >&2
  echo "  docker run --rm -p $PORT:80 -v \"\$PWD\":/usr/share/nginx/html:ro nginx:alpine" >&2
  exit 1
fi

# Loopback only by default: nothing outside this machine can reach the site.
# Inside WSL2 the Windows browser reaches the Linux VM through localhost
# forwarding, which is most reliable when bound to all interfaces of the VM
# (the VM is NAT-ed, so this still isn't exposed to your LAN).
if [ -z "${BIND:-}" ]; then
  if grep -qi microsoft /proc/version 2>/dev/null; then BIND="0.0.0.0"; else BIND="127.0.0.1"; fi
fi

URL="http://localhost:${PORT}/"
echo "A2A Proving Ground  →  ${URL}"
echo "Serving $(pwd) on ${BIND}:${PORT}. Press Ctrl+C to stop."

if [ -z "${NO_OPEN:-}" ]; then
  (
    sleep 1
    if command -v open >/dev/null 2>&1; then open "$URL"
    elif command -v wslview >/dev/null 2>&1; then wslview "$URL"
    elif grep -qi microsoft /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL" >/dev/null 2>&1
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
    fi
  ) &
fi

exec "$PY" -m http.server "$PORT" --bind "$BIND"
