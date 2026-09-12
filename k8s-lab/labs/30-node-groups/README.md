# Lab 30 — Node groups, with a real GPU

Lab 10 built the node groups. This lab makes the GPU **schedulable** and then
breaks scheduling in the three ways that matter.

## Pick your path

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig
kubectl get nodes -L eks.amazonaws.com/nodegroup
GPU_NODE=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=gpu-a10g -o name | cut -d/ -f2)
docker exec "$GPU_NODE" ls /dev/dxg && echo "→ real GPU path" || echo "→ simulated path"
```

**Real path** — continue below.
**Simulated path** — jump to [the fallback](#fallback-no-hardware), then rejoin
at *Scheduling: yes, no, and not yet*. The scheduling lessons are identical;
only `nvidia-smi` stops working.

## The three mechanisms

A node group is three separate things people tend to blur into one:

| | Does | Without it |
|---|---|---|
| **Label** | Lets a pod *choose* the pool | Nothing can target it |
| **Taint** | Stops everything else *landing* there | Batch jobs squat on your expensive nodes |
| **Extended resource** | Makes capacity *countable* | Ten pods "using" one GPU |

Lab 10 did the first two at node registration, the way an EKS node group's
launch template does. The third is what the device plugin is for.

## Install the device plugin

The plugin is a DaemonSet that finds GPUs and reports them to the kubelet every
few seconds, which is how `nvidia.com/gpu` appears in a node's allocatable
resources.

```bash
# containerd inside the node must know the nvidia runtime first
../../scripts/setup-gpu-node.sh

helm repo add nvdp https://nvidia.github.io/k8s-device-plugin && helm repo update
helm upgrade --install nvdp nvdp/nvidia-device-plugin \
  -n nvidia-device-plugin --create-namespace \
  --version 0.17.0 -f device-plugin-values.yaml

kubectl -n nvidia-device-plugin logs -l app.kubernetes.io/name=nvidia-device-plugin --tail=20
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
```

You want `1` against the GPU node. **Read the plugin values file** — two lines
there are the ones people get wrong:

- **the toleration.** The node group is tainted, so the plugin must tolerate its
  own taint. Forget it and you get the classic loop: the thing that advertises
  the resource cannot schedule onto the node that has it, so the resource never
  appears, so nothing schedules. The logs say nothing useful because the pod
  never started.
- **`deviceListStrategy: volume-mounts`**, matching how lab 10 injected the
  device. CDI mode is deliberately off — it needs NVML to reach `libdxcore.so`,
  which is exactly what breaks on WSL2.

### If the plugin says "No devices found. Waiting indefinitely."

That is the known WSL2 issue. Try once:

```bash
kubectl -n nvidia-device-plugin delete pod -l app.kubernetes.io/name=nvidia-device-plugin
```

Restarting sometimes fixes an ordering race with the runtime. If it persists,
**take the simulated path and move on.** This is a genuine upstream rough edge on
WSL2, not something you have misconfigured, and the rest of the lab does not
depend on it.

## Scheduling: yes, no, and not yet

```bash
kubectl apply -f gpu-workloads.yaml
kubectl -n scheduling-lab get pods -o wide
```

| Pod | Expected |
|---|---|
| `gpu-good` | `Running` on the GPU node |
| `gpu-no-toleration` | `Pending` — repelled by the taint |
| `gpu-too-greedy` | `Pending` — asks for 8 of 1 |

Real hardware, so this works:

```bash
kubectl -n scheduling-lab logs gpu-good
# your actual GPU, from inside a pod, on a node group you built
```

The two Pending pods look identical in `get pods`. They are not:

```bash
kubectl -n scheduling-lab describe pod gpu-no-toleration | tail -4
#   1 node(s) had untolerated taint {nvidia.com/gpu: present}, 3 node(s) didn't match nodeSelector

kubectl -n scheduling-lab describe pod gpu-too-greedy | tail -4
#   1 Insufficient nvidia.com/gpu, 3 node(s) didn't match nodeSelector
```

**Learn to read that line.** It names which predicate rejected which nodes, and
it answers almost every "why is my pod Pending" question you will ever be asked.

## A real LLM on the GPU (optional, but it's the payoff)

The scheduling demo proves the GPU is *schedulable*. This proves it *works*.
Ollama auto-detects the injected card, loads a model into VRAM, and serves it.

```bash
# GPUs are not shared — free the card the demo pod is holding first.
kubectl -n scheduling-lab delete pod gpu-good --ignore-not-found

kubectl apply -f llm-on-gpu.yaml
kubectl -n llm rollout status deploy/ollama      # first run pulls a ~3.7 GB image

kubectl -n llm exec deploy/ollama -- ollama pull llama3.2:1b
kubectl -n llm exec deploy/ollama -- ollama run llama3.2:1b "one sentence on GPUs"
kubectl -n llm exec deploy/ollama -- nvidia-smi
```

What tells you it worked:

- the logs say `library=CUDA ... name="NVIDIA GeForce RTX 3080"` — Ollama found
  the card, not the CPU fallback.
- `nvidia-smi` shows a `/llama-server` process with a **`C`** (Compute) context
  holding ~2–4 GB — the model resident in VRAM. The `G` line is just the display.
- the answer comes back in well under a second.

Same three lines put this pod on the GPU node as put `gpu-good` there:
nodeSelector + toleration + `nvidia.com/gpu: 1`. Once the plumbing works, every
GPU workload is that same pattern — that is the whole point of the node group.

Bigger models still fit the 10 GB card: `llama3.2:3b`, `qwen2.5:7b` (Q4 ~4.5 GB).
Point the agents at this in-cluster endpoint (`http://ollama.llm:11434`) to run
the A2A negotiation on real local inference instead of the scripted fake LLM.

## Pin the agents to the general pool

```bash
helm upgrade ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml -f ./agent-placement.yaml
helm upgrade deployment-agent ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-specialist.yaml -f ./agent-placement.yaml

kubectl -n agents get pods -o wide    # never on the GPU node
```

Note the required rule is `nvidia.com/gpu.present DoesNotExist`, not
`nodegroup In [general]`. A node group added next month is then eligible without
anyone remembering to edit this file — which on EKS, where node groups come and
go, matters more than it looks.

## Things worth breaking

Each takes a minute and teaches more than reading about it.

1. **Remove the toleration from the device plugin** and reinstall. Watch the
   resource vanish and every GPU pod go Pending. This is the failure you will
   hit for real on EKS the first time you taint a node group.
2. **Scale `gpu-good` to 2 replicas.** The second stays Pending even though the
   first is idle. **GPUs are not shared by default** — a pod holds the whole
   card. This surprises everyone used to CPU, and it is the entire reason
   time-slicing and MIG exist.
3. **Turn on time-slicing** (uncomment the block in `device-plugin-values.yaml`)
   and watch one GPU become four. The scheduler's view changes; the hardware does
   not, so the four pods genuinely contend. Now `nvidia-smi` inside two pods
   shows the same card.
4. **Delete the zone labels** from a node and re-roll the agents. The
   `topologySpreadConstraint` silently stops constraining. `ScheduleAnyway` means
   you get no error — which is why a spread constraint that does nothing is a
   common and invisible bug.
5. **Cordon the GPU node** (`kubectl cordon`) with a GPU pod running. It stays;
   only new pods are refused. Then `drain` it and watch the difference.

## Fallback: no hardware

Everything above minus the hardware. Same taints, same selectors, same Pending
pods, same `describe` output.

```bash
# advertise a fake resource, named so it can never be mistaken for the real one
../../scripts/advertise-gpu.sh "$GPU_NODE" 2

sed 's|nvidia.com/gpu: 1|lab.local/gpu: 1|; s|nvidia.com/gpu: 8|lab.local/gpu: 8|' \
  gpu-workloads.yaml | kubectl apply -f -
```

Two honest differences: the containers cannot compute, and the resource does not
survive a kubelet restart because nothing re-reports it. That second one is
precisely the difference between a patch and a device plugin, and worth noticing.

## What transfers to EKS

Almost everything, because lab 10 used EKS's own label keys.

| Here | EKS |
|---|---|
| `eks.amazonaws.com/nodegroup: gpu-a10g` | identical |
| `nvidia.com/gpu` | identical |
| taint applied at registration | applied by the node group |
| device plugin DaemonSet | identical, often via the GPU Operator |
| fixed node count | Karpenter provisions on Pending, scales to zero when idle |

That last row is the one big gap, and it inverts a habit: on a fixed cluster a
Pending pod is a bug; on an autoscaled one it is the normal first thirty seconds
of a pod's life. [docs/eks-parity.md](../../docs/eks-parity.md) has the rest.

→ [Lab 40: Istio ambient — east-west](../40-istio-ambient/)
