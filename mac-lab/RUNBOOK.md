# Runbook — zero to a working cluster, end to end (macOS)

The macOS / Docker Desktop variant of the lab. It takes an empty MacBook to a
kind cluster running the two A2A agents behind a service mesh and real gateways,
shaped like EKS. **No GPU node group** — a MacBook's GPU isn't a CUDA device kind
can inject — so lab 30 teaches the same scheduling mechanics on CPU nodes, and
the agents run on the scripted fake LLM (with an optional path to a real local
Ollama on the Mac's Metal GPU).

Each phase ends with a **Gate**: a command whose output tells you whether to
proceed. Don't move on with a red gate.

> **KUBECONFIG once.** Everything after Phase 1 needs this. Put it in your shell
> profile so every terminal has it:
> ```bash
> echo 'export KUBECONFIG=~/adk-a2a-poc/mac-lab/labs/10-cluster/kubeconfig' >> ~/.zshrc
> ```

---

## Phase 0 — the machine  ·  ~10 min

Everything runs on the Mac host talking to Docker Desktop's Linux VM. Full detail
with a check at each step: [docs/mac-docker-desktop.md](docs/mac-docker-desktop.md).

```bash
# 0a — Docker Desktop: install, start it, and in Settings ▸ Resources give it
#      Memory 12 GB (8 GB floor) and CPUs 4+. Turn OFF Settings ▸ Kubernetes.

# 0b — the CLIs
brew install kind kubectl helm terraform istioctl jq
brew install k9s        # optional, handy from lab 40

# 0c — sanity
docker info >/dev/null && echo "docker up"
docker run --rm alpine uname -m         # aarch64 on Apple Silicon
```

The inotify limits Istio needs live inside the kind nodes and are set **after**
the cluster exists — `scripts/start-cluster.sh` does it automatically, so there's
nothing to do here except know it exists (Phase 4 reminds you).

### ▸ Gate 0

```bash
cd ~/adk-a2a-poc/mac-lab
make doctor
```

Green on arch, tools, Docker Desktop resources, and free ports. (The inotify
check may be red until the cluster exists — that's fine now; it must be green by
Phase 4.)

---

## Phase 1 — the cluster  ·  ~3 min

```bash
cd labs/10-cluster
terraform init
terraform apply                     # 3 nodes: 1 control-plane + 2 'general' workers
export KUBECONFIG=$PWD/kubeconfig   # already in ~/.zshrc if you added it above
cd ../..
```

### ▸ Gate 1

```bash
./scripts/verify-10-cluster.sh
```

Three nodes Ready, the `general` node group labelled, no GPU node group, zone
labels present. → [lab 10](labs/10-cluster/)

---

## Phase 2 — the agents  ·  ~10 min

```bash
# build the agent image FOR arm64 (Apple Silicon default) and load it into kind
./images/build.sh                   # Intel Mac: ./images/build.sh --platform amd64

helm upgrade --install deployment-agent ./charts/adk-agent -n agents --create-namespace \
  -f ./charts/adk-agent/values-specialist.yaml --wait
helm upgrade --install ops-concierge ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-concierge.yaml --wait
```

The agents run on `POC_FAKE_LLM=1` (set in the chart values) — no API key, a
deterministic scripted model, so a failing A2A call is a network bug, not the
LLM.

### ▸ Gate 2

```bash
./scripts/verify-20-agents.sh
```

Both pods `1/1 Running`, both Agent Cards served, an A2A negotiation completing
pod-to-pod. If a pod is `CrashLoopBackOff` with `exec format error`, the image
arch is wrong — rebuild with the right `--platform`. → [lab 20](labs/20-agents-on-k8s/)

---

## Phase 3 — node groups & scheduling  ·  ~10 min

No GPU here; the same three scheduling mechanisms (label, taint, extended
resource) on a CPU node. Pick a worker, make it a "pool", advertise a fake
countable resource, and watch pods schedule, get repelled, and overflow.

```bash
NODE=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=general -o name | head -1 | cut -d/ -f2)
kubectl label node "$NODE" lab.local/pool=accel --overwrite
kubectl taint node "$NODE" lab.local/accel=present:NoSchedule --overwrite
./scripts/advertise-resource.sh "$NODE" 2
kubectl apply -f ./labs/30-node-groups/scheduling-workloads.yaml
```

### ▸ Gate 3

```bash
kubectl -n scheduling-lab get pods -o wide
```

`accel-good` Running; `accel-no-toleration` Pending (taint); `accel-too-greedy`
Pending (Insufficient). Read *why* — the buckets differ:

```bash
kubectl -n scheduling-lab describe pod accel-no-toleration | tail -4   # untolerated taint
kubectl -n scheduling-lab describe pod accel-too-greedy   | tail -4   # Insufficient
```

Then pin the agents to the general pool and clean up:

```bash
make place                                    # helm re-roll with agent-placement.yaml
kubectl delete ns scheduling-lab --ignore-not-found
kubectl taint node "$NODE" lab.local/accel=present:NoSchedule- 2>/dev/null || true
kubectl label node "$NODE" lab.local/pool- 2>/dev/null || true
```

→ [lab 30](labs/30-node-groups/) (also: how to run a real local Ollama on the
Mac's GPU, if you want inference)

---

## Phase 4 — service mesh, east-west  ·  ~10 min

```bash
./labs/40-istio-ambient/install.sh
kubectl apply -f ./labs/40-istio-ambient/enroll.yaml
kubectl apply -f ./labs/40-istio-ambient/01-l4-authz.yaml
```

If `install.sh` dies on the `istio-cni` step with `context deadline exceeded` and
the CNI pods are `CrashLoopBackOff` (`couldn't initialize inotify: too many open
files`), the **VM's inotify limits are too low**. On macOS you raise them inside
the kind nodes, then restart the CNI:

```bash
for n in $(docker ps --filter name=a2a-lab -q); do
  docker exec "$n" sysctl -w fs.inotify.max_user_instances=8192
  docker exec "$n" sysctl -w fs.inotify.max_user_watches=524288
done
kubectl -n istio-system rollout restart ds/istio-cni-node
./labs/40-istio-ambient/install.sh    # idempotent
```

(`scripts/start-cluster.sh` applies those sysctls on every start, so this bites
only on the very first install before you've used that script.)

### ▸ Gate 4

```bash
./scripts/verify-40-mesh.sh
```

Namespace enrolled, workloads speaking HBONE, **an unauthorised caller refused**,
and pods still `1/1` (no sidecar injected). Four things learned the hard way:

- **An L4 deny is a TCP reset, not an HTTP 403.** ztunnel works at L4, so a
  refused caller sees `curl: (56) Connection reset` / http_code `000`, not `403`.
  `403` is the L7 form you get once a waypoint is in front.
- **Attach the L4 `AuthorizationPolicy` with a workload `selector`, not a Service
  `targetRefs`.** ztunnel enforces selector-based policies reliably; a Service
  `targetRef` was silently unenforced (impostor still got `200`).
- **Enroll before deploy, or restart once.** If the namespace was enrolled *after*
  the agents were running (or while the CNI was crash-looping), the pods missed
  the one-time capture — `istioctl ztunnel-config workload` shows them without
  `HBONE`. `kubectl -n agents rollout restart deploy/...` fixes it.
- **istioctl vs mesh version skew:** `downloadIstio` installs the *latest*
  istioctl against a pinned mesh, so `istioctl ztunnel-config workload --namespace
  <ns>` can error. Dump without the flag and filter yourself.

Then add the waypoint to see what L7 buys over L4:

```bash
kubectl apply -f ./labs/40-istio-ambient/02-waypoint.yaml
kubectl -n agents label service deployment-agent istio.io/use-waypoint=agents-waypoint
kubectl apply -f ./labs/40-istio-ambient/03-l7-authz.yaml
```

→ [lab 40](labs/40-istio-ambient/)

---

## Phase 5 — ingress, north-south  ·  ~10 min

```bash
./labs/50-north-south/install.sh                       # Envoy Gateway controller
kubectl apply -f ./labs/50-north-south/gateway.yaml -f ./labs/50-north-south/httproute.yaml
kubectl -n envoy-gateway-system rollout status \
  deploy -l gateway.envoyproxy.io/owning-gateway-name=north-south --timeout=180s
```

### ▸ Gate 5

**Judge success by traffic, not by the Gateway's `Programmed` condition.** The
Envoy Service is a NodePort, which never gets a LoadBalancer address on kind, so
`Programmed` can read `False`/late even when routing works. Test the card (fastest
signal), then the full stream — from your **Mac terminal or browser**, the host
port mapping goes all the way out:

```bash
# plain GET through the gateway — want 200
curl -sS -m 10 -o /dev/null -w '%{http_code}\n' \
  http://a2a.localhost:8080/a2a/ops_concierge/.well-known/agent-card.json

# the full negotiation from outside the cluster — want submitted → working → input-required
curl -sN http://a2a.localhost:8080/a2a/ops_concierge \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"m1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}'
```

Two things this phase taught the hard way (both already fixed in `gateway.yaml`):

- **The Envoy Service needs `externalTrafficPolicy: Cluster` on kind.** This was
  *the* ingress bug. kind maps host `:8080` to the **control-plane** node's
  `:30080`, but the Envoy proxy pod runs on a **worker**. Envoy Gateway defaults
  the Service to `externalTrafficPolicy: Local`, which routes a NodePort only to a
  proxy pod on the node the traffic entered — so requests arriving on the
  control-plane node (no proxy there) are silently dropped. Symptom: `curl`
  connects to `:8080` then hangs/resets, while agents work when hit directly. If
  an ingress connects-then-hangs on kind, check the Service's traffic policy first.
- **The `EnvoyProxy` NodePort patch keys on `port`, not `name`.** A StrategicMerge
  on a Service's `ports` list merges by `port`; omit it and the merge is rejected
  (`does not contain declared merge key: port`), the Service never finalizes, and
  every request hangs. `gateway.yaml` pins `port: 80` + `nodePort: 30080`.

→ [lab 50](labs/50-north-south/)

---

## Phase 5.5 — policy-as-code with OPA  ·  ~10 min

Two enforcement points from one OPA instance: a **network gate** at the Envoy
Gateway (an A2A POST must carry `x-change-ticket`), and a **tool-call gate**
inside the agents (OPA, not the LLM, decides which tools may run).

```bash
# Stage 1 — deploy OPA + wire it into the gateway as ext_authz
kubectl apply -f ./labs/55-opa-authz/opa.yaml
kubectl -n agents rollout status deploy/opa
kubectl apply -f ./labs/55-opa-authz/securitypolicy.yaml

# Stage 2 — make the agents obey the tools policy (needs the guard code + env)
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent OPA_URL=http://opa:8181
kubectl -n agents rollout status deploy/ops-concierge deploy/deployment-agent
```

> The agent image already contains `common/opa_guard.py`; `OPA_URL` is the switch
> (unset → no-op). If you built the image before this file existed, rebuild:
> `./images/build.sh && kubectl -n agents rollout restart deploy/ops-concierge deploy/deployment-agent`.

### ▸ Gate 5.5

```bash
./scripts/verify-55-opa.sh
```

Network layer: card GET 200, POST without the header 403, POST with it 200.
Tools layer (over OPA's REST API): production deploy denied, staging allowed,
concierge→transfer allowed, a frozen service denied at the first tool. Then drive
it end-to-end through the gateway:

```bash
say() { curl -sN -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -H 'x-change-ticket: CHG-0001' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"message/stream\",\"params\":{\"message\":{\"messageId\":\"m1\",\"kind\":\"message\",\"role\":\"user\",\"parts\":[{\"kind\":\"text\",\"text\":\"$1\"}]}}}" \
  http://a2a.localhost:8080/a2a/ops_concierge; echo; }

say "deploy checkout-api 2.14.0 to staging"      # ALLOWED — start_deployment runs
say "deploy billing-worker 3.1.0 to production"  # DENIED at the first tool (frozen service)
```

→ [lab 55](labs/55-opa-authz/)

---

## Phase 6 — A2A-aware ingress  ·  ~10 min

The gateways so far are HTTP-aware only; agentgateway understands A2A itself.

```bash
source versions.env
helm upgrade --install agentgateway oci://ghcr.io/agentgateway/charts/agentgateway \
  --version "${AGENTGATEWAY_VERSION#v}" -n agentgateway-system --create-namespace --wait
kubectl apply -f ./labs/60-agentgateway/gateway.yaml -f ./labs/60-agentgateway/a2a-route.yaml
```

> agentgateway will need the same kind treatment as Phase 5 — NodePort 30081,
> `externalTrafficPolicy: Cluster` — so host `:8081` reaches its proxy wherever it
> runs. Chart coordinates are **unverified**; check <https://agentgateway.dev/docs/>
> if the install fails, and fix the file.

### ▸ Gate 6

```bash
./scripts/verify-60-a2a-ingress.sh
```

The card served through the gateway must advertise the **gateway's** URL — if it
advertises anything else, an external A2A client sends its RPC somewhere useless,
the single most common way an exposed ADK agent fails. → [lab 60](labs/60-agentgateway/)

---

## Phase 7 — the payoff

```bash
./scripts/compare-paths.sh      # same negotiation east-west vs north-south, side by side
make verify                     # every check at once
```

Same protocol, same agents, same result — different evidence, because a boundary
was crossed. That comparison is what the whole lab exists for.

---

## Phase 8 — optional: LLM egress  ·  needs a Gemini key

Everything so far ran on the scripted model. [Lab 70](labs/70-agent-router/) turns
the real one on and puts a gateway in front of the agents' outbound model traffic
— the fourth boundary, the one nobody instruments and everybody pays for.

(Prefer a *local* real model? See lab 30's optional section: run Ollama natively
on macOS and point the agents at `host.docker.internal:11434`.)

---

## Stopping and restarting

The cluster is kind (Docker containers), not real EKS, so stopping it does **not**
destroy it — etcd, deployments and volumes persist in the node containers.

```bash
./scripts/stop-cluster.sh      # halt the cluster, keep it on disk (frees RAM)
./scripts/start-cluster.sh     # bring it back after a reboot or a stop
```

`start-cluster.sh` runs in order: ensure Docker Desktop is up (`open -a Docker` if
not) → `docker start` the kind node containers → reapply the inotify sysctls Istio
needs → set `KUBECONFIG` → wait for nodes `Ready`.

**After a Mac reboot:** start Docker Desktop (or let the script `open` it), then
`./scripts/start-cluster.sh`. Two gotchas:

- **Port-forwards never survive** anything — they're per-shell processes. Restart
  the ones you use.
- A script runs in a subshell, so `start-cluster.sh` can't set `KUBECONFIG` in
  *your* shell — it prints the line. That's why it's in `~/.zshrc` (top of this
  file).

To pause only some workloads while keeping Kubernetes up, scale them instead of
stopping the cluster: `kubectl -n agents scale deploy/ops-concierge deploy/deployment-agent --replicas=0`.

---

## Rebuilding from scratch (full, reproducible)

The cluster is disposable — rebuilding is faster than forensics and resets
CNI/networking, clearing data-path weirdness a long-lived kind cluster
accumulates. ~15 min, all scripted. Phase 0 host prep (Docker Desktop, CLIs)
survives; only the cluster is rebuilt.

```bash
cd ~/adk-a2a-poc && git pull origin claude/k8s-a2a-lab && cd mac-lab

# 1 — CLUSTER
make clean
(cd labs/10-cluster && terraform apply)
export KUBECONFIG=$PWD/labs/10-cluster/kubeconfig     # already in ~/.zshrc
kubectl get nodes                                     # 3 Ready

# 2 — AGENTS (scripted model)
./images/build.sh                                     # arm64 by default
helm upgrade --install deployment-agent ./charts/adk-agent -n agents --create-namespace \
  -f ./charts/adk-agent/values-specialist.yaml
helm upgrade --install ops-concierge ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-concierge.yaml
kubectl -n agents get pods                            # both 1/1 Running
./scripts/verify-20-agents.sh

# 3 — MESH: raise inotify FIRST, install, enroll, RESTART agents so ztunnel captures them
for n in $(docker ps --filter name=a2a-lab -q); do
  docker exec "$n" sysctl -w fs.inotify.max_user_instances=8192
  docker exec "$n" sysctl -w fs.inotify.max_user_watches=524288
done
./labs/40-istio-ambient/install.sh
kubectl apply -f ./labs/40-istio-ambient/enroll.yaml
kubectl -n agents rollout restart deploy/ops-concierge deploy/deployment-agent
kubectl -n agents rollout status  deploy/ops-concierge
kubectl apply -f ./labs/40-istio-ambient/01-l4-authz.yaml
./scripts/verify-40-mesh.sh                           # all four ✓

# 4 — INGRESS
./labs/50-north-south/install.sh
kubectl apply -f ./labs/50-north-south/gateway.yaml -f ./labs/50-north-south/httproute.yaml
kubectl -n envoy-gateway-system rollout status \
  deploy -l gateway.envoyproxy.io/owning-gateway-name=north-south --timeout=180s
sleep 10
curl -sS -m 10 -o /dev/null -w 'card via gateway: %{http_code}\n' \
  http://a2a.localhost:8080/a2a/ops_concierge/.well-known/agent-card.json   # want 200
```

**Key ordering lesson:** agents are enrolled into the mesh *after* they exist, so
they must be **restarted once** (step 3) to be captured by ztunnel — on a clean
install, pods deployed into an already-enrolled namespace are captured at birth
with no restart. OPA (Phase 5.5) and agentgateway (Phase 6) layer on after step 4.

---

## Where the state lives

| | |
|---|---|
| kubeconfig | `labs/10-cluster/kubeconfig` |
| Terraform state | `labs/10-cluster/terraform.tfstate` (gitignored) |
| Agent image | your Docker Desktop daemon, loaded into kind |
| kind node containers | Docker Desktop — survive a reboot (stopped, not removed) |
| inotify sysctls | inside the node containers — reset on node restart, reapplied by start-cluster.sh |
| Everything else | in the cluster, gone on `make clean` |

Nothing here touches the Mac outside Docker Desktop, and nothing costs money until
lab 70 (a Gemini key) or the Windows lab's optional lab 90 (cloud GPUs).
