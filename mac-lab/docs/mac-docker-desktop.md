# macOS + Docker Desktop — host setup, layer by layer

The Windows lab has to walk four layers to get a GPU from the Windows driver into
a pod. The Mac lab has no GPU track, so its host setup is much shorter — but
Docker Desktop's Linux VM has two settings that will bite you if they're wrong,
so this walks each with a check.

Everything here is on the **Mac host**. There is no separate Linux shell to log
into (unlike WSL); `kubectl`, `terraform` and friends run in your normal Terminal
and talk to the cluster inside Docker Desktop's VM.

## Layer 1 — Docker Desktop

Install Docker Desktop for Mac and start it (the whale in the menu bar; wait for
"Docker Desktop is running"). On Apple Silicon it runs a `linux/arm64` VM.

Check:

```bash
docker info >/dev/null && echo "docker up"
docker run --rm alpine uname -m        # -> aarch64 on Apple Silicon
```

**Give the VM enough resources.** Docker Desktop ▸ Settings ▸ Resources:
- **Memory: 12 GB** (8 GB is the floor; three kind nodes + Istio + two gateways
  is not small). Too little shows up as nodes stuck `NotReady` with no clear
  reason — the kubelet evicts quietly.
- **CPUs: 4+**.

Check:

```bash
docker info --format 'CPUs={{.NCPU}}  MemGB={{printf "%.0f" (divf .MemTotal 1073741824.0)}}'
```

**Turn OFF Docker Desktop's built-in Kubernetes.** Settings ▸ Kubernetes ▸
uncheck "Enable Kubernetes". It's single-node and fights kind for ports and for
`KUBECONFIG`. Check:

```bash
kubectl config get-contexts 2>/dev/null | grep docker-desktop && echo "TURN IT OFF" || echo "good"
```

## Layer 2 — the CLIs (Homebrew)

```bash
brew install kind kubectl helm terraform istioctl jq
brew install k9s          # optional but you'll want it by lab 40
```

Check:

```bash
for t in kind kubectl helm terraform istioctl jq docker; do
  command -v "$t" >/dev/null && echo "  ✓ $t" || echo "  ✗ $t missing"
done
```

## Layer 3 — the VM's kernel limits (this is the one that bites)

Istio's CNI agent needs more inotify instances than Docker Desktop's VM ships by
default (often 128). Below the threshold it crash-loops with:

```
couldn't initialize inotify: too many open files
```

On Windows/WSL you'd set a host sysctl. On macOS there is **no host sysctl** for
the VM — the limit lives in Docker Desktop's LinuxKit kernel, which the kind
nodes share. You raise it **inside the kind nodes** (after the cluster exists):

```bash
for n in $(docker ps --filter name=a2a-lab -q); do
  docker exec "$n" sysctl -w fs.inotify.max_user_instances=8192
  docker exec "$n" sysctl -w fs.inotify.max_user_watches=524288
done
```

This resets when a node container restarts, so `scripts/start-cluster.sh`
reapplies it on every start, and `scripts/doctor.sh` checks it. You don't need to
run it by hand unless you skip those.

> Why not bake it into the kind config? kind's `kubeadmConfigPatches` can't set
> arbitrary sysctls on the node, and Docker Desktop exposes no per-VM sysctl
> knob, so the reliable place is a post-create `docker exec` — which is exactly
> what the scripts do.

## Layer 4 — host ports

kind maps container ports to the Mac host (Docker Desktop forwards them), so the
gateways answer at `localhost:8080/8081`. Make sure nothing else holds them:

```bash
for p in 8080 8081 8443; do
  lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && echo "  ! $p in use" || echo "  ✓ $p free"
done
```

If one is taken, either free it or change `http_node_port` / `agentgateway_node_port`
in `labs/10-cluster/variables.tf` (note: changing a port replaces the cluster).

## One command to check all of it

```bash
cd mac-lab && make doctor
```

It runs every check above and attributes any failure to the right layer.

## Optional — real local inference (Ollama on the Mac's GPU)

There's no GPU *node* in the cluster, but the Mac itself has a capable GPU that
Ollama uses natively via Metal — no Kubernetes involved. Run Ollama on the host
and point the in-cluster agents at it through `host.docker.internal`:

```bash
brew install ollama
ollama serve &
ollama pull llama3.2:1b

kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent \
  POC_FAKE_LLM=0 \
  OLLAMA_API_BASE=http://host.docker.internal:11434 \
  ORCHESTRATOR_MODEL=llama3.2:1b DEPLOYMENT_AGENT_MODEL=llama3.2:1b
```

`common/config.py:resolve_model` turns that into a LiteLLM `ollama_chat/` client —
the same code path the Windows lab uses for in-cluster Ollama, aimed at the host
instead. Lab 30 covers this too.
