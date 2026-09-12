# Runbook — zero to a working cluster, end to end

Every command, in order, with a gate after each phase. Run it all in one sitting
(about 90 minutes, most of it waiting on pulls) or stop at any gate and come back.

**Where you type these:** a WSL2 Ubuntu shell, with the repo cloned inside the
WSL filesystem (`~/adk-a2a-poc`), not on `/mnt/c/`. Windows' only jobs are the
NVIDIA driver and Docker Desktop.

If a gate fails, the phase's own lab README has a "things that go wrong" table.
Do not push past a failed gate — every layer here assumes the one below it.

---

## Phase 0 — the machine  ·  ~20 min

Full detail: [docs/windows-wsl2-gpu.md](docs/windows-wsl2-gpu.md)

```powershell
# PowerShell, as Administrator
wsl --install -d Ubuntu-24.04
wsl --update
```

Install the current **NVIDIA Game Ready or Studio driver** on Windows. Never
install a GPU driver inside WSL.

In Docker Desktop: enable the **WSL 2 based engine** and enable integration for
your Ubuntu distro. There are no CPU/memory sliders with this backend — WSL's
limits are Docker's limits. Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=12GB
processors=6
swap=4GB
```

then `wsl --shutdown` from PowerShell to apply it.

Then, inside WSL:

```bash
# NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit jq

# the two settings that make a GPU node group possible
sudo nvidia-ctk runtime configure --runtime=docker --set-as-default
sudo nvidia-ctk config --set accept-nvidia-visible-devices-as-volume-mounts=true --in-place
sudo systemctl restart docker    # or restart Docker Desktop

# CLI tools
curl -Lo kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/
curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform
curl -L https://istio.io/downloadIstio | sh - && sudo mv istio-*/bin/istioctl /usr/local/bin/
```

### ▸ Gate 0

```bash
cd ~/adk-a2a-poc/k8s-lab
make doctor
```

Every line green. The GPU lines are allowed to fail — if they do, you take the
simulated path in phase 3 and everything else is unaffected. Nothing else may
fail.

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
