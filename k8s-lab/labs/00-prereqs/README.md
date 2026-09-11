# Lab 00 — Prerequisites

Get your Mac ready. Twenty minutes, mostly downloads.

## What you need and why each choice

```bash
brew install kind kubectl helm terraform istioctl k9s jq yq
```

| Tool | Why this one |
|---|---|
| **kind** | Runs each Kubernetes node as a container. Multiple nodes on one machine is exactly what we need for node groups, and it is the reference tool the Kubernetes project itself tests with. |
| **kubectl** | Non-negotiable. |
| **helm** | Lab 20 makes you author a chart rather than only install someone else's. |
| **terraform** | Cluster lifecycle. OpenTofu works identically if you prefer it — swap the binary, the HCL is unchanged. |
| **istioctl** | `istioctl` gives you `ztunnel-config`, `proxy-config` and `analyze`, which are how you debug a mesh. |
| **k9s** | Optional, but you will spend a lot of time in `kubectl get pods -w` otherwise. |
| **jq / yq** | The verification scripts use them. |

## A container runtime

kind needs Docker-compatible container runtime. Pick one:

| | Notes |
|---|---|
| **Docker Desktop** | Easiest. Settings → Resources → give it **8 GB RAM, 4 CPUs** minimum. Licence terms apply for larger companies. |
| **OrbStack** | Noticeably faster and lighter on Apple Silicon. Paid for commercial use. Drop-in for kind. |
| **Colima** | Free, CLI-driven: `colima start --cpu 6 --memory 16 --disk 100`. What I would pick for a lab machine. |
| **Rancher Desktop** | Free, has its own Kubernetes you should turn off — we want kind to own that. |

Any of them works. **Do not** enable the runtime's own built-in Kubernetes; it
is single-node and will fight kind for ports and for your `KUBECONFIG`.

## Verify

```bash
cd k8s-lab
make doctor
```

That checks versions, confirms the container runtime is up and arm64, and warns
if the VM is under-resourced. Fix anything it flags before lab 10 — every
failure it catches is one that would otherwise surface as a confusing pod crash
three labs later.

Manual equivalent, if you would rather see it yourself:

```bash
docker info --format '{{.Architecture}} {{.NCPU}}cpu {{.MemTotal}}bytes'
kind version && kubectl version --client && helm version --short && terraform version
```

Expect `aarch64` or `arm64` for the architecture. If you see `x86_64`, you are
running something under Rosetta and every image pull in this lab will be slower
and some will fail — sort that out first.

## Optional: the local registry

Lab 20 builds agent images. You can either load them straight into kind
(`kind load docker-image`, simple, slow-ish) or run a local registry (faster on
rebuild, and closer to how a real cluster pulls). `make registry-up` starts one
on `localhost:5001`; lab 20 explains the tradeoff and works either way.

## What you do not need

- **No cloud account.** Labs 00–70 are entirely local. Only the optional lab 90
  touches a cloud, and it warns you about cost first.
- **No Gemini API key** until lab 70. Labs 20–60 run the agents with
  `POC_FAKE_LLM=1` — the scripted model from the root repository — which is
  better for a platform lab anyway: deterministic, instant, free, and it removes
  the model as a variable when you are debugging networking.

→ [Lab 10: the cluster](../10-cluster/)
