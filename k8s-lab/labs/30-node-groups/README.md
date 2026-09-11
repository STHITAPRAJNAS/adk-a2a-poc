# Lab 30 — Node groups: CPU and GPU

**Read [docs/apple-silicon-reality.md](../../docs/apple-silicon-reality.md)
first.** There is no GPU in this cluster and there cannot be. This lab teaches
the part you actually operate — placement, isolation and capacity — with a
simulated resource deliberately named `lab.local/gpu` so nothing can be mistaken
for real hardware.

## The three mechanisms

A node group is three separate things that people tend to blur into one:

| | Does | Without it |
|---|---|---|
| **Label** | Lets a pod *choose* the pool | Nothing can target the pool |
| **Taint** | Stops everything else *landing* there | General workloads drift onto your expensive nodes |
| **Extended resource** | Makes capacity *countable* | Ten pods "using the GPU" on a one-GPU node |

You need all three. Two out of three fails in a way that only shows up under load.

## Run it

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig

# labels + taints
terraform init && terraform apply

# extended resource — Terraform cannot patch node *status*, so this is a script
../../scripts/advertise-gpu.sh a2a-lab-worker3 2

kubectl get nodes -L lab.local/pool,node.kubernetes.io/instance-type
kubectl get node a2a-lab-worker3 -o jsonpath='{.status.allocatable}' | jq
```

The last command should show `"lab.local/gpu": "2"` alongside cpu and memory.

### Why the resource needs a script

`kubernetes_labels` and `kubernetes_node_taint` write to a node's **spec**,
which Terraform is happy to own. Extended resources live in a node's **status**,
reachable only through the `/status` subresource with a JSON-patch — and status
is the kubelet's to write, not a controller's. On a real cluster a **device
plugin** does this: it discovers hardware and reports it to the kubelet every
few seconds.

`advertise-gpu.sh` patches status directly, which is the documented way to
advertise an extended resource without a device plugin. It is exactly what a
device plugin would report, minus the hardware — and it is honest about being a
poke rather than a controller. Note the consequence: the value does not survive
a kubelet restart, because nothing is re-reporting it. That is not a bug in the
script, it is the difference between a patch and a plugin.

## Scheduling: yes, no, and not yet

```bash
kubectl create namespace scheduling-lab
kubectl apply -f workloads.yaml
kubectl -n scheduling-lab get pods -o wide
```

| Pod | Expected |
|---|---|
| `gpu-job-good` | `Running` on `a2a-lab-worker3` |
| `gpu-job-no-toleration` | `Pending` — repelled by the taint |
| `gpu-job-too-greedy` | `Pending` — asks for 99 of 2 |

The two Pending pods look identical in `get pods`. They are not:

```bash
kubectl -n scheduling-lab describe pod gpu-job-no-toleration | tail -5
#   0/4 nodes are available: 1 node(s) had untolerated taint
#   {lab.local/accelerator: simulated}, 3 node(s) didn't match Pod's node affinity/selector.

kubectl -n scheduling-lab describe pod gpu-job-too-greedy | tail -5
#   0/4 nodes are available: 1 Insufficient lab.local/gpu, 3 node(s) didn't match …
```

**Learn to read that line.** It is the single most useful diagnostic in
Kubernetes, it tells you exactly which predicate rejected which nodes, and it is
the answer to almost every "why is my pod Pending" question you will ever be
asked.

## Pin the agents to the CPU pool

```bash
helm upgrade ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml -f ./agent-placement.yaml
helm upgrade deployment-agent ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-specialist.yaml -f ./agent-placement.yaml

kubectl -n agents get pods -o wide      # never on worker3
```

`agent-placement.yaml` uses `nodeAffinity` rather than `nodeSelector`, and the
required term is `accelerator NotIn [simulated]` rather than `pool In [cpu]` —
so a third pool added next month is eligible without anyone remembering to edit
this file. The preferred term still favours the CPU pool. Under pressure the
pod lands somewhere rather than nowhere, which for a stateless front door is the
right trade.

## Things worth breaking

Each of these takes a minute and teaches more than reading about it.

1. **Remove the taint**, then apply an unconstrained Deployment with 6 replicas.
   Watch pods land on the GPU node. Re-apply the taint — note the running pods
   *stay*, because `NoSchedule` is not `NoExecute`.
2. **Set the resource to 1** and apply two `gpu-job-good` pods. The second goes
   Pending. Delete the first and watch the second schedule within seconds.
3. **Delete the extended resource** (`advertise-gpu.sh a2a-lab-worker3 0`) while
   a pod is using it. The pod keeps running — the scheduler only consults
   capacity at placement time. Nothing reclaims it.
4. **Add a `PriorityClass`** to the GPU job and fill the node with low-priority
   pods. Watch preemption evict them. This is how a real GPU cluster keeps
   expensive hardware busy without letting batch jobs squat on it.

## What transfers to a real cluster

Everything except the resource name. On EKS or GKE with the NVIDIA device
plugin:

- `lab.local/gpu` → `nvidia.com/gpu`
- the taint is applied by the node group definition rather than by you
- `node.kubernetes.io/instance-type` is already there, and reads `g5.xlarge`
- the device plugin advertises capacity continuously instead of once

The manifests in `workloads.yaml` work unchanged after that rename. Lab 90 does
exactly that swap against real hardware.

→ [Lab 40: Istio ambient — east-west](../40-istio-ambient/)
