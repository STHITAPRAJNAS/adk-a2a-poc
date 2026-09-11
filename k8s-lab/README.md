# k8s-lab — a Kubernetes platform for A2A agents, built from scratch on a Mac Studio

A hands-on path from an empty Mac to a cluster running the two A2A agents from
this repository, with a service mesh underneath them and three different
gateways in front of them — so you can see, concretely, what changes when an
agent call crosses the cluster boundary instead of staying inside it.

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
no Docker, no Kubernetes and no Mac. Treat it as a well-researched plan, not a
tested artifact. Every lab ends with explicit verification commands precisely
because you, not the author, are the one who will find out whether it works.
When something doesn't, that is a lab exercise, not a defect — and please fix
the file rather than working around it.

**Your Mac Studio cannot do real GPU workloads in Kubernetes.** This is not a
configuration problem you can solve. Containers on macOS run inside a Linux VM,
and that VM has no path to the Apple GPU — there is no Metal passthrough, no
CUDA, and no `nvidia.com/gpu` device to schedule against. Lab 30 therefore
teaches GPU *node groups* — the taints, tolerations, affinity rules, extended
resources and scheduling behaviour, which is the part you actually operate —
using simulated GPU capacity, and lab 90 shows the same Terraform against a real
cloud GPU node group when you want to see hardware. [The full explanation is
here](docs/apple-silicon-reality.md); read it before lab 30 so the simulation
doesn't mislead you.

---

## The path

Each lab stands alone: its own README, its own files, its own verification. Run
them in order the first time — they build on each other's cluster state.

| | Lab | You learn | You end up with |
|---|---|---|---|
| 00 | [Prerequisites](labs/00-prereqs/) | What to install on macOS and why each choice | A working container runtime and CLI set |
| 10 | [The cluster](labs/10-cluster/) | Terraform driving a local multi-node cluster; providers and dependency ordering | A 4-node kind cluster with two labelled pools |
| 20 | [Agents on Kubernetes](labs/20-agents-on-k8s/) | Containerising the ADK agents; Helm chart authoring; probes and config | Both agents running, A2A working pod-to-pod |
| 30 | [Node groups](labs/30-node-groups/) | Taints, tolerations, affinity, extended resources, and why pods stay Pending | Agents pinned to CPU nodes, a GPU workload pinned to GPU nodes |
| 40 | [Istio ambient](labs/40-istio-ambient/) | **East-west.** mTLS, workload identity, L4 vs L7 policy, waypoints | A2A between agents encrypted and authorised by identity |
| 50 | [North-south](labs/50-north-south/) | Gateway API, Envoy Gateway, ingress as a first-class resource | An agent reachable from your Mac, outside the mesh |
| 60 | [agentgateway](labs/60-agentgateway/) | A gateway that understands A2A itself — not just HTTP | A2A ingress with per-agent policy and A2A-aware logs |
| 70 | [Agent Router](labs/70-agent-router/) | The *other* direction: governing the agents' own LLM egress | Gemini traffic routed, keyed and observable at the platform layer |
| 90 | [Real GPUs](labs/90-cloud-gpu/) *(optional, costs money)* | The same Terraform against a cloud GPU node group | A real `nvidia.com/gpu` node you can schedule on |

Supporting reading, useful at any point:

- [**East-west vs north-south, for A2A specifically**](docs/east-west-vs-north-south.md)
  — what the terms mean, and what actually differs for an A2A task when the
  caller is outside the cluster.
- [**Which gateway, when**](docs/gateway-decision-guide.md) — Istio, Envoy
  Gateway, Agent Router and agentgateway all sit in the path. They are not
  alternatives to each other, mostly. This is the decision table.
- [**Apple Silicon reality**](docs/apple-silicon-reality.md) — what genuinely
  works on this hardware, what is simulated, and what needs a cloud.

---

## Quick start

```bash
cd k8s-lab
make versions          # what is pinned vs what is current upstream
make doctor            # check your Mac has what the labs need
cd labs/00-prereqs && cat README.md
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
                    your Mac (host)
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
  │   (cpu pool)      EAST-WEST      (cpu pool)
  │        │           mTLS +             │
  │        │           authz by identity  │
  └────────┼─────────────────────────────┼──┘
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
