# Lab 20 — Agents on Kubernetes

Two pods, one A2A call between them. This is where the repository's agents stop
being processes on your laptop.

## Run it

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig

# 1. build the image for arm64 and load it into kind
../../images/build.sh

# 2. the specialist
helm install deployment-agent ../../charts/adk-agent \
  -n agents --create-namespace \
  -f ../../charts/adk-agent/values-specialist.yaml

# 3. the front door
helm install ops-concierge ../../charts/adk-agent \
  -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml

kubectl -n agents rollout status deploy/deployment-agent deploy/ops-concierge
```

## Do the failure first

Before the install above works, break it on purpose. It takes two minutes and it
is the most useful thing in this lab.

Install the concierge pointing at an **http URL** for the peer card, the way
everyone writes it the first time:

```bash
helm install ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml \
  --set env.DEPLOYMENT_AGENT_CARD_URL=http://deployment-agent.agents.svc.cluster.local:8001/a2a/deployment_agent/.well-known/agent-card.json
```

Then drive a release through it and read the logs:

```bash
kubectl -n agents port-forward svc/ops-concierge 8000:8000 &
../../scripts/send-release-request.sh
kubectl -n agents logs deploy/ops-concierge | grep -i "agent card"
```

You get `AgentCardResolutionError: Agent card RPC URL must use https, or http on
a loopback host`.

### Why

ADK's `RemoteA2aAgent` validates every card it fetches **over the network**.
Each RPC URL the card offers must be `https`, or `http` on a loopback host, and
must share an origin with where the card was fetched. That rule is sound — it
stops a card you fetched from one host redirecting your RPC traffic to another —
but `deployment-agent.agents.svc.cluster.local` is neither https nor loopback,
so a perfectly ordinary in-cluster call is refused before a single RPC is sent.

Three ways out, and it is worth knowing all three because you will meet all three:

| Fix | When |
|---|---|
| **Distribute the card as a file** — the chart's `peerAgentCards`, and point the env var at `/etc/a2a/…` | In-cluster. A card read from a file did not come off the network, so the check is skipped entirely. |
| **Serve the card over HTTPS** | When agents are genuinely separate trust domains. Needs real certs; a waypoint or gateway terminates TLS. |
| **Name the host `*.localhost`** | Never. It passes the check because ADK treats `*.localhost` as loopback, and it will mislead whoever reads it next. |

The chart uses the first. Reinstall with the default values and it works.

**This is the real lesson of the lab, not a quirk.** Inside a cluster, an agent
card is *configuration you distribute*, not a document you discover. Service
discovery is already solved by Kubernetes; re-solving it over HTTP buys nothing
and drags a TLS requirement in with it.

## Prove the A2A call crosses the network

```bash
../../scripts/verify-20-agents.sh
```

or by hand:

```bash
kubectl -n agents port-forward svc/ops-concierge 8000:8000 &

# a full negotiation through the front door, which delegates over A2A
curl -sN localhost:8000/a2a/ops_concierge \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"m1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}' \
  | grep -o '"state":"[a-z-]*"' | uniq
```

Expect `submitted → working → input-required`. The task parked on the human
approval gate — two pods, one A2A hop, and the pause survived the network.

Confirm the hop was real:

```bash
kubectl -n agents logs deploy/deployment-agent | grep "POST /a2a"
```

## What to notice

**`0.0.0.0`, not `127.0.0.1`.** The chart sets `ORCHESTRATOR_HOST` and
`REMOTE_AGENT_HOST` explicitly. A server bound to loopback inside a pod is
reachable only from that pod: the container runs, probes fail, the Service has
no endpoints, and everything *looks* healthy. It is the most common
first-deployment bug there is.

**The Service port is named `http-a2a`.** Istio infers protocol from the port
name. Call it `tcp` or leave it unnamed and ambient treats the traffic as opaque
TCP, which silently costs you every L7 feature in lab 40 — HTTP-level authz,
retries, per-route metrics. Naming it now saves a confusing hour later.

**Two Deployments, two Services, one image.** Which agent runs is an argument,
not a build. One artifact to scan, sign and roll back.

**`replicaCount: 1`, deliberately.** Scale the specialist to 2 and resume a
parked task; roughly half the resumes fail. A2A task state lives in the server's
task store, which is in-memory by default, so a resume must reach the replica
holding the task. That is not a Kubernetes problem to route around — it is the
task store telling you it needs to be shared. Worth trying once so you recognise
it in the wild.

## Things that go wrong

| Symptom | Cause |
|---|---|
| `ErrImageNeverPull` / `ImagePullBackOff` | Image not loaded into kind. Re-run `images/build.sh`. |
| `exec format error` in a crash loop | amd64 image on arm64 nodes. Rebuild; see `images/README.md`. |
| Probes fail, pod never Ready | Bound to loopback, or the wrong `containerPort`. `kubectl exec … -- wget -qO- localhost:8001/health`. |
| `AgentCardResolutionError` | The failure above. Use the file path. |
| Concierge answers but never delegates | Peer card missing or unparseable. `kubectl exec deploy/ops-concierge -- cat /etc/a2a/deployment-agent.json`. |

→ [Lab 30: node groups](../30-node-groups/)
