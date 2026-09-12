# Runbook — zero to a working cluster, end to end

Every command, in order, with a gate after each phase. Run it all in one sitting
(about 90 minutes, most of it waiting on pulls) or stop at any gate and come back.

**Where you type these:** a WSL2 Ubuntu shell, with the repo cloned inside the
WSL filesystem (`~/adk-a2a-poc`), not on `/mnt/c/`. Windows' only jobs are the
NVIDIA driver and Docker Desktop.

If a gate fails, the phase's own lab README has a "things that go wrong" table.
Do not push past a failed gate — every layer here assumes the one below it.

---

## Phase 0 — the machine  ·  ~30 min

Full detail, and the troubleshooting you will probably need at least once:
[docs/windows-wsl2-gpu.md](docs/windows-wsl2-gpu.md).

**New to WSL?** The 30-second version: you will use two kinds of terminal.
`PS C:\Users\you>` is **PowerShell (Windows)** — run `wsl` commands there.
`you@MACHINE:...$` is **Ubuntu (Linux)** — run everything else there. A `wsl`
command inside Ubuntu says "command not found"; that just means wrong window.
Linux never shows password characters as you type — that is normal.

### 0a — Install WSL + Ubuntu

PowerShell **as Administrator**:

```powershell
wsl --install -d Ubuntu-24.04
```

**Reboot when it tells you to.** After the reboot a terminal opens on its own and
asks you to create a Linux username and password (the password is invisible as
you type — type it, Enter, retype). You land at a green `you@MACHINE:~$` prompt:
that is Linux, and you are through the hardest conceptual bit.

Install the current **NVIDIA Game Ready or Studio driver** on Windows from
nvidia.com. **Never install a GPU driver inside WSL.**

### 0b — Docker Engine in WSL (not Docker Desktop)

Use **Docker Engine installed natively inside Ubuntu**, not Docker Desktop. The
reason is the GPU: `nvidia-ctk` (step 0e) configures the daemon's runtime by
editing files in Ubuntu, and only a WSL-native daemon reads them. Docker
Desktop's daemon runs in its own hidden VM you can't configure that way, so the
GPU-into-kind trick in Phase 3 can't reach it.

First enable systemd so Docker runs as a service (and keep the DNS setting in the
same file — `tee` overwrites, so write both sections at once):

```bash
sudo tee /etc/wsl.conf > /dev/null <<'EOF'
[boot]
systemd=true

[network]
generateResolvConf=false
EOF
```
`wsl --shutdown` in PowerShell, reopen, then confirm `systemctl is-system-running`
reports `running` or `degraded` (both fine).

Install Docker Engine from Docker's official repo (not Ubuntu's `docker.io`):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker
sudo systemctl enable --now docker
docker run hello-world       # gate: "Hello from Docker!"
```

`.wslconfig` for memory/CPU sizing is *optional* (WSL defaults to a sensible
share of RAM) and has a trap: Notepad saves it as `.wslconfig.txt`. If you want
it, write it from inside Ubuntu: `printf '[wsl2]\nmemory=12GB\n' >
/mnt/c/Users/<you>/.wslconfig`, then `wsl --shutdown`.

### 0c — ⚠️ Networking sanity check — BEFORE any `apt` or `curl`

Nothing below works without outbound internet from Ubuntu, and WSL networking is
the single most common thing to break. Test it first — in Ubuntu:

```bash
ping -4 -c 3 8.8.8.8 && getent hosts archive.ubuntu.com
```

**Both must succeed** (replies, then an IP for the hostname).

> **If either fails, STOP and fix it before going on.** The overwhelmingly
> common cause is a **VPN client — NordVPN, ExpressVPN, OpenVPN — even one you
> never logged into.** Their filter drivers block WSL's network at boot. Quit it
> completely from the Windows system tray (right-click → Quit, not just
> "disconnect"), turn off its kill switch and launch-at-startup, then
> `wsl --shutdown` and retest. Full diagnosis for every symptom is in
> [docs/windows-wsl2-gpu.md#wsl-networking-troubleshooting](docs/windows-wsl2-gpu.md#wsl-networking-troubleshooting)
> — DNS fixes, IPv4 forcing, Ethernet→WiFi, wedged services. Do not proceed on a
> half-working network; every later step will fail confusingly.

### How to read the install commands below

Ubuntu installs software with `apt`, which only trusts **repositories** it knows
about, and only accepts packages signed by a **key** it holds. Docker, NVIDIA,
HashiCorp and Istio aren't in Ubuntu's default repositories (or they ship newer
versions there), so for each one you do the **same four-step dance** — once you
recognise it, every block below reads the same:

1. **Fetch the vendor's signing key** — `curl <key-url> | sudo gpg --dearmor -o
   /usr/share/keyrings/<name>.gpg`. `--dearmor` converts the key from text to the
   binary form apt expects. This key is how apt later proves a package genuinely
   came from that vendor and wasn't tampered with in transit.
2. **Register the repository** — `echo "deb [signed-by=<the key>] <repo-url> …" |
   sudo tee /etc/apt/sources.list.d/<name>.list`. This tells apt *where* to fetch
   that vendor's packages and *which key* must have signed them. `signed-by=`
   ties the repo to the key from step 1.
3. **Refresh** — `sudo apt update` re-reads all repo package lists, now including
   the new one.
4. **Install** — `sudo apt install -y <package>`.

`sudo tee <file>` just means "write this text to a file that needs root"; it's
used instead of `>` because `>` can't write to a root-owned location under sudo.

### 0d — Update Ubuntu and base packages

```bash
sudo apt update && sudo apt upgrade -y   # refresh package lists, then upgrade everything installed
# tools the later steps rely on: curl/wget download, gnupg handles keys,
# ca-certificates lets HTTPS be verified, lsb-release reports your Ubuntu codename
sudo apt install -y curl wget git jq ca-certificates gnupg lsb-release apt-transport-https
```

### 0e — NVIDIA Container Toolkit (lets containers use the GPU)

```bash
# step 1 — fetch NVIDIA's signing key (see "the four-step dance" above)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
# step 2 — register NVIDIA's repo, rewriting its lines to reference that key
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
# steps 3 + 4 — refresh and install
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit

# the two settings that make a GPU node group possible:
# (a) register NVIDIA's runtime in /etc/docker/daemon.json and make it Docker's default,
#     so any container can be given the GPU
sudo nvidia-ctk runtime configure --runtime=docker --set-as-default
# (b) tell that runtime to treat a mount under /var/run/nvidia-container-devices/
#     as "inject this GPU" — the trick kind uses to give the GPU to ONE node in Phase 3
sudo nvidia-ctk config --set accept-nvidia-visible-devices-as-volume-mounts=true --in-place

# apply the daemon.json change
sudo systemctl restart docker
```

Verify the GPU reaches a container (this is the real proof the stack works):

```bash
docker run --rm --gpus all nvidia/cuda:12.6.2-base-ubuntu24.04 nvidia-smi   # should print your GPU
docker run --rm -v /dev/null:/var/run/nvidia-container-devices/all ubuntu:24.04 nvidia-smi -L  # the kind injection mechanism
```

### 0f — CLI tools

Run in order; if any one errors, stop and fix that one. These are downloaded as
single binaries (kubectl, kind) or via a script (helm) rather than apt, except
terraform which uses the four-step repo dance.

```bash
# kubectl — download the latest stable release binary, then place it in your PATH.
# `install -o root -g root -m 0755` copies it owned by root and executable (0755).
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl

# kind — download the release binary, make it executable (chmod +x), move into PATH
curl -Lo ./kind "https://github.com/kubernetes-sigs/kind/releases/latest/download/kind-linux-amd64"
chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind

# helm — run its official installer script (the pipe-to-bash the maintainers publish)
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# terraform — the four-step repo dance: key, repo, refresh, install
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install -y terraform

# istioctl — its installer downloads Istio into ~/istio-*, then we move the binary into PATH
cd ~ && curl -L https://istio.io/downloadIstio | sh - && sudo mv istio-*/bin/istioctl /usr/local/bin/
```

### ▸ Gate 0

```bash
cd ~/adk-a2a-poc/k8s-lab      # clone it first if you have not:
                              #   git clone https://github.com/STHITAPRAJNAS/adk-a2a-poc.git ~/adk-a2a-poc
                              #   (cd ~/adk-a2a-poc && git checkout claude/k8s-a2a-lab)
make doctor
```

Every line green **except** the GPU lines, which are allowed to fail — if they
do, you take the simulated path in phase 3 and everything else is unaffected.
A red *networking* or *tools* line, though, means go back and finish this phase.

---

## Phase 1 — the cluster  ·  ~5 min

```bash
cd labs/10-cluster
terraform init
terraform apply          # add -var enable_gpu=false if gate 0's GPU lines failed

export KUBECONFIG=$PWD/kubeconfig
echo "export KUBECONFIG=$PWD/kubeconfig" >> ~/.bashrc   # save yourself the repetition
```

### ▸ Gate 1

```bash
kubectl get nodes -L eks.amazonaws.com/nodegroup,node.kubernetes.io/instance-type,topology.kubernetes.io/zone
../../scripts/verify-10-cluster.sh
```

Four nodes Ready, two node groups, three zones represented, the GPU node tainted
at registration. → [lab 10](labs/10-cluster/)

---

## Phase 2 — the agents  ·  ~10 min

**Two agents, not three.** The file names use a role word that can read like a
third agent — it isn't:

| Agent (its real name) | Role | Also called | Helm release | Values file |
|---|---|---|---|---|
| `ops_concierge` | front door — takes the request, delegates over A2A | "concierge" | `ops-concierge` | `values-concierge.yaml` |
| `deployment_agent` | worker — readiness, approvals, deploys | "the specialist" | `deployment-agent` | `values-specialist.yaml` |

The concierge never does the work; it delegates over A2A to the deployment
agent, which parks at `input-required` on the human-approval gate. That parked
state surviving the cluster network hop is what Gate 2 proves.

```bash
cd ../..
./images/build.sh                                   # builds for amd64 on Windows

helm upgrade --install deployment-agent ./charts/adk-agent -n agents --create-namespace \
  -f ./charts/adk-agent/values-specialist.yaml --wait
helm upgrade --install ops-concierge ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-concierge.yaml --wait
```

### ▸ Gate 2

```bash
./scripts/verify-20-agents.sh
```

Both Deployments ready, the peer agent card mounted as a **file**, and one A2A
negotiation reaching `input-required`. That last one means two pods completed an
A2A hop across the cluster network and the human-approval gate survived it.

Before moving on, spend ten minutes on [lab 20](labs/20-agents-on-k8s/)'s
deliberate failure — it is the most useful thing in the whole runbook and it
explains why that card is a file and not a URL.

---

## Phase 3 — GPU node group  ·  ~15 min

```bash
GPU_NODE=$(kubectl get nodes -l eks.amazonaws.com/nodegroup=gpu-a10g -o name | cut -d/ -f2)
./scripts/setup-gpu-node.sh "$GPU_NODE"

helm repo add nvdp https://nvidia.github.io/k8s-device-plugin && helm repo update
helm upgrade --install nvdp nvdp/nvidia-device-plugin \
  -n nvidia-device-plugin --create-namespace \
  --version 0.17.0 -f labs/30-node-groups/device-plugin-values.yaml

kubectl apply -f labs/30-node-groups/gpu-workloads.yaml
```

### ▸ Gate 3

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
kubectl -n scheduling-lab get pods
kubectl -n scheduling-lab logs gpu-good     # your actual GPU, from inside a pod
```

One `Running`, two `Pending` — and the two Pending pods are Pending for
**different reasons**. Read both `describe` outputs; that is the lab.

```bash
kubectl -n scheduling-lab describe pod gpu-no-toleration | tail -4
#   …2 node(s) didn't match node affinity/selector, 2 node(s) had untolerated taint(s)
#   the GPU node is in the TAINT bucket — the pod reached it, then bounced. Structural.
kubectl -n scheduling-lab describe pod gpu-too-greedy | tail -4
#   …1 Insufficient nvidia.com/gpu, 1 untolerated taint, 2 didn't match selector
#   the GPU node is in the RESOURCE bucket — it passed taint+selector, failed on count. Arithmetic.
```

Same node, two different walls, depending on how far the pod's spec let it walk.
Learning to read `X didn't match selector / Y untolerated taint / Z Insufficient
<resource>` diagnoses most "why is my pod Pending" on sight.

**Two things that will trip you here:**

- `nvidia.com/gpu` shows `<none>` **right after** the helm install. That is a
  timing race, not a failure — the kubelet needs a few seconds to pick up the
  newly-registered plugin. `sleep 10` and re-check before assuming WSL2 trouble.
- `device-plugin-values.yaml` is a **Helm values file** — pass it with `helm -f`,
  never `kubectl apply` it (it has no `kind:`, so kubectl errors on it). Only
  `gpu-workloads.yaml` (which has `kind:`) is `kubectl apply`d. Rule: `*-values.yaml`
  → Helm; a file with `kind:` at the top → kubectl.

If the device plugin genuinely will not find devices after that `sleep`, it is
the known WSL2 issue: take the simulated path in
[lab 30](labs/30-node-groups/#fallback-no-hardware) and carry on. Do not lose a
day here.

Then pin the agents off the GPU pool:

```bash
helm upgrade ops-concierge ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-concierge.yaml -f labs/30-node-groups/agent-placement.yaml
helm upgrade deployment-agent ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-specialist.yaml -f labs/30-node-groups/agent-placement.yaml
```

---

## Phase 3½ — real GPU inference: Ollama, agents, chat UI  ·  ~20 min

Optional, but it is the payoff: a real LLM on the GPU node, the two agents
running on it instead of the scripted model, and a browser chat UI. All
manifests live in `labs/30-node-groups/`.

**1. Serve a model on the GPU.** `gpu-good` from Phase 3 holds the only card;
GPUs are not shared, so free it first.

```bash
kubectl -n scheduling-lab delete pod gpu-good --ignore-not-found
kubectl apply -f labs/30-node-groups/llm-on-gpu.yaml
kubectl -n llm rollout status deploy/ollama            # first pull is a ~3.7 GB image
kubectl -n llm exec deploy/ollama -- ollama pull qwen2.5:7b   # tool-capable, ~4.7 GB
kubectl -n llm exec deploy/ollama -- nvidia-smi        # /llama-server holding VRAM = working
```

**2. Point the agents at it.** The image needs `google-adk[extensions]` (bundles
LiteLLM) — already in the Dockerfile — so rebuild, then roll with the Ollama
overlay layered after base + placement.

```bash
./images/build.sh                                       # rebuild + kind load
cd labs/30-node-groups
helm upgrade ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml -f ./agent-placement.yaml -f ./agent-ollama.yaml
helm upgrade deployment-agent ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-specialist.yaml -f ./agent-placement.yaml -f ./agent-ollama.yaml
kubectl -n agents rollout restart deploy/ops-concierge deploy/deployment-agent
cd ../..
```

`resolve_model` (common/config.py) switches to LiteLLM whenever `OLLAMA_API_BASE`
is set; the overlay sets it to `http://ollama.llm:11434` and turns off
`POC_FAKE_LLM`. Both the Gemini and fake paths are unchanged when it is unset.

**3. Chat UI + Dev UIs from Windows.** Each `port-forward` blocks — own terminal,
`KUBECONFIG` exported, leave running. `localhost` forwards from Windows into WSL2.

```bash
kubectl -n llm     port-forward svc/open-webui     3000:8080   # http://localhost:3000
kubectl -n agents  port-forward svc/ops-concierge  8000:8000   # /dev-ui?app=ops_concierge
kubectl -n agents  port-forward svc/deployment-agent 8001:8001 # /dev-ui?app=deployment_agent
```
(Open WebUI: `kubectl apply -f labs/30-node-groups/open-webui.yaml` first; it needs
`3Gi` — `1Gi` OOM-loops on startup.)

### ▸ Gate 3½

- Open WebUI (`localhost:3000`) answers, and `nvidia-smi` shows GPU-Util spike.
- In the concierge Dev UI, `deploy checkout-api 2.14.0 to production` **pauses at
  the approval gate**; typing `approved` resumes it to completion. That is HITL:
  the Dev UI submits your reply as the **function response** for the pending
  long-running call, routed across the A2A hop onto the same task (needs
  `ResumabilityConfig(is_resumable=True)` — it is on). `staging` instead of
  `production` runs straight through with no gate.

**Common trip-ups (all hit during the real run):**

- `port-forward` fails with *connection refused inside the pod* → the app has not
  finished booting (or crash-looped). Wait for `rollout status` / the "Uvicorn
  running" log line first. It is the pod, not your networking.
- `kubectl` → `localhost:8080 ... EOF` in a fresh shell → `KUBECONFIG` is not set.
  `export KUBECONFIG=~/adk-a2a-poc/k8s-lab/labs/10-cluster/kubeconfig` (add it to
  `~/.bashrc`).
- `pip install` → `externally-managed-environment` → use a venv, not
  `--break-system-packages`.

---

## Phase 4 — service mesh, east-west  ·  ~10 min

```bash
./labs/40-istio-ambient/install.sh
kubectl apply -f ./labs/40-istio-ambient/enroll.yaml
kubectl apply -f ./labs/40-istio-ambient/01-l4-authz.yaml
```

### ▸ Gate 4

```bash
./scripts/verify-40-mesh.sh
```

Namespace enrolled, workloads speaking HBONE, **and an unauthorised caller
refused**. Note that pods are still `1/1` — no sidecar was injected, nothing
restarted.

Then add the waypoint and see what L7 buys you that L4 cannot:

```bash
kubectl apply -f ./labs/40-istio-ambient/02-waypoint.yaml
kubectl -n agents label service deployment-agent istio.io/use-waypoint=agents-waypoint
kubectl apply -f ./labs/40-istio-ambient/03-l7-authz.yaml
```

→ [lab 40](labs/40-istio-ambient/)

---

## Phase 5 — ingress, north-south  ·  ~10 min

```bash
./labs/50-north-south/install.sh
kubectl apply -f ./labs/50-north-south/gateway.yaml -f ./labs/50-north-south/httproute.yaml
kubectl -n agents wait --for=condition=Programmed gateway/north-south --timeout=180s
```

### ▸ Gate 5

From WSL **or from a Windows browser** — the port mapping goes all the way out:

```bash
curl -sN http://a2a.localhost:8080/a2a/ops_concierge \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream","params":{"message":{
       "messageId":"m1","kind":"message","role":"user",
       "parts":[{"kind":"text","text":"deploy checkout-api 2.14.0 to production"}]}}}'
```

`submitted → working → input-required`, from outside the cluster, through a real
gateway. If you applied STRICT mTLS in phase 4 this will fail until the gateway
joins the mesh — that is [lab 50](labs/50-north-south/)'s third exercise and it
is worth hitting.

---

## Phase 6 — A2A-aware ingress  ·  ~10 min

```bash
source versions.env
helm upgrade --install agentgateway oci://ghcr.io/agentgateway/charts/agentgateway \
  --version "${AGENTGATEWAY_VERSION#v}" -n agentgateway-system --create-namespace --wait
kubectl apply -f ./labs/60-agentgateway/gateway.yaml -f ./labs/60-agentgateway/a2a-route.yaml
```

> Chart coordinates here are **unverified** — check
> <https://agentgateway.dev/docs/> if the install fails, and fix the file.

### ▸ Gate 6

```bash
./scripts/verify-60-a2a-ingress.sh
```

The card served through the gateway must advertise the **gateway's** URL. If it
advertises anything else, an external A2A client will send its RPC somewhere
useless — which is the single most common way an exposed ADK agent fails.

---

## Phase 7 — the payoff

```bash
./scripts/compare-paths.sh
```

The same A2A negotiation, east-west and north-south, side by side, with what each
path left behind. Same protocol, same agents, same result — different evidence,
because a boundary was crossed. That comparison is what the whole lab exists for.

```bash
make verify      # every check at once
```

---

## Phase 8 — optional: LLM egress  ·  needs a Gemini key

Everything so far ran on the scripted model. [Lab 70](labs/70-agent-router/)
turns the real one on and puts a gateway in front of it, because the agents'
outbound model traffic is the fourth boundary — the one nobody instruments and
everybody pays for.

---

## Pausing to save power (keep the cluster, stop the GPU work)

You do not need to destroy anything to stop the GPU spinning. Scale the heavy
workloads to zero; the cluster and all config stay put, and you scale them back
up in seconds.

```bash
# stop GPU + LLM load, keep everything defined
kubectl -n llm    scale deploy/ollama deploy/open-webui --replicas=0
kubectl -n agents scale deploy/ops-concierge deploy/deployment-agent --replicas=0
kubectl -n nvidia-device-plugin scale ds/nvdp-nvidia-device-plugin --replicas=0 2>/dev/null || true
```

Bring it back later:

```bash
kubectl -n llm    scale deploy/ollama deploy/open-webui --replicas=1
kubectl -n agents scale deploy/ops-concierge deploy/deployment-agent --replicas=1
```

To stop *everything* (frees the most RAM/CPU) without losing the cluster, stop the
kind node containers — see reboot recovery below, which is the same `docker start`.

## Restarting after a Windows reboot

The cluster is kind (Docker containers), not real EKS, so a reboot stops it but
does **not** destroy it — etcd, deployments and volumes persist in the node
containers. Bring it back in order; nothing here is a rebuild.

```powershell
# 1. Windows: start WSL
wsl
```
```bash
# 2. WSL: make sure the Docker daemon is up (docker-ce runs under systemd)
sudo service docker start 2>/dev/null || sudo systemctl start docker
docker info >/dev/null && echo "docker up"

# 3. start the kind node containers (they were stopped, not removed)
docker ps -a --filter "name=a2a-lab" --format '{{.Names}}\t{{.Status}}'
docker start $(docker ps -a --filter "name=a2a-lab" -q)

# 4. point this shell at the cluster and wait for the API to answer
export KUBECONFIG=~/adk-a2a-poc/k8s-lab/labs/10-cluster/kubeconfig
kubectl wait --for=condition=Ready nodes --all --timeout=180s
kubectl get pods -A          # workloads restart themselves once nodes are Ready
```

Then, only if you scaled things to zero before shutting down, scale them back
(step above). Two reboot-specific gotchas:

- **Ollama models may need re-pulling.** They live in an `emptyDir`; a pod that is
  *recreated* (not just restarted) loses them. If `ollama list` is empty:
  `kubectl -n llm exec deploy/ollama -- ollama pull qwen2.5:7b`. (Use a PVC instead
  of `emptyDir` in `llm-on-gpu.yaml` if you want them to survive.)
- **Port-forwards do not survive** anything — they are per-shell processes. Start
  them again after every reboot (Phase 3½, step 3).

If the GPU does not come back (`nvidia-smi` fails inside the node), re-run
`./scripts/setup-gpu-node.sh` — the containerd nvidia config persists, but the
runtime occasionally needs a nudge after a cold boot.

## Rebuilding from scratch

```bash
make clean                 # destroy the cluster and the registry
cd labs/10-cluster && terraform apply    # ~3 min to rebuild
```

Rebuilding is almost always faster than forensics. Do it whenever the cluster is
in a state you cannot explain — that disposability is the main practical
advantage a local cluster has over EKS, so use it. (After a rebuild you redo the
agent build/deploy and the Phase 3½ LLM steps, since those live in the cluster.)

## Where the state lives

| | |
|---|---|
| kubeconfig | `labs/10-cluster/kubeconfig` |
| Terraform state | `labs/10-cluster/terraform.tfstate` (gitignored) |
| Agent image | your WSL Docker daemon, loaded into kind |
| kind node containers | your WSL Docker daemon — survive a reboot (stopped, not removed) |
| Ollama models | `emptyDir` in the ollama pod — lost if the pod is recreated |
| Everything else | in the cluster, gone on `make clean` |

Nothing here touches Windows outside the Docker Engine running in WSL, and
nothing costs money until lab 90.
