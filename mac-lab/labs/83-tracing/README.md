# Lab 83 — One trace across the hop

"The release took 40 seconds. Where did they go?" With two agents, a mesh and a
human gate, the answer lives in two processes. This lab sends both agents'
spans to Jaeger and shows that **exporting spans is not enough**: until the
trace context crosses the A2A hop, you get two unrelated traces and no way to
join them.

```
 before                                       after
 ops-concierge     ▇▇▇▇▇▇▇▇▇▇▇ trace 1        ops-concierge   ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ trace 1
 deployment-agent     ▇▇▇▇▇▇▇ trace 2           invoke_agent deployment_agent
                                                  └ deployment-agent  A2A POST /a2a/…
                                                      call_llm · execute_tool …
```

Run everything from the `k8s-lab` folder (or `mac-lab`), with the probe pod from
lab 80 (`make probe`) and the alias:

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
```

## Step 1 — a collector

```bash
kubectl apply -f labs/83-tracing/jaeger.yaml
kubectl -n observability rollout status deploy/jaeger
```

Open the UI in a second terminal and leave it running:

```bash
kubectl -n observability port-forward svc/jaeger 16686:16686
```

Then browse to http://localhost:16686.

## Step 2 — export spans, nothing else

ADK already creates OpenTelemetry spans for every agent run, model call and tool
call. It exports them as soon as an OTLP endpoint is configured:

```bash
J=http://jaeger.observability.svc.cluster.local:4318/v1/traces
kubectl -n agents set env deploy/ops-concierge OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$J OTEL_SERVICE_NAME=ops-concierge OTEL_BSP_SCHEDULE_DELAY=1000
kubectl -n agents set env deploy/deployment-agent OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$J OTEL_SERVICE_NAME=deployment-agent OTEL_BSP_SCHEDULE_DELAY=1000
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
```

In Jaeger, pick **Service: ops-concierge** and Find Traces, then do the same for
**deployment-agent**. Both are there, and they share nothing. The concierge's
trace ends at `invoke_agent deployment_agent`, a span that just sits there for
the length of the remote call. The specialist's trace starts from nowhere. The
one request is now two separate traces.

Why: the concierge's outbound A2A request carries no `traceparent` header, and
the specialist would not read one anyway.

(The traces-only endpoint, `…_TRACES_ENDPOINT` with the full `/v1/traces` path,
is deliberate: the generic `OTEL_EXPORTER_OTLP_ENDPOINT` would also turn on
metrics and logs export, which this Jaeger does not accept.)

## Step 3 — carry the context across

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent TRACE_PROPAGATION=1
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
```

Find Traces for **ops-concierge** again. The newest trace now spans **both
services**: Jaeger shows two colors, and `deployment-agent`'s
`A2A POST /a2a/deployment_agent` sits *under* the concierge's
`invoke_agent deployment_agent`. Expand it to see the specialist's own model
calls and tool calls, including the compliance scan's seconds, exactly where
they happened.

```bash
./scripts/verify-83-tracing.sh
```

## How it works (`common/tracing.py`)

Two halves, using only the OpenTelemetry API ADK already depends on:

- **Out (client).** An httpx request hook on the concierge's A2A client calls
  `propagate.inject(headers)`, writing the W3C `traceparent` of the span that
  is current at that moment (`invoke_agent deployment_agent`).
- **In (server).** A small ASGI middleware opens a SERVER span for every
  `/a2a/…` request, parented on the incoming `traceparent`. a2a-sdk starts the
  agent run inside that request, and asyncio copies the active context into it,
  so every ADK span becomes a child.

The same hook client carries lab 82's exchanged token. Identity and trace
context are the two things every hop must forward.

## Things to notice in the trace

- **The paused gap.** The trace ends at `input-required`. The approval arrives
  minutes later as a *new* request, so it starts a new trace. Linking the two is
  a design choice: a span link, or the task id as a searchable attribute.
- **Noise.** a2a-sdk instruments itself too (`event_queue…` spans). In production
  you would sample, or drop those spans in the collector.
- **The mesh is invisible here.** ztunnel is L4 and adds no spans; a waypoint
  can, if you configure Istio's tracing, and those spans join the same trace
  because they read the same `traceparent`.

## Undo

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent TRACE_PROPAGATION- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT- OTEL_SERVICE_NAME- OTEL_BSP_SCHEDULE_DELAY-
kubectl delete -f labs/83-tracing/jaeger.yaml
```
