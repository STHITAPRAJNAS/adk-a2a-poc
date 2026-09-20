# East-west and north-south, for A2A specifically

The terms come from drawing a datacentre diagram: traffic between services
inside it moves sideways across the page (east-west), traffic entering or
leaving moves up and down (north-south). Useful, but it tells you nothing about
*what changes*. This is what changes for an A2A call.

## The same call, twice

Take one call from this repository: the concierge asks the deployment agent to
release `checkout-api 2.14.0`.

```
EAST-WEST                                NORTH-SOUTH
inside the cluster                       from your Mac, or another org

  ops_concierge pod                        curl / another company's agent
        │                                            │
        │ http://deployment-agent.agents             │ https://a2a.example.com
        │      .svc.cluster.local:8001               │
        ▼                                            ▼
  [ ztunnel ]  ← mTLS, automatic               [ Gateway ]  ← TLS terminates
        │                                            │        authn happens
        ▼                                     ┌──────┴──────┐
  deployment_agent pod                        │  ztunnel    │ ← mTLS starts here
                                              ▼
                                       deployment_agent pod
```

Identical A2A protocol. Identical JSON-RPC. Everything around it differs.

## What actually differs

| | East-west | North-south |
|---|---|---|
| **Who is calling** | A workload with a cryptographic identity the mesh issued (`spiffe://…/sa/ops-concierge`) | Unknown until you authenticate them |
| **Addressing** | Cluster DNS, a stable internal name | A public hostname, DNS you own, a certificate someone trusts |
| **Encryption** | mTLS, automatic, both ends get an identity | TLS to the gateway; you choose what happens after |
| **Authorisation** | "which *service account* may call this" | "which *customer* may call this, and how much" |
| **Failure mode** | A pod is down; retry, circuit-break | The internet is hostile; rate-limit, quota, WAF |
| **Who sees it** | Mesh telemetry, per-workload | Gateway access logs, per-client |
| **What you tune** | Timeouts, retries, locality | Auth, quotas, payload limits, abuse |

## Why this matters more for A2A than for ordinary HTTP

Three properties of A2A make the boundary sharper than it would be for a
REST API.

**1. Tasks are long-lived, and the caller must come back.** An A2A task that
parks in `input-required` is resumed by a later call carrying the same `taskId`.
East-west, that is a second call to the same service — trivially fine. From
outside, the caller must reach *the same cluster* minutes or hours later, and
whatever authenticated them the first time must still work. Anything
sticky-session-shaped is a trap: the resume is a fresh HTTP request that may
land on any replica, and it works only because the task lives in the **task
store**, not in a connection. (See
[`../../docs/a2a-protocol-mechanics.md`](../../docs/a2a-protocol-mechanics.md).)

**2. Streaming is the normal case.** `message/stream` holds an SSE response open
for the life of a turn — which for a compliance scan is tens of seconds and for
a resubscribed watcher is unbounded. East-west that is a normal connection.
North-south it crosses whatever idle timeouts your gateway and any load balancer
in front of it impose, and the default is usually too short. Lab 50 makes you hit
this deliberately.

**3. The Agent Card is a public contract.** `/.well-known/agent-card.json` tells
callers what an agent can do and where to send RPC. Inside the cluster it can
name a cluster-local URL. Exposed north-south it must name the *external* URL —
and ADK's client rejects a card whose RPC URL is not same-origin with where the
card was fetched. Getting this wrong is the single most common way an
externally-exposed ADK agent fails, and lab 60 walks into it on purpose.

## Where each tool sits

| Boundary | Tool | Lab |
|---|---|---|
| East-west, agent → agent | **Istio ambient** — identity, mTLS, authz | 40 |
| North-south, plain HTTP in | **Envoy Gateway** + Gateway API | 50 |
| North-south, A2A in | **agentgateway** — understands A2A itself | 60 |
| Egress, agent → Gemini | **Agent Router** (Envoy AI Gateway) | 70 |

That fourth row is worth noticing. Your agents make outbound LLM calls, and that
traffic is neither east-west nor north-south *ingress* — it is egress, and it is
where the money is. Most people instrument the first three and leave the
expensive one unmanaged.

## The test that makes it concrete

After lab 60 you can run the same A2A negotiation twice — once from a pod, once
from your Mac — and diff what the platform recorded. Same protocol, same result,
completely different evidence:

```bash
make compare-paths
```

East-west gives you a mesh trace with two workload identities and no
authentication step, because identity was established by certificate before the
first byte. North-south gives you a gateway access log with a client credential,
a TLS handshake, a rate-limit decision, and only *then* the same mesh trace.
