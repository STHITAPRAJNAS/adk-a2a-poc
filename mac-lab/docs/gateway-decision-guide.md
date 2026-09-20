# Which gateway, when

Four things in this lab proxy traffic. They are mostly **not** alternatives to
each other, which is the first thing to get straight — "should I use Istio or
Envoy Gateway?" is usually the wrong question.

## What each one is for

| | Sits | Speaks | Use it for |
|---|---|---|---|
| **Istio (ambient)** | Between pods, inside the cluster | TCP + HTTP, with identity | East-west: mTLS everywhere, who-may-call-whom, retries, telemetry per workload |
| **Envoy Gateway** | At the cluster edge | HTTP/gRPC | North-south ingress: TLS, routing, the Gateway API implementation |
| **agentgateway** | At the edge, or between agents | **A2A, MCP**, HTTP | Agent traffic specifically — A2A-aware routing, policy and logging |
| **Agent Router** *(was Envoy AI Gateway)* | On the way out | OpenAI-compatible LLM APIs | Egress to model providers: keys, quotas, failover, token accounting |

They compose. A production shape is all four at once: agentgateway or Envoy
Gateway at the edge, Istio underneath everything, Agent Router on the way out.

## The one real either/or

**Envoy Gateway vs agentgateway, for north-south A2A ingress.** Here you do pick
one, and it matters:

| | Envoy Gateway | agentgateway |
|---|---|---|
| Understands A2A | No — it is HTTP to it | **Yes**, first-class since v0.6 |
| Sees `taskId`, methods, agent cards | No | Yes |
| Per-agent policy | By URL path only | By agent and skill |
| Logs | HTTP access logs | Unified A2A / MCP / LLM call logs |
| Maturity as a gateway | Very mature, huge deployment base | Younger, narrower, purpose-built |
| Gateway API | Reference implementation | Supported |

If A2A is a implementation detail behind a normal API, Envoy Gateway is fine and
you already know how to run it. If A2A *is* your product surface — you are
publishing agents other organisations call — agentgateway gives you the
vocabulary. Lab 50 does it the first way and lab 60 the second, deliberately, so
you can compare the same traffic through both.

Note that **Agent Router does not do A2A ingress**. It is an LLM egress gateway;
A2A routing appears on its roadmap rather than in v1.0. Do not reach for it to
front your agents — that is agentgateway's job. This confuses people constantly,
partly because the names all blur together.

## Istio and Envoy Gateway are not competitors

Both are Envoy underneath, which is where the confusion starts. But:

- **Istio ambient** gives every pod an identity and encrypts pod-to-pod traffic
  with no application change and no sidecar. It has nothing to say about how
  traffic *enters* the cluster.
- **Envoy Gateway** terminates outside traffic and routes it in. It has nothing
  to say about what happens between two pods afterwards.

Traffic arriving through a gateway then travels east-west, through the mesh,
with mesh identity — so a request from outside gets both. Lab 50 shows the
handoff.

## Sidecars vs ambient

This lab uses **ambient mode** throughout. Ambient has been GA since Istio 1.24,
and for a learning cluster it is straightforwardly better:

- no sidecar injected into every pod, so `kubectl get pods` shows `1/1` and your
  agent logs are your agent's logs
- L4 (mTLS, identity, TCP authz) comes from a per-node **ztunnel** with no
  per-pod cost
- L7 (HTTP routing, header-based authz, retries) comes from a **waypoint** proxy
  you opt into per namespace or per service — so you pay for L7 only where you
  want it

That last point is a genuinely good teaching structure: lab 40 starts with L4
only, shows you what you can and cannot enforce, then adds a waypoint and shows
what that buys. With sidecars you get both at once and never see the seam.

If your day job runs sidecars, everything here transfers; the policy CRDs are
the same. The migration path is per-namespace and Istio supports both modes in
one cluster.

## A decision table you can actually use

| Question | Answer |
|---|---|
| Encrypt traffic between two agents in-cluster | Istio ambient (lab 40) |
| Stop agent X calling agent Y | Istio `AuthorizationPolicy` (lab 40) |
| Expose an agent to your laptop | Envoy Gateway + `HTTPRoute` (lab 50) |
| Expose an agent to another company | agentgateway (lab 60) — you need per-client A2A policy |
| Route on A2A method or task | agentgateway (lab 60) |
| Stop one agent burning your Gemini quota | Agent Router (lab 70) |
| Fail over Gemini → another provider | Agent Router (lab 70) |
| See which agent spent the most tokens | Agent Router (lab 70) |
| Retry a flaky call between two pods | Istio waypoint (lab 40) |
| Rate-limit an external caller | Whichever gateway is at the edge (lab 50/60) |
