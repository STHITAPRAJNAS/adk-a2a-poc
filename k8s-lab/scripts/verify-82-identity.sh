#!/usr/bin/env bash
# Lab 82 — the user's identity crosses the hop by token exchange.
#   no token → 401 · alice → parked, ticket says "alice via ops_concierge"
#   bob → refused at the gate · alice's own token replayed at the specialist → 401
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

A=$(env_of ops-concierge AGENT_AUTH)
B=$(env_of deployment-agent AGENT_AUTH)
D=$(env_of ops-concierge DOWNSTREAM_AUTH)
if [ -z "$A$B" ]; then
  skip "lab 82 not applied (no AGENT_AUTH on the agents) — skipping"
  exit 0
fi
need_probe
[ "$A" = jwt ] && ok "ops-concierge requires a bearer token" || no "AGENT_AUTH=$A on ops-concierge (want jwt)"
[ "$B" = jwt ] && ok "deployment-agent requires a bearer token" || no "AGENT_AUTH=$B on deployment-agent (want jwt)"
[ "$D" = exchange ] && ok "concierge exchanges tokens downstream" || no "DOWNSTREAM_AUTH=${D:-none} (want exchange)"
kubectl -n "$NS" get deploy sts >/dev/null 2>&1 && ok "token service deployed" || no "no sts Deployment (see Step 0)"

OUT=$(probe pause 2>&1)
echo "$OUT" | grep -q '"http_status": 401' && ok "no token → 401 at the front door" \
  || no "anonymous request was not refused"

OUT=$(probe --user alice pause 2>&1)
if echo "$OUT" | grep -q "requested by     alice via ops_concierge"; then
  ok "alice → parked at the gate; ticket says 'alice via ops_concierge'"
else
  no "alice's release did not reach the gate with her identity:"
  echo "$OUT" | grep -E "✗|error|requested" | sed 's/^/      /'
fi

OUT=$(probe --user bob pause 2>&1)
echo "$OUT" | grep -q "bob via ops_concierge lacks the release:deploy scope" \
  && ok "bob → refused at the gate by scope, named as 'bob via ops_concierge'" \
  || { no "bob was not refused by scope:"; echo "$OUT" | grep -E "✗|✓|error" | sed 's/^/      /'; }

OUT=$(probe --user alice --entry http://deployment-agent.agents.svc.cluster.local:8001/a2a/deployment_agent pause 2>&1)
echo "$OUT" | grep -q "token audience is 'ops_concierge'" \
  && ok "alice's own token replayed at the specialist → 401 (wrong audience)" \
  || no "replayed user token was not refused on audience"
exit $FAIL
