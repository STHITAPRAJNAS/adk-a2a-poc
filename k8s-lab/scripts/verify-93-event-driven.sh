#!/usr/bin/env bash
# Lab 93 — the release agent works from a queue, and a redelivered event
# (worker crashed after sending) does not open a second release.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n "$NS" get deploy event-bridge >/dev/null 2>&1; then
  skip "lab 93 not applied (no event-bridge) — skipping"
  exit 0
fi
need_probe
R=redis://events-redis.agents.svc.cluster.local:6379/0
A=http://deployment-agent.agents.svc.cluster.local:8001
ev() { kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/event_probe.py "$@" 2>&1; }

D=$(env_of event-bridge BRIDGE_DEDUPE)
[ "$D" = 1 ] && ok "the bridge looks before sending (BRIDGE_DEDUPE=1)" \
  || no "BRIDGE_DEDUPE is '${D:-unset}' on event-bridge (step 3 sets 1)"
kubectl -n "$NS" rollout status deploy/event-bridge --timeout=60s >/dev/null 2>&1 \
  || { no "event-bridge is not running (scaled to zero by step 6? publish wakes it)"; }

ev reset "$R" >/dev/null
ev crash-next "$R" >/dev/null
ev publish "$R" >/dev/null
OUT=$(ev wait "$R" release.awaiting_approval --timeout 120); RC=$?
[ $RC -eq 0 ] && ok "a release event, sent, crashed on, redelivered: it reached the gate" \
  || { no "the release never reached the gate:"; echo "$OUT" | tail -2 | sed 's/^/      /'; }

OUT=$(ev state "$R" --agent "$A"); RC=$?
case $RC in
  0) grep -q "tickets the agent has  1 " <<<"$OUT" && ok "the agent holds one approval ticket for the event" \
       || no "unexpected: $(grep 'tickets the agent' <<<"$OUT")" ;;
  6) no "$(grep 'APPROVAL TICKETS' <<<"$OUT" | sed 's/^✗ //')" ;;
  *) no "could not read the state:"; echo "$OUT" | tail -2 | sed 's/^/      /' ;;
esac

ev publish "$R" --type release.cancelled >/dev/null
OUT=$(ev wait "$R" event.dead --timeout 30); RC=$?
[ $RC -eq 0 ] && ok "an invalid event went to the dead-letter stream" \
  || no "the invalid event was not dead-lettered"
exit $FAIL
