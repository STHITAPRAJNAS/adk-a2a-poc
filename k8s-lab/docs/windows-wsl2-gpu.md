# Windows + WSL2 + a real GPU

The whole lab runs **inside WSL2**, not in PowerShell. Every script, Makefile
and Terraform module assumes a Linux shell. Windows' job is to own the NVIDIA
driver and run Docker Desktop; everything else happens in Ubuntu.

## The one thing to understand about GPUs on WSL2

The NVIDIA driver is installed on **Windows only**. You never install a driver
inside WSL, and installing one there will break things.

Windows exposes the GPU to WSL through a paravirtualised device, `/dev/dxg`, and
a set of stub libraries mounted at `/usr/lib/wsl/lib`. CUDA inside WSL talks to
`libdxcore.so`, which forwards to the Windows driver. That indirection is why
WSL GPU works at all — and it is also why some tooling that expects a real
`/dev/nvidia0` gets confused.

```
  Windows host          WSL2 Ubuntu             Docker container        kind node
  ────────────          ───────────             ────────────────        ─────────
  NVIDIA driver  ──►    /dev/dxg          ──►   nvidia-container   ──►  containerd
  (install here)        /usr/lib/wsl/lib        toolkit injects         + device plugin
```

Four layers, and the GPU has to survive all four. Most failures are one layer
not knowing about the one below it.

## Be warned: this is the fiddliest part of the lab

Real GPUs in Kubernetes on WSL2 work, but the NVIDIA device plugin has known
rough edges there — CDI mode depends on `libdxcore.so` in ways that break, and
there are open upstream issues about the plugin reporting no devices on WSL.

So lab 30 has **two paths**, and you pick at a clearly marked gate:

| Path | When | You get |
|---|---|---|
| **Real GPU** | `nvidia-smi` works in a pod | Genuine `nvidia.com/gpu`, real scheduling, real exhaustion |
| **Simulated** | It does not, and you would rather learn than debug NVML | `lab.local/gpu`, identical scheduling semantics, no hardware |

The scheduling lessons — taints, tolerations, affinity, capacity, reading why a
pod is Pending — are **identical** on both paths. The only thing the real path
adds is that the container can actually compute. Do not spend a day fighting the
device plugin before you have learned the part that transfers; take the
simulated path, finish the lab, and come back.

## Setup, in order

Each step has a check. Do not move on until the check passes — a failure four
layers down is miserable to diagnose backwards.

### 1. Windows: driver and WSL2

In PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --version          # WSL2, kernel 5.15+
```

Install the current **NVIDIA Game Ready or Studio driver** for your GPU from
nvidia.com. It includes WSL support. Do not install `nvidia-driver-*` inside
Ubuntu.

**Check**, inside WSL:

```bash
ls /dev/dxg && ls /usr/lib/wsl/lib/
nvidia-smi              # provided by the Windows driver via /usr/lib/wsl/lib
```

`nvidia-smi` printing your GPU here means layers 1 and 2 are good. If it does
not, nothing downstream will work; fix it before continuing.

### 2. Docker with the WSL2 backend

Docker Desktop → Settings → General → **Use the WSL 2 based engine**, and under
Resources → WSL Integration, enable your Ubuntu distro.

**Do not look for CPU and memory sliders in Docker Desktop — with the WSL2
backend there are none.** Docker runs inside WSL, so WSL's limits are Docker's
limits, and those live in a file on the Windows side. Create
`C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=12GB
processors=6
swap=4GB
```

Then, from PowerShell:

```powershell
wsl --shutdown          # the only way to make .wslconfig take effect
```

Four kind nodes plus Istio plus two gateways is not a small footprint. Left to
its default WSL will claim up to half your RAM, which is usually fine — set this
explicitly anyway, so a memory problem is a number you chose rather than one you
have to go and discover.

**Check**, inside WSL:

```bash
docker info --format '{{.ServerVersion}} {{.NCPU}}cpu'
docker run --rm --gpus all nvidia/cuda:12.6.2-base-ubuntu24.04 nvidia-smi
```

That second command is the real gate: a container seeing the GPU. Layer 3 done.

### 3. NVIDIA Container Toolkit

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
```

Now the two settings that make kind possible:

```bash
sudo nvidia-ctk runtime configure --runtime=docker --set-as-default
sudo nvidia-ctk config --set accept-nvidia-visible-devices-as-volume-mounts=true --in-place
sudo systemctl restart docker      # or restart Docker Desktop from Windows
```

**Why `accept-nvidia-visible-devices-as-volume-mounts`.** Normally you ask for a
GPU with `--gpus all`, which kind gives you no way to pass to a node container.
With this flag on, mounting anything at `/var/run/nvidia-container-devices/<id>`
tells the runtime to inject that device. A **mount** is something kind *does*
expose, through `extraMounts`. That is the whole trick, and it is what lets one
worker node have the GPU and the others not — a genuine GPU node group rather
than a cluster-wide flag.

**Check:**

```bash
docker run --rm -v /dev/null:/var/run/nvidia-container-devices/all \
  ubuntu:24.04 nvidia-smi -L
```

If that lists your GPU, lab 10 will produce a GPU node. If it errors, the flag
did not take — check `/etc/nvidia-container-runtime/config.toml`.

### 4. The rest of the tools

```bash
# kubectl, helm, terraform, kind, istioctl, k9s, jq — inside WSL
sudo apt-get install -y jq
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64 && \
  chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind
# … see labs/00-prereqs for the rest
```

Then `make doctor` checks the whole chain at once and tells you which layer is
broken.

## Where to keep the repo

**Inside the WSL filesystem** (`~/code/...`), not on `/mnt/c/`. Filesystem calls
across the Windows boundary are an order of magnitude slower, and Docker builds
and Terraform both do a great many of them. If you cloned to `C:\` already, move
it:

```bash
cp -r /mnt/c/Users/you/adk-a2a-poc ~/ && cd ~/adk-a2a-poc
```

## An alternative worth knowing: nvkind

NVIDIA publishes [nvkind](https://github.com/NVIDIA/nvkind), which automates
exactly the trick above and can distribute multiple GPUs across nodes:

```bash
go install github.com/NVIDIA/nvkind/cmd/nvkind@latest
nvkind cluster create --config-template=examples/one-worker-per-gpu.yaml
```

This lab does it with plain kind and `extraMounts` instead, for two reasons: it
keeps the Terraform flow in lab 10 intact, and it makes the mechanism visible
rather than hidden behind a tool. If you have several GPUs and want one per
node, nvkind is the better tool — the rest of the lab is unaffected either way.

## Known failure modes

| Symptom | Layer | Fix |
|---|---|---|
| `nvidia-smi` missing in WSL | 1 | Windows driver too old, or you installed a driver inside WSL. Remove the Linux driver. |
| `docker run --gpus all` fails | 3 | Toolkit not installed, or Docker not restarted. |
| The `/dev/null` mount test fails | 3 | `accept-nvidia-visible-devices-as-volume-mounts` not set. |
| kind node has no `/dev/dxg` | 4 | `extraMounts` missing on that node — check `labs/10-cluster/main.tf`. |
| Device plugin logs "No devices found. Waiting indefinitely." | 4 | The known WSL issue. Try disabling CDI mode; if it persists, take the simulated path. |
| `nvidia.com/gpu: 0` allocatable | 4 | Plugin started before the runtime was ready. Delete the pod and let it restart. |
