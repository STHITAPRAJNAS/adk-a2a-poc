# Lab 40 — Istio ambient: east-west

The A2A call from `ops_concierge` to `deployment_agent` currently crosses the
cluster network in plaintext, and any pod that can reach the Service can call
it. This lab fixes both without touching the agents.

## Install

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig
./install.sh
```

Four charts: `base` (CRDs), `istiod` (control plane), `cni` (wires pods into the
mesh), `ztunnel` (the L4 proxy). `ztunnel` is a **DaemonSet** — one per node,
not one per pod. That is the entire difference from sidecars, and it is why
enrolling a namespace costs nothing per workload.

## Join the mesh

```bash
kubectl apply -f enroll.yaml     # one label on the namespace
kubectl -n agents get pods       # still 1/1 — no sidecar was injected
```

One label. No pod restart, no Deployment change, no container added. Run the
verification from lab 20 again — the A2A negotiation still works, now encrypted.

```bash
istioctl ztunnel-config workload --namespace agents
```

Both agents appear with `PROTOCOL: HBONE`. Traffic between them is now mTLS,
with certificates issued per ServiceAccount.

## Identity, not IP addresses

```bash
kubectl apply -f 01-l4-authz.yaml
```

The policy names `cluster.local/ns/agents/sa/ops-concierge` — a **SPIFFE
identity**, taken from the client's certificate. Not an IP, not a header, not a
label. Nothing running in a pod can forge it, because forging it means forging a
certificate the mesh issued.

Prove it bites:

```bash
# an impostor with a different ServiceAccount
kubectl -n agents run impostor --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS -o /dev/null -w '%{http_code}\n' \
  http://deployment-agent:8001/a2a/deployment_agent/.well-known/agent-card.json
# → 000, connection reset. ztunnel refused it at L4.
```

That is the east-west win in one command: the specialist is now callable by one
named workload, and its own logs will never even see the attempt.

## L4 and L7 are different, and ambient makes you notice

Try to write a policy that allows `GET` on the card but denies `POST` to the RPC
endpoint. You cannot — not with what is deployed. ztunnel sees TCP and
identities; it has no idea what HTTP is flowing inside.

That is the seam sidecars hide. Deploy a waypoint and it opens:

```bash
kubectl apply -f 02-waypoint.yaml
kubectl -n agents label service deployment-agent istio.io/use-waypoint=agents-waypoint
kubectl apply -f 03-l7-authz.yaml
```

Now method and path are enforceable:

```bash
kubectl -n agents run probe --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS -o /dev/null -w '%{http_code}\n' http://deployment-agent:8001/health   # 200
  # …and the same pod POSTing to /a2a/deployment_agent → 403 RBAC: access denied
```

| | ztunnel (L4) | waypoint (L7) |
|---|---|---|
| Runs | One per node | One per namespace or service, opt-in |
| Sees | TCP, identities | HTTP methods, paths, headers |
| Costs | Nothing per workload | A proxy hop |
| Gives you | mTLS, identity authz | Route-level authz, retries, per-route metrics |

Pay for L7 where you need it. For the A2A path you probably do: "may call" and
"may call *this method*" are different questions once an agent exposes more than
one skill.

## Lock the door

```bash
kubectl apply -f 04-strict-mtls.yaml
```

Ambient accepts plaintext from outside the mesh by default, so enrolling a
namespace never breaks a half-migrated system. `STRICT` ends that. Apply it only
when everything that must reach these pods is in the mesh — **including your
gateway**, which is exactly what lab 50 has to deal with.

## What this does and does not do for A2A

**Does:** encrypts every A2A hop; gives each agent an identity the platform
issues and rotates; lets you say which agent may call which; gives per-workload
telemetry for free.

**Does not:** change anything the agents see. They still speak plain HTTP to a
cluster DNS name. The mesh is transparent — which is why the card-resolution
problem from lab 20 is *not* solved by adding mTLS. The application still holds
an `http://` URL, and ADK still validates it as plain http, because from the
process's point of view that is exactly what it is.

That distinction trips people up constantly: "we have mTLS" and "the app is
using TLS" are different statements, and ADK's card validator cares about the
second one.

## Verify

```bash
../../scripts/verify-40-mesh.sh
```

Checks enrolment, that both workloads are HBONE, that the impostor is refused,
and that the A2A negotiation still completes end to end.

## Things that go wrong

| Symptom | Cause |
|---|---|
| Pods not in the mesh after labelling | `istio-cni` not running, or pods predate the label. Restart the Deployment. |
| Everything 403s after `03-l7-authz` | AuthorizationPolicy is deny-by-default once any ALLOW rule targets a service. Your health check needs its own rule — that is why one is in the file. |
| Probes fail after `04-strict-mtls` | The kubelet is not in the mesh. Ambient exempts health checks; if you moved to sidecars, this bites. |
| `istioctl ztunnel-config` empty | Wrong namespace, or ztunnel not scheduled on that node. |
| A2A works but no telemetry | Port not named `http-a2a` — see lab 20. |

→ [Lab 50: north-south](../50-north-south/)
