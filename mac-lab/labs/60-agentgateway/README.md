# Lab 60 — agentgateway: a gateway that speaks A2A

Same north-south path as lab 50, through a proxy that understands the protocol
instead of treating it as opaque HTTP.

## Why swap

Lab 50's access log says `POST /a2a/ops_concierge 200`. That is every A2A call
your platform will ever make, indistinguishable from every other one. You cannot
rate-limit negotiations separately from cancellations, cannot tell which agent
skill a client is using, and cannot attribute a long-running task to the caller
that opened it.

agentgateway parses A2A. It has been first-class there since v0.6 (July 2025),
alongside MCP, and it implements Gateway API so the routing concepts from lab 50
carry over.

**Note on the alternatives.** Agent Router — the project formerly called Envoy AI
Gateway — does *not* do A2A ingress; it is an LLM **egress** gateway and that is
lab 70. A2A routing sits on its roadmap rather than in v1.0. The names blur
together and people reach for the wrong one constantly. See
[the decision guide](../../docs/gateway-decision-guide.md).

## Install (standalone — the reliable path on kind)

agentgateway's Kubernetes/Gateway-API mode is delivered through kgateway and is
still churning; the simplest, most transparent way to run it on kind is
**standalone**: one pod, one flat config file, one NodePort. The config is a
single file you can read — and the line that matters is `a2a: {}`, which tells
the proxy to *parse the A2A protocol* on that route.

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig
kubectl apply -f standalone.yaml
kubectl -n agentgateway-system rollout status deploy/agentgateway
```

`standalone.yaml` is a ConfigMap (the agentgateway config), a Deployment (image
`ghcr.io/agentgateway/agentgateway:0.8.2`, multi-arch), and a NodePort Service on
`30081` with `externalTrafficPolicy: Cluster` — the same kind fix as lab 50, so
host `:8081` reaches the pod.

> The lab also ships `gateway.yaml` + `a2a-route.yaml` (the Gateway-API form) for
> when you run agentgateway under kgateway's controller. They're kept for
> reference; the standalone path above is what these steps use.

## Drive it, and *see* it parse A2A

Exactly the call from lab 50, on a different port (`:8081`):

```bash
curl -sN http://a2a.localhost:8081/a2a/ops_concierge \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"m1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}'
```

Identical response to lab 50. Completely different **record** of it:

```bash
kubectl -n agentgateway-system logs deploy/agentgateway --tail=30
```

Lab 50's Envoy access log said `POST /a2a/ops_concierge 200` — one opaque line
for every A2A call your platform will ever make. agentgateway, because the route
is marked `a2a`, logs the call in **A2A terms**. That difference — what the
platform can *see*, and therefore *govern* — is the entire point of an A2A-aware
proxy.

## The lab: north-south A2A is not just HTTP with extra steps

Three things differ once the caller is outside, and each has a manifest here.

**1. The agent card is the contract.** An external client fetches
`/.well-known/agent-card.json`, reads `url`, and sends RPC there. Inside the
cluster that is a Service name; outside it must be the gateway hostname. The
card served through this gateway must name **this** gateway — and if you exposed
the same agent through lab 50's gateway too, those are two different URLs and
one card. Deciding which one it names is a real architectural choice, not an
oversight. (Simplest answer: one public ingress per agent, and the card names it.)

**2. Identity restarts at the boundary.** East-west, the caller had a SPIFFE
identity from its certificate and lab 40's policy could name it. An external
caller has none — it has whatever credential you demand at the edge. The gateway
authenticates, then traffic continues into the mesh with the *gateway's* identity,
not the client's. So `AuthorizationPolicy` in lab 40 cannot distinguish two
external customers; that distinction has to be made and enforced at the edge,
then carried forward deliberately if the mesh needs it.

**3. Tasks outlive connections, and callers must return.** A parked task is
resumed minutes later by a fresh HTTP request carrying the same `taskId`. Nothing
sticky will save you: the resume can land on any replica and works only because
the task lives in the task store. With the in-memory default and two replicas,
half your resumes fail. Scale `deployment-agent` to 2 and try it — this is the
single most important thing to internalise before running A2A agents in
production, and lab 20 already hinted at it.

## Verify

```bash
../../scripts/verify-60-a2a-ingress.sh
```

Checks: the card served through the gateway names the gateway; a full negotiation
completes north-south; and the same task id can be resumed on a second
connection.

## Compare the three paths

```bash
../../scripts/compare-paths.sh
```

| Path | Encrypted by | Caller identity | Platform sees |
|---|---|---|---|
| pod → pod (lab 40) | ztunnel mTLS | SPIFFE, from a cert | Mesh telemetry per workload |
| Mac → Envoy Gateway (lab 50) | TLS at the edge | Whatever you configured | HTTP access log |
| Mac → agentgateway (lab 60) | TLS at the edge | Whatever you configured | **A2A call log** — method, agent, task |

Same protocol, same agents, same result. The difference is entirely what the
platform can see and therefore govern.

→ [Lab 70: Agent Router](../70-agent-router/)
