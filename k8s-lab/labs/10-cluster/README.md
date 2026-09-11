# Lab 10 — The cluster

A four-node cluster shaped like an EKS cluster with two managed node groups:
`general` (2 nodes, spread across three fake AZs) and `gpu-a10g` (1 node,
tainted, with your actual GPU injected).

## Before you start

Finish [docs/windows-wsl2-gpu.md](../../docs/windows-wsl2-gpu.md) through step 3
and confirm this prints your GPU:

```bash
docker run --rm -v /dev/null:/var/run/nvidia-container-devices/all ubuntu:24.04 nvidia-smi -L
```

If it does not, set `enable_gpu = false` below and take lab 30's simulated path.
Everything else in the lab is unaffected.

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
NAME                STATUS  NODEGROUP  INSTANCE-TYPE  ZONE
a2a-lab-control-plane  Ready
a2a-lab-worker         Ready   general    m6i.large      eu-west-1a
a2a-lab-worker2        Ready   general    m6i.large      eu-west-1b
a2a-lab-worker3        Ready   gpu-a10g   g5.xlarge      eu-west-1a
```

To build without GPU injection:

```bash
terraform apply -var enable_gpu=false
```

## Then: the node's container runtime

Injecting the GPU device into the node container is only half of it. The node
runs **its own containerd**, which does not yet know about the NVIDIA runtime —
so the device is present on the node but no pod can be given it.

```bash
../../scripts/setup-gpu-node.sh
```

That configures containerd inside the GPU node and restarts it. Lab 30 installs
the device plugin on top, which is what finally makes `nvidia.com/gpu`
schedulable.

## What to notice

**Labels and the taint arrive with the node, not after it.** They are set
through `kubeadm_config_patches` → `kubeletExtraArgs`, which is where a managed
node group's launch template would put them. A node that registers untainted
accepts GPU-pool pods for however long a reconciling controller takes to notice —
a small window that produces very confusing incidents.

**The label keys are EKS's real ones.** `eks.amazonaws.com/nodegroup`,
`node.kubernetes.io/instance-type`, `topology.kubernetes.io/zone`. The values are
fictional; the keys are not, so every `nodeSelector` and
`topologySpreadConstraint` you write here applies to EKS unchanged. See
[docs/eks-parity.md](../../docs/eks-parity.md).

**Three fake AZs across two workers.** Enough for `topologySpreadConstraints` to
actually do something, which they cannot on a single-zone cluster — so you can
see a spread constraint succeed and fail rather than reading about it.

**One GPU node, and the validation enforces it.** Every kind node is a container
on one host. Two "GPU nodes" would both be injected with the same physical card
and the scheduler would believe it has two of something there is one of — a
worse lie than the simulated path, because it only surfaces under load. If you
have several physical GPUs, [nvkind](https://github.com/NVIDIA/nvkind) does this
properly.

**`kind_cluster` cannot be modified in place.** Change a worker count and the
plan shows a full replacement. That is a fair model of an immutable node group,
and a good habit: node pool shape is a create/destroy decision, not an edit.

## Verify

```bash
../../scripts/verify-10-cluster.sh
```

Checks four nodes Ready, both node groups labelled, the GPU taint present, and —
if `enable_gpu` was on — that `/dev/dxg` made it into the GPU node.

## Things that go wrong

| Symptom | Cause |
|---|---|
| `node(s) already exist` | `kind delete cluster --name a2a-lab` first. |
| Nodes `NotReady` past 60s | VM out of memory. Docker Desktop → Resources → 8GB+. |
| GPU node has no `/dev/dxg` | The volume-mount flag is not set. Re-check step 3 of the WSL2 doc. |
| Apply hangs on `wait_for_ready` | Almost always memory. |
| Host port 8080 in use | Change `http_node_port` — note this replaces the cluster. |
| `nvidia-smi` works in WSL but not in the node | containerd inside the node is not configured. Run `setup-gpu-node.sh`. |

→ [Lab 20: agents on Kubernetes](../20-agents-on-k8s/)
