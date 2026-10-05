#!/usr/bin/env bash
# Lab 83 — one release produces ONE trace containing spans from both agents.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

E=$(env_of ops-concierge OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
P1=$(env_of ops-concierge TRACE_PROPAGATION)
P2=$(env_of deployment-agent TRACE_PROPAGATION)
if [ -z "$E$P1$P2" ]; then
  skip "lab 83 not applied (no OTLP endpoint on ops-concierge) — skipping"
  exit 0
fi
need_probe
[ -n "$E" ] && ok "spans exported to $E" || no "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT not set"
[ "$P1" = 1 ] && [ "$P2" = 1 ] && ok "traceparent carried on both sides" \
  || no "TRACE_PROPAGATION concierge=${P1:-unset} specialist=${P2:-unset} (want 1 and 1)"

probe pause >/dev/null 2>&1
ok "sent a release; waiting for the span batches to land"
sleep 8

# Jaeger v2 serves the v3 query API only (OTLP JSON); the legacy /api/traces is
# gone. Group the returned spans by trace id and look for one trace that holds
# spans from both services.
RESULT=$(kubectl -n "$NS" exec a2a-probe -- python -c '
import httpx, json, time
from collections import defaultdict
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
r = httpx.get("http://jaeger.observability.svc.cluster.local:16686/api/v3/traces", timeout=10,
              params={"query.service_name": "ops-concierge", "query.search_depth": 20,
                      "query.start_time_min": iso(time.time() - 600),
                      "query.start_time_max": iso(time.time() + 60)})
services, spans = defaultdict(set), defaultdict(int)
for line in r.text.splitlines():
    if not line.strip():
        continue
    for rs in (json.loads(line).get("result") or {}).get("resourceSpans", []):
        svc = next((a["value"].get("stringValue") for a in rs["resource"].get("attributes", [])
                    if a["key"] == "service.name"), "?")
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                services[sp["traceId"]].add(svc)
                spans[sp["traceId"]] += 1
both = [spans[t] for t, s in services.items() if {"ops-concierge", "deployment-agent"} <= s]
print(max(both) if both else 0)
' 2>&1)
if [ "${RESULT:-0}" -gt 0 ] 2>/dev/null; then
  ok "found a trace spanning ops-concierge AND deployment-agent ($RESULT spans)"
else
  no "no trace contains both services (got: ${RESULT:-nothing})"
fi
exit $FAIL
