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

If the device plugin will not find devices, that is the known WSL2 issue: take
the simulated path in [lab 30](labs/30-node-groups/#fallback-no-hardware) and
carry on. Do not lose a day here.

Then pin the agents off the GPU pool:

```bash
helm upgrade ops-concierge ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-concierge.yaml -f labs/30-node-groups/agent-placement.yaml
helm upgrade deployment-agent ./charts/adk-agent -n agents \
  -f ./charts/adk-agent/values-specialist.yaml -f labs/30-node-groups/agent-placement.yaml
```

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

## Teardown and restart

```bash
make clean                 # destroy the cluster and the registry
cd labs/10-cluster && terraform apply    # ~3 min to rebuild
```

Rebuilding is almost always faster than forensics. Do it whenever the cluster is
in a state you cannot explain — that disposability is the main practical
advantage a local cluster has over EKS, so use it.

## Where the state lives

| | |
|---|---|
| kubeconfig | `labs/10-cluster/kubeconfig` |
| Terraform state | `labs/10-cluster/terraform.tfstate` (gitignored) |
| Agent image | your WSL Docker daemon, loaded into kind |
| Everything else | in the cluster, gone on `make clean` |

Nothing here touches Windows outside Docker Desktop, and nothing costs money
until lab 90.
