# Lab 55 — OPA policy: two enforcement points, one engine

You already have three tiers of authorization from the mesh:

| Tier | Enforced by | Answers |
|---|---|---|
| L4 identity | ztunnel (lab 40) | *may workload A connect to B?* |
| L7 HTTP | waypoint (lab 40, optional) | *which verbs/paths may A use on B?* |
| **Policy-as-code** | **OPA (this lab)** | ***arbitrary Rego over the request or the tool call*** |

OPA adds the third tier in **two places**, from one OPA instance:

```
                 ┌─ :9191 gRPC ext_authz ─ Envoy Gateway asks before traffic
   ┌──────┐      │                         reaches an agent          (network)
   │ OPA  │◀─────┤
   └──────┘      └─ :8181 REST /v1/data ── each agent asks before it runs a
                                           tool/skill                 (application)
```

## Stage 1 — deploy OPA + network-layer ext_authz

```bash
kubectl apply -f opa.yaml
kubectl -n agents rollout status deploy/opa
kubectl apply -f securitypolicy.yaml     # wires OPA into the Envoy Gateway
```

`envoy.rego` says: GETs are fine; an A2A **POST must carry `x-change-ticket`**, or
Envoy returns **403 before the agent is ever touched**. Prove it:

```bash
../../scripts/verify-55-opa.sh
```

You'll see the same request denied (403) without the header and allowed (200)
with it — and the **tools policy answering over REST** (production deploy denied,
staging allowed) even before any agent calls it.

## The two policies

- **`envoy.rego`** (package `envoy.authz`) — the network gate. Input is the HTTP
  request; output `allow`. This is what the `SecurityPolicy` consults.
- **`tools.rego`** (package `tools`) — the tool/skill gate. Input is
  `{agent, tool, args}`; output `allow`. In Stage 2 each agent queries this
  before every tool call. Rules shipped:
  - `ops_concierge` may **only** `transfer_to_agent` → `deployment_agent`.
  - `deployment_agent` may run `check_release_readiness`, `run_compliance_scan`,
    `request_change_approval` freely.
  - `deployment_agent` may `start_deployment` **only when `environment != production`**.

Query it directly to feel how it works:

```bash
kubectl -n agents run q --rm -i --restart=Never --image=curlimages/curl -- \
  curl -sS http://opa:8181/v1/data/tools/allow \
  -d '{"input":{"agent":"deployment_agent","tool":"start_deployment","args":{"environment":"production"}}}'
# -> {"result":false}
```

## Stage 2 — enforce the tools policy inside the agents

Stage 1 only *deploys* the tools policy; Stage 2 makes the agents obey it. Each
agent installs a `before_tool_callback` (`common/opa_guard.py`) that POSTs
`{agent, tool, args}` to `http://opa:8181/v1/data/tools/allow` before every tool
runs and **skips the call** if OPA says no — so OPA, not the LLM, decides what
executes. It's opt-in via `OPA_URL` (off by default), so it
needs an image rebuild and the env set on the agents:

```bash
# from k8s-lab/ — rebuild the agent image with the guard code, reload into kind
./images/build.sh
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent OPA_URL=http://opa:8181
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
```

Then drive it through the gateway (the `x-change-ticket` header satisfies the
Stage-1 ingress policy):

```bash
say() { curl -sN -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -H 'x-change-ticket: CHG-0001' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"message/stream\",\"params\":{\"message\":{\"messageId\":\"m1\",\"kind\":\"message\",\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"$1\"}]}}}" \
  http://a2a.localhost:8080/a2a/ops_concierge; echo; }

say "deploy checkout-api 2.14.0 to staging"      # ALLOWED — start_deployment runs, job created
say "deploy billing-worker 3.1.0 to production"  # DENIED at the first tool (frozen service)
```

- **staging** → every tool is permitted; `start_deployment` runs and the task
  parks on the running job. (`start_deployment→production` would be blocked by
  the env rule — but that only triggers after the approval gate.)
- **billing-worker** → OPA's change-freeze denies `check_release_readiness`
  immediately; the stream ends with **"Blocked by policy: cannot run
  `check_release_readiness`"** and no scan/approval/job ever happens. Watch it in
  the agent log too: `kubectl -n agents logs deploy/deployment-agent | grep "OPA guard"`.

Change a rule in `tools.rego` (e.g. add a service to `frozen_services`), re-apply
`opa.yaml`, restart OPA, and the agents' behaviour changes with **no code change** —
that's the point of policy-as-code.

## Notes

- **Pin the image.** `opa.yaml` uses `openpolicyagent/opa:latest-envoy`; pin a
  real version (`:<x.y.z>-envoy`) for a repeatable build.
- **Fail closed.** `securitypolicy.yaml` sets `failOpen: false` — if OPA is down,
  requests are denied, not waved through. That's the safe default for a policy gate.
- OPA is kept **out of the ambient mesh** (`istio.io/dataplane-mode: none`) so both
  the out-of-mesh gateway and the in-mesh agents reach it as plain traffic.
