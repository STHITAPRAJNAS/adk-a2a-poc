# Lab 30 — Node groups and scheduling (Mac variant, no GPU)

The Windows lab makes a real GPU **schedulable** and then breaks scheduling in
the three ways that matter. A MacBook has no CUDA device to inject, so this
variant teaches the **exact same three mechanisms on a CPU node pool**, using a
taint you apply and a *fake* extended resource. The scheduling lessons — and the
`kubectl describe` output you learn to read — are identical; only the workload
can't actually compute.

> Want real local inference too? Run **Ollama natively on macOS** (it uses the
> Metal GPU) and point the agents at `http://host.docker.internal:11434`. That's
> outside the cluster, so it isn't a node-group lesson — it's noted at the end.

## The three mechanisms

A node group is three separate things people tend to blur into one:

| | Does | Without it |
|---|---|---|
| **Label** | Lets a pod *choose* the pool | Nothing can target it |
| **Taint** | Stops everything else *landing* there | Batch jobs squat on your reserved nodes |
| **Extended resource** | Makes capacity *countable* | Ten pods "using" one device |

Lab 10 set the `general` pool's labels and zones at node registration, the way an
EKS node group's launch template does. Here you add a taint and a countable
resource to one node to see all three interact.

## Set up a dedicated pool on one CPU node

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig

# pick one general worker to act as the "accelerator" pool
NODE=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=general -o name | head -1 | cut -d/ -f2)
echo "using $NODE"

kubectl label node "$NODE" lab.local/pool=accel --overwrite
kubectl taint node "$NODE" lab.local/accel=present:NoSchedule --overwrite
../../scripts/advertise-resource.sh "$NODE" 2       # advertise lab.local/accelerator=2
```

> On EKS the label, taint and (via a device plugin) the resource all arrive with
> the node group. Here you apply them by hand so you can watch each one take
> effect — but the pod-side manifests are exactly what you'd write on EKS.

## Scheduling: yes, no, and not yet

```bash
kubectl apply -f scheduling-workloads.yaml
kubectl -n scheduling-lab get pods -o wide
```

| Pod | Expected |
|---|---|
| `accel-good` | `Running` on the pooled node |
| `accel-no-toleration` | `Pending` — repelled by the taint |
| `accel-too-greedy` | `Pending` — asks for 8 of 2 |

The two Pending pods look identical in `get pods`. They are not:

```bash
kubectl -n scheduling-lab describe pod accel-no-toleration | tail -4
#   1 node(s) had untolerated taint {lab.local/accel: present}, N node(s) didn't match nodeSelector

kubectl -n scheduling-lab describe pod accel-too-greedy | tail -4
#   1 Insufficient lab.local/accelerator, N node(s) didn't match nodeSelector
```

**Learn to read that line.** It names which predicate rejected which nodes, and
it answers almost every "why is my pod Pending" question you will ever be asked.
The `taint` bucket is structural; the `Insufficient` bucket is arithmetic.

## Pin the agents to the general pool

The agents should never land on a reserved pool. `agent-placement.yaml` expresses
that as *"not an accelerator node"* rather than *"the general pool"*, so a pool
added next month is eligible without editing the file:

```bash
helm upgrade ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml -f ./agent-placement.yaml
helm upgrade deployment-agent ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-specialist.yaml -f ./agent-placement.yaml

kubectl -n agents get pods -o wide
```

> The file selects on `nvidia.com/gpu.present DoesNotExist` (a no-op label that
> is simply absent on every Mac node) and spreads by zone. Both are valid here;
> the zone spread is meaningful because lab 10 gave the two workers different
> fake AZs.

## Things worth breaking

Each takes a minute and teaches more than reading about it.

1. **Remove the toleration from `accel-good`** and re-apply. It joins the Pending
   pods — the taint is what was letting it in, not the label.
2. **Ask for `lab.local/accelerator: 2`** in two pods. The second stays Pending
   even though nothing is computing: extended resources are *counted*, and there
   are only 2. This is the CPU-node version of "GPUs aren't shared".
3. **Restart the node's kubelet** (`docker restart <node-container>`), then
   `kubectl get node <n> -o jsonpath='{.status.capacity.lab\.local/accelerator}'`.
   The fake resource is **gone** — nothing re-reported it. That vanishing is
   precisely the difference between this PATCH and a real device plugin, which
   re-advertises every few seconds. Re-run `advertise-resource.sh` to restore it.
4. **Delete the zone labels** from a node and re-roll the agents. The
   `topologySpreadConstraint` silently stops constraining. `ScheduleAnyway` means
   no error — which is why a spread constraint that does nothing is a common,
   invisible bug.
5. **Cordon the pooled node** (`kubectl cordon`) with `accel-good` running. It
   stays; only new pods are refused. Then `drain` and watch the difference.

## Clean up before lab 40

```bash
kubectl delete ns scheduling-lab --ignore-not-found
kubectl taint node "$NODE" lab.local/accel=present:NoSchedule- 2>/dev/null || true
kubectl label node "$NODE" lab.local/pool- 2>/dev/null || true
```

(The fake resource clears itself on the next kubelet restart; nothing else needs
undoing.)

## Optional — real local inference on the Mac's GPU

The scheduling demo above is about *placement*, not inference. If you want the
agents to run on a real local model, the Mac's own Metal GPU is the easy win —
run Ollama **on macOS** (not in a pod) so it gets the GPU natively:

```bash
brew install ollama && ollama serve &        # on the Mac host
ollama pull llama3.2:1b

# point the in-cluster agents at the host — Docker Desktop resolves this name
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent \
  OLLAMA_API_BASE=http://host.docker.internal:11434 \
  ORCHESTRATOR_MODEL=llama3.2:1b DEPLOYMENT_AGENT_MODEL=llama3.2:1b
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent POC_FAKE_LLM=0
```

`common/config.py:resolve_model` wraps the model in a LiteLLM `ollama_chat/`
client when `OLLAMA_API_BASE` is set — the same path the Windows lab uses for
in-cluster Ollama, just pointed at the host instead of a GPU pod.

## What transfers to EKS

Almost everything, because lab 10 used EKS's own label keys.

| Here | EKS |
|---|---|
| `eks.amazonaws.com/nodegroup: general` | identical |
| taint + toleration | taint applied by the node group; same toleration |
| `lab.local/accelerator` (fake, PATCHed) | `nvidia.com/gpu` (real, via device plugin) |
| fixed node count | Karpenter provisions on Pending, scales to zero when idle |

That last row inverts a habit: on a fixed cluster a Pending pod is a bug; on an
autoscaled one it is the normal first thirty seconds of a pod's life.
[docs/eks-parity.md](../../docs/eks-parity.md) has the rest.

→ [Lab 40: Istio ambient — east-west](../40-istio-ambient/)
