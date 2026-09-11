# k8s-lab — a Kubernetes platform for A2A agents, built from scratch

A hands-on path from a bare Windows laptop with an NVIDIA GPU to a cluster
running the two A2A agents from this repository: two node groups including a
real GPU pool, a service mesh underneath, and three different gateways in front
— shaped throughout like an EKS cluster, so what you learn ports.

Runs entirely inside **WSL2**. Windows owns the GPU driver and Docker Desktop;
everything else is Linux.

**→ [RUNBOOK.md](RUNBOOK.md) is the step-by-step, start to finish.** The labs
below are the same path with the explanations attached.

The thread running through every lab is one question:

> **An A2A call from agent A to agent B. What does the platform do differently
> when both agents are in the cluster (east-west) versus when the caller is
> outside it (north-south)?**

Everything else — Helm, Terraform, node groups, Istio, Envoy — is scaffolding
for being able to answer that properly.

---

## Read this before you start

**Nothing in this lab has been run.** It was written against the upstream docs
and pinned to versions checked on 2026-09-11, but the authoring environment had
no Docker, no Kubernetes and no GPU. Treat it as a well-researched plan, not a
tested artifact. Every lab ends with explicit verification commands precisely
because you, not the author, are the one who will find out whether it works.
When something doesn't, that is a lab exercise, not a defect — and please fix
the file rather than working around it.

**The GPU is real, and it is the fiddliest part.** WSL2 does pass an NVIDIA GPU
through to Linux containers, so lab 30 schedules genuine `nvidia.com/gpu` and a
pod really runs `nvidia-smi`. But the device plugin has known rough edges on
WSL2, so lab 30 has a clearly marked gate with a **simulated fallback** that
teaches identical scheduling semantics. Take the fallback rather than losing a
day; the part that transfers — taints, tolerations, affinity, capacity, reading
why a pod is Pending — is the same on both paths.
[docs/windows-wsl2-gpu.md](docs/windows-wsl2-gpu.md) walks the four layers a GPU
has to survive, with a check at each.

**It is deliberately EKS-shaped.** Node labels use EKS's own keys
(`eks.amazonaws.com/nodegroup`, `node.kubernetes.io/instance-type`,
`topology.kubernetes.io/zone`), taints are applied at node registration the way a
managed node group's launch template does, and ingress is Gateway API rather than
`Ingress`. A manifest written here applies to EKS unchanged.
[docs/eks-parity.md](docs/eks-parity.md) is the parity table, including the four
places the local stand-in genuinely differs.

---

## The path

Each lab stands alone: its own README, its own files, its own verification. Run
them in order the first time — they build on each other's cluster state.

| | Lab | You learn | You end up with |
|---|---|---|---|
| 00 | [Prerequisites](labs/00-prereqs/) | What to install in WSL2 and why each choice | A working container runtime and CLI set |
| 10 | [The cluster](labs/10-cluster/) | Terraform driving a multi-node cluster; EKS-shaped node groups; GPU injection | 4 nodes, 2 node groups, 3 fake AZs, GPU in the right one |
| 20 | [Agents on Kubernetes](labs/20-agents-on-k8s/) | Containerising the ADK agents; Helm chart authoring; probes and config | Both agents running, A2A working pod-to-pod |
| 30 | [Node groups](labs/30-node-groups/) | The device plugin, taints, tolerations, affinity, and why pods stay Pending | `nvidia-smi` running in a pod; agents pinned off the GPU pool |
| 40 | [Istio ambient](labs/40-istio-ambient/) | **East-west.** mTLS, workload identity, L4 vs L7 policy, waypoints | A2A between agents encrypted and authorised by identity |
| 50 | [North-south](labs/50-north-south/) | Gateway API, Envoy Gateway, ingress as a first-class resource | An agent reachable from Windows, outside the mesh |
| 60 | [agentgateway](labs/60-agentgateway/) | A gateway that understands A2A itself — not just HTTP | A2A ingress with per-agent policy and A2A-aware logs |
| 70 | [Agent Router](labs/70-agent-router/) | The *other* direction: governing the agents' own LLM egress | Gemini traffic routed, keyed and observable at the platform layer |
| 90 | [EKS for real](labs/90-cloud-gpu/) *(optional, costs money)* | The same patterns against a managed cluster; autoscaling to zero | A cloud GPU node group that appears on demand |

Supporting reading, useful at any point:

- [**East-west vs north-south, for A2A specifically**](docs/east-west-vs-north-south.md)
  — what the terms mean, and what actually differs for an A2A task when the
  caller is outside the cluster.
- [**Which gateway, when**](docs/gateway-decision-guide.md) — Istio, Envoy
  Gateway, Agent Router and agentgateway all sit in the path. They are not
  alternatives to each other, mostly. This is the decision table.
- [**Windows + WSL2 + a real GPU**](docs/windows-wsl2-gpu.md) — the four layers
  a GPU has to survive, with a check at each, and the known failure modes.
- [**Making it EKS-shaped**](docs/eks-parity.md) — the parity table, and the four
  places a local cluster stops teaching you EKS.

---

## Quick start

```bash
cd ~/adk-a2a-poc/k8s-lab   # inside WSL, not /mnt/c — builds are far slower there
make doctor                # walks every layer and tells you which one is broken
cat RUNBOOK.md             # then follow it top to bottom
```

`make help` lists every target. Each lab also works standalone if you prefer
`terraform`/`helm`/`kubectl` directly — the Makefile is convenience, not a
framework, and every target prints the command it runs.

---

## What gets built

By the end of lab 70 the cluster looks like this. The two agents are the ones
from this repository's root — `ops_concierge` (front door) and
`deployment_agent` (specialist) — now as pods rather than processes.

```
                   Windows host (WSL2)
                          │
       ┌──────────────────┼──────────────────────┐
       │ NORTH-SOUTH      │                      │  lab 50 / 60
       ▼                  ▼                      ▼
  Envoy Gateway     agentgateway           (kubectl port-forward)
  plain HTTP        A2A-aware              the lazy way
       │                  │
═══════╪══════════════════╪═══════════════ cluster boundary ═══════
       │                  │
       ▼                  ▼
  ┌─────────────────────────────────────────┐
  │  namespace: agents      (ambient mesh)  │   lab 40
  │                                         │
  │   ops_concierge  ──── A2A ────►  deployment_agent
  │   nodegroup:      EAST-WEST      nodegroup:
  │   general          mTLS +        general
  │        │           authz by identity  │
  └────────┼─────────────────────────────┼──┘
  ┌─────────────────────────────────────────┐
  │  nodegroup: gpu-a10g   tainted          │   lab 30
  │  real nvidia.com/gpu, nothing drifts on │
  └─────────────────────────────────────────┘
           │                             │
           └──────── LLM egress ─────────┘         lab 70
                          │
                   Agent Router
                  (envoy-ai-gateway)
                          │
                          ▼
                   Gemini API (outside)
```

Three different boundaries, three different tools, and good reasons for each —
which is the actual lesson.
