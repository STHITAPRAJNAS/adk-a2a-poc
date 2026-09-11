# Lab 50 — North-south with Envoy Gateway

So far every A2A call started inside the cluster. Now one starts on your Mac.

## Install and expose

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig
./install.sh
kubectl apply -f gateway.yaml
kubectl apply -f httproute.yaml

kubectl -n agents get gateway north-south -w     # wait for PROGRAMMED=True
```

Then, from WSL **or a Windows browser** — no port-forward, through a real gateway:

```bash
curl -sN http://a2a.localhost:8080/a2a/ops_concierge \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"m1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}'
```

`*.localhost` resolves to 127.0.0.1 without touching `/etc/hosts`, and kind maps
host 8080 → NodePort 30080 → the Envoy Service.

## Why not `kubectl port-forward`?

Because it tunnels directly to a pod and skips every gateway, policy and proxy
you are trying to learn. It is a debugging tool that answers "is the pod alive",
not "does my ingress path work". Using it here would test nothing. That is why
lab 10 bothered with `extra_port_mappings`.

## The three things that break, in order

Work through these; they are the actual content of the lab.

### 1. The stream dies after 15 seconds

Remove the `timeouts` block from `httproute.yaml`, re-apply, and run the curl
again. The compliance scan takes 8s, the deployment job 20s — and Envoy's
default 15s request timeout cuts the SSE stream mid-negotiation. The client sees
a truncated stream and no error worth reading.

A2A streams are long by design: `message/stream` holds the response open for a
whole turn, and a `tasks/resubscribe` watcher holds it open indefinitely. **Every
proxy between a caller and an agent needs its timeouts raised**, and there are
usually more of them than you think — gateway, service mesh, cloud load
balancer, corporate egress proxy. Any one of them at 60s silently caps your
agent's longest possible turn.

### 2. The agent card advertises the wrong URL

```bash
curl -s http://a2a.localhost:8080/a2a/ops_concierge/.well-known/agent-card.json | jq -r '.supportedInterfaces[0].url'
```

If that prints anything other than `http://a2a.localhost:8080/a2a/ops_concierge`,
an external A2A client will read the card, take the URL at face value, and send
its RPC somewhere useless — its own loopback, most likely.

The card is a **public contract**, and it has to name the address callers reach,
not the address the process binds. `values-concierge.yaml` sets `servedAgentCard`
to the gateway hostname for exactly this reason. Change the gateway hostname and
you must change the card; they are one fact stored in two places, which is worth
knowing before it bites.

### 3. STRICT mTLS locks the gateway out

If you applied `04-strict-mtls.yaml` in lab 40, traffic from the gateway to
`ops-concierge` is plaintext from outside the mesh, and gets refused.

Two fixes, and the choice is a real design decision:

```bash
# (a) put the gateway in the mesh — it gets an identity, traffic is mTLS end to end
kubectl label namespace envoy-gateway-system istio.io/dataplane-mode=ambient
```

or scope the `PeerAuthentication` to `PERMISSIVE` for the gateway's port. (a) is
almost always right: a gateway that is not in the mesh is a hole in it, and an
in-mesh gateway means your L7 authorization policies can name the gateway's
identity as a caller.

## What the platform now sees that it did not before

```bash
kubectl -n agents logs -l gateway.envoyproxy.io/owning-gateway-name=north-south --tail=20
```

A north-south call produces a gateway access log with a client address, a TLS
decision, a route match and a response code — before any mesh telemetry exists.
An east-west call produces none of that, because there was no gateway and
identity was settled by certificate before the first byte.

That is the concrete difference the terms describe. Run both and diff the
evidence:

```bash
../../scripts/compare-paths.sh
```

## What Envoy Gateway does not do here

It is routing HTTP. It has no idea this is A2A: it cannot see a `taskId`, cannot
tell `message/stream` from `tasks/cancel`, cannot apply a policy to one agent
skill and not another, and its access logs say `POST /a2a/ops_concierge 200`
whether that was a quote or a cancellation.

For plenty of systems that is fine. When A2A is your product surface it is not —
which is lab 60.

→ [Lab 60: agentgateway](../60-agentgateway/)
