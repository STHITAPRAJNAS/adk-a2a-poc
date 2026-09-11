# Lab 00 — Prerequisites

Windows owns the GPU driver and Docker Desktop. Everything else happens inside
WSL2. Around twenty minutes, mostly downloads.

The full step-by-step with checks at each layer is
[docs/windows-wsl2-gpu.md](../../docs/windows-wsl2-gpu.md) — this page is the
why behind each choice.

## On Windows

| | |
|---|---|
| **WSL2 + Ubuntu 24.04** | `wsl --install -d Ubuntu-24.04`. All labs run here. |
| **NVIDIA driver** | Game Ready or Studio, from nvidia.com. Includes WSL support. **Never install a driver inside WSL** — it will shadow the paravirtualised one and break GPU access. |
| **Docker Desktop** | WSL2 backend on, integration enabled for your distro, Resources set to **8+ GB / 4+ CPUs**. |

Four kind nodes plus Istio plus two gateways is not a small footprint. 4 GB will
give you nodes stuck `NotReady` and no obvious reason why.

## Inside WSL

```bash
sudo apt-get install -y jq
```

| Tool | Why this one |
|---|---|
| **kind** | Each node is a container, so a multi-node cluster fits on one laptop — and `extraMounts` is what lets exactly one node have the GPU. That is the whole GPU node group trick. |
| **kubectl** | Non-negotiable. |
| **helm** | Lab 20 makes you author a chart, not only install someone else's. |
| **terraform** | Cluster lifecycle. OpenTofu is a drop-in; the HCL is unchanged. |
| **nvidia-container-toolkit** | Injects the GPU into containers. Two config flags in it decide whether lab 30 is real or simulated. |
| **istioctl** | `ztunnel-config`, `proxy-config` and `analyze` are how you debug a mesh. |
| **jq** | The verification scripts need it. |
| **k9s** | Optional, and you will want it by lab 30. |

Install commands are in [the runbook, phase 0](../../RUNBOOK.md#phase-0--the-machine---20-min).

## Two things that will cost you time if you skip them

**Keep the repo in the WSL filesystem.** `~/adk-a2a-poc`, not
`/mnt/c/Users/...`. Filesystem calls across the Windows boundary are an order of
magnitude slower, and Docker builds and Terraform both make a great many of them.
`make doctor` warns you about this.

**Do not enable Docker Desktop's built-in Kubernetes.** It is single-node and
will compete with kind for ports and for your `KUBECONFIG`. We want kind to own
that entirely.

## Verify

```bash
cd k8s-lab
make doctor
```

It walks the whole chain — tools, runtime resources, then the GPU layer by layer
— so a failure is attributed to the right place rather than surfacing three labs
later as a confusing pod crash.

The **GPU lines are allowed to fail.** If they do, lab 10 takes
`-var enable_gpu=false` and lab 30 takes its simulated path; everything else is
identical. Nothing else may fail.

## What you do not need

- **No cloud account.** Labs 00–70 are entirely local. Only lab 90 touches one,
  and it warns about cost first.
- **No Gemini API key** until lab 70. The agents run on `POC_FAKE_LLM=1` — the
  scripted model from the root repository — which for a platform lab is the right
  default and not merely a convenience: it removes the model as a variable, so
  when an A2A call fails between two pods you are debugging the network rather
  than wondering what the LLM decided this time.

→ [Lab 10: the cluster](../10-cluster/)
