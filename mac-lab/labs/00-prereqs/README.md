# Lab 00 — Prerequisites (macOS / Docker Desktop)

This is the **Mac variant** of the lab. Docker Desktop provides the Linux VM;
kind runs the cluster inside it; everything else is Homebrew CLIs. Around ten
minutes, mostly downloads. No GPU track — see the top-level README for what
differs from the Windows lab.

The full step-by-step with checks is
[docs/mac-docker-desktop.md](../../docs/mac-docker-desktop.md) — this page is the
*why* behind each choice.

## On the Mac

| | |
|---|---|
| **Docker Desktop** | Install and start it. On Apple Silicon it runs a `linux/arm64` VM — everything the lab uses is multi-arch, so nothing is emulated. Give it **≥ 8 GB RAM** (12 GB comfortable) and **≥ 4 CPUs** in Settings ▸ Resources. |
| **Homebrew** | The package manager for the CLIs below. |
| **CLIs** | `brew install kind kubectl helm terraform istioctl jq` |

Four kind nodes (well, three here) plus Istio plus two gateways is not a small
footprint. 4 GB will give you nodes stuck `NotReady` with no obvious reason — the
kubelet evicts quietly and the events scroll past.

| Tool | Why this one |
|---|---|
| **kind** | Each node is a container, so a multi-node cluster fits on one laptop. |
| **kubectl** | Non-negotiable. |
| **helm** | Lab 20 makes you author a chart, not only install someone else's. |
| **terraform** | Cluster lifecycle. OpenTofu is a drop-in; the HCL is unchanged. |
| **istioctl** | `ztunnel-config`, `proxy-config` and `analyze` are how you debug a mesh. |
| **jq** | The verification scripts need it. |
| **k9s** | Optional (`brew install k9s`), and you will want it by lab 40. |

## Two things that will cost you time if you skip them

**Do not enable Docker Desktop's built-in Kubernetes.** (Settings ▸ Kubernetes,
leave it *off*.) It is single-node and will compete with kind for ports and for
your `KUBECONFIG`. We want kind to own that entirely. `make doctor` warns you.

**Raise the VM's inotify limits before lab 40.** Docker Desktop's Linux VM often
ships `fs.inotify.max_user_instances=128`, which is too low for Istio's CNI — it
crash-loops with *"couldn't initialize inotify: too many open files"*. There's no
host sysctl to set on macOS; you raise it **inside the kind nodes** (they share
the VM kernel), and `scripts/start-cluster.sh` does this for you on every start:

```bash
for n in $(docker ps --filter name=a2a-lab -q); do
  docker exec "$n" sysctl -w fs.inotify.max_user_instances=8192
  docker exec "$n" sysctl -w fs.inotify.max_user_watches=524288
done
```

## Verify

```bash
cd mac-lab
make doctor
```

It checks the arch, the CLIs, Docker Desktop's resources, the VM's inotify
limits, and the host ports — so a failure is attributed to the right place rather
than surfacing three labs later as a confusing pod crash. Nothing may fail.

## What you do not need

- **No cloud account.** Labs 00–70 are entirely local.
- **No GPU.** This variant has no GPU node group; lab 30 teaches the same
  scheduling mechanics on CPU nodes.
- **No Gemini API key.** The agents run on `POC_FAKE_LLM=1` — the scripted model
  from the root repository — which for a platform lab is the right default and
  not merely a convenience: it removes the model as a variable, so when an A2A
  call fails between two pods you are debugging the network rather than wondering
  what the LLM decided this time. (Lab 30 shows how to point them at a real local
  Ollama on the Mac if you want inference.)

→ [Lab 10: the cluster](../10-cluster/)
