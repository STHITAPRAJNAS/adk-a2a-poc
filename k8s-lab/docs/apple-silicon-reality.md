# What a Mac Studio can and cannot do

Read this before lab 30, so the GPU simulation there teaches you the right
thing rather than a comfortable fiction.

## The short version

| You want | On a Mac Studio |
|---|---|
| Multi-node Kubernetes | ✅ Real. kind runs each node as a container inside one Linux VM. |
| Node pools, labels, taints, affinity | ✅ Real. Scheduling is scheduling; the scheduler does not care that the nodes are containers. |
| Istio, Envoy, agentgateway, all arm64 | ✅ Real. All publish arm64 images. |
| Pod-to-pod networking, mTLS, policy | ✅ Real. |
| Persistent volumes, ingress, HPA | ✅ Real enough to learn on. |
| **A pod using the Apple GPU** | ❌ **Not possible.** Not a config problem. |
| `nvidia.com/gpu` resources, CUDA, NVIDIA device plugin | ❌ No NVIDIA hardware exists. |
| Multi-node *across machines* | ❌ Not without more machines. |

## Why the GPU is genuinely off the table

Docker and Kubernetes on macOS are Linux. macOS cannot run Linux containers
natively, so every runtime — Docker Desktop, OrbStack, Colima, Rancher Desktop,
podman machine — starts a Linux VM and runs containers inside it. Your pods are
Linux processes in that VM.

The Apple GPU is reached through **Metal**, a macOS-only framework requiring
direct hardware access. There is no Metal driver inside the Linux VM and no
passthrough mechanism that exposes the GPU to it. So the chain breaks at the
first link: the VM cannot see the GPU, therefore the container cannot, therefore
the kubelet has nothing to advertise, therefore the scheduler has no GPU
resource to place a pod on.

This is not the same as "it is slow". It is absent.

### The two escape hatches, and why neither is in this lab

**krunkit / libkrun + Vulkan.** A newer VM driver can expose the Apple GPU to a
Linux guest as a Vulkan device. It is real and it works for some inference
stacks. It is not CUDA, not `nvidia.com/gpu`, and not wired into the Kubernetes
device-plugin ecosystem — so nothing you learn about GPU *scheduling* would
transfer. Worth your time as a separate rabbit hole; not worth confusing this
lab with.

**Run inference on the host, orchestrate from the cluster.** Keep the model
serving natively on macOS with Metal, and have pods call it as an external
service. This is the pragmatic answer if you want fast local inference *and* a
cluster. It teaches you nothing about GPU node groups, because there is no GPU
node.

## So what does lab 30 actually teach?

Everything about GPU node groups except the silicon.

The operational skill in "we have CPU and GPU node groups" is almost entirely
about placement and isolation:

- labelling nodes into pools, and selecting them with `nodeSelector` and
  `nodeAffinity`
- **tainting** the expensive pool so nothing lands there by accident, and
  writing the `tolerations` that let the right workloads through
- advertising a **custom extended resource** on a node, and watching the
  scheduler count it, reserve it, and leave pods `Pending` when it runs out
- reading `kubectl describe pod` and `kubectl get events` to work out *why* a
  pod is unscheduled — by far the most useful skill in the list
- `topologySpreadConstraints`, `PriorityClass`, and what preemption does to your
  cheap workloads when an expensive one arrives

Lab 30 does all of that with an extended resource called `lab.local/gpu`,
advertised by patching node status directly. Nothing pretends to be NVIDIA. The
name is deliberately not `nvidia.com/gpu` so you never mistake one for the other.

Lab 90 runs the same Terraform patterns against a real cloud GPU node group.
Swap `lab.local/gpu` for `nvidia.com/gpu`, add the device plugin, and the
manifests from lab 30 work unchanged — which is the point.

## Sizing

kind nodes are containers sharing the VM's resources, so "4 nodes" costs you
roughly what 4 processes cost, not 4 machines.

| Mac Studio RAM | Comfortable |
|---|---|
| 32 GB | The full lab. Give the VM 16 GB. |
| 64 GB+ | The full lab plus observability add-ons, room to be careless. |

Give the container VM **at least 8 GB and 4 CPUs**, more if you add the Istio
observability stack. On Docker Desktop that is Settings → Resources; on Colima
it is `colima start --cpu 6 --memory 16 --disk 100`.

Two things that will bite you on arm64:

- **Always check `--platform`.** Some charts still default to amd64-only images.
  They will run under emulation if at all, slowly, and fail confusingly. Every
  image this lab pins has a native arm64 build.
- **Build your agent images for arm64**, or kind will pull an amd64 image and
  the pod will crash-loop with `exec format error`. `images/build.sh` handles it.
