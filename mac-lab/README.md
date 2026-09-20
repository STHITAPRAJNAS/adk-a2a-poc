# mac-lab — a Kubernetes platform for A2A agents, on a MacBook

The **macOS variant** of `k8s-lab`. Same path — from an empty laptop to a cluster
running the two A2A agents from this repository, with a service mesh underneath
and three different gateways in front, shaped throughout like an EKS cluster so
what you learn ports — but built on **Docker Desktop** instead of Windows/WSL2,
and **without the GPU node group**.

This folder is self-contained: it does not depend on `../k8s-lab`. Everything in
`labs/`, `charts/`, `images/` and `scripts/` runs from here.

**→ [RUNBOOK.md](RUNBOOK.md) is the step-by-step, start to finish.** The labs
below are the same path with the explanations attached.

The thread running through every lab is one question:

> **An A2A call from agent A to agent B. What does the platform do differently
> when both agents are in the cluster (east-west) versus when the caller is
> outside it (north-south)?**

Everything else — Helm, Terraform, node groups, Istio, Envoy, OPA — is
scaffolding for being able to answer that properly.

---

## What differs from the Windows lab

| | Windows lab (`k8s-lab`) | This Mac lab (`mac-lab`) |
|---|---|---|
| Host runtime | WSL2 + docker-ce | **Docker Desktop** |
| Arch | linux/amd64 | **linux/arm64** (Apple Silicon; `--platform amd64` on Intel) |
| Cluster | 4 nodes, 2 node groups | **3 nodes, 1 `general` node group** |
| GPU | real `nvidia.com/gpu` node + Ollama-on-GPU | **none** — lab 30 teaches the same scheduling on CPU nodes |
| inotify fix | host sysctl in WSL | **`docker exec` into the kind nodes** (start-cluster.sh does it) |
| Reboot recovery | start docker-ce via systemd | **`open -a Docker`** then start node containers |
| LLM | fake-LLM, or in-cluster Ollama on the GPU | **fake-LLM** (optional: Ollama *native on macOS* → Metal GPU) |

Everything else — the Helm chart, the agent image, Istio ambient (lab 40), Envoy
Gateway (lab 50), OPA (lab 55), agentgateway (lab 60), Agent Router (lab 70) — is
byte-for-byte the same, because it's all plain Kubernetes that doesn't care what
OS the host is.

---

## Read this before you start

**The Mac-specific parts have not been run on real hardware from here.** They
were adapted from the Windows lab (which was exercised through the mesh and
ingress phases) and pinned to versions checked on 2026-09-11, but this authoring
environment has no Docker or Kubernetes. Treat it as a well-researched plan.
Every lab ends with explicit verification commands precisely because you are the
one who finds out whether it works — when something doesn't, fix the file rather
than working around it.

**It is deliberately EKS-shaped.** Node labels use EKS's own keys
(`eks.amazonaws.com/nodegroup`, `node.kubernetes.io/instance-type`,
`topology.kubernetes.io/zone`), taints go on the way a managed node group's
launch template does, and ingress is Gateway API rather than `Ingress`. A
manifest written here applies to EKS unchanged. [docs/eks-parity.md](docs/eks-parity.md)
is the parity table, including where the local stand-in genuinely differs.

---

## The path

Each lab stands alone: its own README, its own files, its own verification. Run
them in order the first time — they build on each other's cluster state.

| | Lab | You learn | You end up with |
|---|---|---|---|
| 00 | [Prerequisites](labs/00-prereqs/) | What to install on macOS + Docker Desktop and why | A working container runtime and CLI set |
| 10 | [The cluster](labs/10-cluster/) | Terraform driving a multi-node cluster; EKS-shaped node groups | 3 nodes, 1 node group, fake AZs |
| 20 | [Agents on Kubernetes](labs/20-agents-on-k8s/) | Containerising the ADK agents; Helm chart authoring; probes and config | Both agents running, A2A working pod-to-pod |
| 30 | [Node groups](labs/30-node-groups/) | Taints, tolerations, affinity, extended resources, and why pods stay Pending — on CPU nodes | Scheduling lessons; agents pinned to the general pool |
| 40 | [Istio ambient](labs/40-istio-ambient/) | **East-west.** mTLS, workload identity, L4 vs L7 policy, waypoints | A2A between agents encrypted and authorised by identity |
| 50 | [North-south](labs/50-north-south/) | Gateway API, Envoy Gateway, ingress as a first-class resource | An agent reachable from the Mac, outside the mesh |
| 55 | [OPA authz](labs/55-opa-authz/) | Policy-as-code at the gateway *and* inside the agents' tool calls | Ingress ext_authz + OPA-gated tool execution |
| 60 | [agentgateway](labs/60-agentgateway/) | A gateway that understands A2A itself — not just HTTP | A2A ingress with per-agent policy and A2A-aware logs |
| 70 | [Agent Router](labs/70-agent-router/) | The *other* direction: governing the agents' own LLM egress (needs a Gemini key) | Gemini traffic routed, keyed and observable |

Supporting reading, useful at any point:

- [**East-west vs north-south, for A2A specifically**](docs/east-west-vs-north-south.md)
- [**Which gateway, when**](docs/gateway-decision-guide.md) — Istio, Envoy
  Gateway, Agent Router and agentgateway all sit in the path; this is the decision table.
- [**macOS + Docker Desktop setup**](docs/mac-docker-desktop.md) — the host setup, with a check at each step.
- [**Making it EKS-shaped**](docs/eks-parity.md) — the parity table.

---

## Quick start

```bash
cd ~/adk-a2a-poc/mac-lab
make doctor                # checks arch, Docker Desktop, kernel limits, ports
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
                     macOS host (Docker Desktop)
                          │
       ┌──────────────────┼──────────────────────┐
       │ NORTH-SOUTH      │                      │  lab 50 / 60
       ▼                  ▼                      ▼
  Envoy Gateway     agentgateway           (kubectl port-forward)
  plain HTTP        A2A-aware              the lazy way
   (+ OPA lab 55)         │
       │                  │
═══════╪══════════════════╪═══════════════ cluster boundary ═══════
       │                  │
       ▼                  ▼
  ┌─────────────────────────────────────────┐
  │  namespace: agents      (ambient mesh)  │   lab 40
  │                                         │
  │   ops_concierge  ──── A2A ────►  deployment_agent
  │   EAST-WEST: mTLS + authz by identity   │
  │        (+ OPA tool-call guard, lab 55)  │
  └─────────────────────────────────────────┘
  ┌─────────────────────────────────────────┐
  │  nodegroup: general  (2 CPU workers)    │   lab 30
  │  scheduling lessons via taint + fake    │
  │  extended resource — no GPU node        │
  └─────────────────────────────────────────┘
                          │
                   LLM egress (lab 70)
                   Agent Router → Gemini API (outside)
```

Three different boundaries, three different tools, and good reasons for each —
which is the actual lesson.
