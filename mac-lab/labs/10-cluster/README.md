# Lab 10 — The cluster (Mac variant)

A three-node cluster shaped like an EKS cluster with one managed node group:
`general` (2 nodes, spread across fake AZs) plus the control-plane. The Windows
lab adds a tainted `gpu-a10g` node with a real GPU injected; **this Mac variant
has no GPU node group** — a MacBook's GPU is not a CUDA device kind can inject —
so lab 30 here teaches the same node-group *scheduling* mechanics on CPU nodes.

## Before you start

Docker Desktop running, and `make doctor` (from `mac-lab/`) green. That's it —
no GPU prerequisites on this variant.

## Run it

```bash
cd labs/10-cluster
terraform init
terraform plan       # read it — this is the whole cluster on one screen
terraform apply

export KUBECONFIG=$PWD/kubeconfig
kubectl get nodes -L eks.amazonaws.com/nodegroup,node.kubernetes.io/instance-type,topology.kubernetes.io/zone
```

```
NAME                   STATUS  NODEGROUP  INSTANCE-TYPE  ZONE
a2a-lab-control-plane  Ready
a2a-lab-worker         Ready   general    m6i.large      eu-west-1a
a2a-lab-worker2        Ready   general    m6i.large      eu-west-1b
```

`gpu_worker_count` defaults to `0` and `enable_gpu` to `false`, so no GPU node is
created — you don't pass any flags. (The `main.tf` is byte-for-byte the Windows
lab's; the GPU node group's `dynamic "node"` block simply expands to nothing when
the count is 0.)

## What to notice

**Labels and zones arrive with the node, not after it.** They are set through
`kubeadm_config_patches` → `kubeletExtraArgs`, which is where a managed node
group's launch template would put them. A node that registers untagged accepts
pods it should not for however long a reconciling controller takes to notice — a
small window that produces very confusing incidents.

**The label keys are EKS's real ones.** `eks.amazonaws.com/nodegroup`,
`node.kubernetes.io/instance-type`, `topology.kubernetes.io/zone`. The values are
fictional; the keys are not, so every `nodeSelector` and
`topologySpreadConstraint` you write here applies to EKS unchanged. See
[docs/eks-parity.md](../../docs/eks-parity.md).

**Fake AZs across two workers.** Enough for `topologySpreadConstraints` to
actually do something, which they cannot on a single-zone cluster — so you can
see a spread constraint succeed and fail rather than reading about it.

**`kind_cluster` cannot be modified in place.** Change a worker count and the
plan shows a full replacement. That is a fair model of an immutable node group,
and a good habit: node pool shape is a create/destroy decision, not an edit.

## Verify

```bash
../../scripts/verify-10-cluster.sh
```

Checks three nodes Ready, the `general` node group labelled, no GPU node group,
and that the zone labels are present.

## Things that go wrong

| Symptom | Cause |
|---|---|
| `node(s) already exist` | `kind delete cluster --name a2a-lab` first. |
| Nodes `NotReady` past 60s | Docker VM out of memory. Docker Desktop ▸ Settings ▸ Resources → 8GB+. |
| Apply hangs on `wait_for_ready` | Almost always memory. |
| Host port 8080 in use | Change `http_node_port` — note this replaces the cluster. |
| `terraform` can't find the `kind` provider | `terraform init` again; the provider is `tehcyx/kind`. |

→ [Lab 20: agents on Kubernetes](../20-agents-on-k8s/)
