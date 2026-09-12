# Windows + WSL2 + a real GPU

The whole lab runs **inside WSL2**, not in PowerShell. Every script, Makefile
and Terraform module assumes a Linux shell. Windows' job is to own the NVIDIA
driver and run Docker Desktop; everything else happens in Ubuntu.

> **If `apt`, `curl` or `ping` can't reach the internet from Ubuntu — even
> though Windows is online — jump straight to
> [WSL networking troubleshooting](#wsl-networking-troubleshooting) below.**
> A VPN client is the overwhelmingly common cause, and it breaks WSL even when
> you are not logged into it. This bites nearly everyone once; it is not you.

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

## New to WSL? Two prompts, two worlds

The single most common beginner confusion, and the source of several "command
not found" errors:

| The prompt you see | What it is | What runs here |
|---|---|---|
| `PS C:\Users\you>` | **PowerShell = Windows** | `wsl` commands: `wsl --install`, `wsl --shutdown`, `wsl --list` |
| `you@MACHINE:...$` | **Ubuntu = Linux** | everything else: `apt`, `ls`, `docker`, `git`, `kubectl` |

The tells:
- A prompt starting with `PS` is Windows; one starting with your username is Linux.
- `wsl` commands **only** work in PowerShell. Running `wsl --shutdown` inside
  Ubuntu gives "command not found" — you are already in Linux there.
- Linux never echoes passwords. When `sudo` asks and you see nothing as you
  type, that is normal — type it and press Enter.
- Two passwords exist: your **Windows** login, and the **Linux** user password
  you set during `wsl --install`. `sudo` wants the Linux one.

Nothing you do in a shell is lost by closing it, by `wsl --shutdown`, or by
rebooting Windows. Your Ubuntu files, user and installed packages live on disk
and survive all of that. A shell window is a viewport, not your work.

## The `.wslconfig` file (optional, and a common trap)

`.wslconfig` lives on the **Windows** side at `C:\Users\<you>\.wslconfig` and
tunes the WSL VM (memory, CPUs, networking mode). Two things bite people:

- **Notepad silently saves it as `.wslconfig.txt`**, which WSL then ignores.
  Write it from *inside Ubuntu* instead, which cannot add a hidden extension:
  ```bash
  printf '[wsl2]\nmemory=12GB\nprocessors=6\n' > /mnt/c/Users/<you>/.wslconfig
  cat /mnt/c/Users/<you>/.wslconfig   # verify it is exactly what you expect
  ```
- **It only takes effect after `wsl --shutdown`** (run from PowerShell), then
  reopening Ubuntu.

You do **not** need `.wslconfig` to do the lab. WSL defaults to a sensible share
of your RAM. Skip it if in doubt; a malformed one can stop the VM booting.

## WSL networking troubleshooting

This is, by a wide margin, the part most likely to cost you time — and almost
none of it is about Kubernetes. Work the ladder top to bottom.

### First, read the error — each one means something specific

| What Ubuntu says | What it means |
|---|---|
| `Temporary failure resolving 'archive.ubuntu.com'` | DNS is broken. Names don't resolve. (Raw internet may still work.) |
| `connect: Network is unreachable` (to `8.8.8.8`) | No route out at all — no default route. |
| `Destination Host Unreachable` *from your own `172.x` address* | WSL can't reach its own NAT gateway. The Windows-side WSL network is wedged or blocked. |
| `No route to host` | Packets resolve but can't leave. Usually a VPN or firewall. |
| Only IPv6 addresses (`2620:...`) fail with "unreachable" | WSL has no IPv6 route; apt is preferring IPv6. Force IPv4. |

### #1 cause: a VPN client — even one you are not logged into

VPN apps (NordVPN, ExpressVPN, OpenVPN, and others) install **network filter
drivers** that hook the entire Windows network stack — *including WSL's virtual
switch*. These load at boot and interfere **whether or not you have logged in or
connected**. NordVPN's kill switch is a frequent offender. This is the cause
that looks like everything else and wastes the most time.

**Spot it** — in PowerShell:
```powershell
Get-NetAdapter
```
Look for VPN adapters showing **Up**: `NordLynx`, `TAP-NordVPN`, `ExpressVPN
TAP`, `Wintun`, `OpenVPN Data Channel`. Any VPN adapter Up is a suspect.

**Fix it:**
1. Quit the VPN completely from the **system tray** (right-click → Quit), not
   just "disconnect".
2. Turn off its **kill switch** and **auto-connect / launch at startup** — or it
   relaunches on every reboot and breaks WSL again.
3. In PowerShell: `wsl --shutdown`, wait 15s, reopen Ubuntu, and
   `ping -4 -c 3 8.8.8.8`.

If you genuinely need the VPN on while working, switch WSL to mirrored
networking (below), which coexists with most VPNs far better than the default
NAT mode.

### #2: DNS broken but raw internet works

Symptom: `ping -4 8.8.8.8` succeeds, but `apt update` hangs or says "Temporary
failure resolving". WSL's DNS proxy got scrambled. Point DNS at a public
resolver and stop WSL regenerating it:
```bash
sudo rm -f /etc/resolv.conf
echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" | sudo tee /etc/resolv.conf
echo -e "[network]\ngenerateResolvConf = false" | sudo tee /etc/wsl.conf
sudo apt update
```
Confirm with `getent hosts archive.ubuntu.com` — it should return an IP.

### #3: apt only tries IPv6 and fails

Force apt onto IPv4:
```bash
echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99force-ipv4
sudo apt update
```

### #4: the network changed under WSL (e.g. Ethernet → WiFi)

WSL latches onto the network route that was active when it started. If your
laptop drops Ethernet and fails over to WiFi (or you connect/disconnect a dock),
WSL keeps trying the dead path. Cure: `wsl --shutdown` in PowerShell, wait 15s,
reopen. On a roaming laptop, mirrored networking mode avoids this.

### #5: WSL service or HNS wedged

If `wsl` commands hang, or `Restart-Service hns` reports "cannot be stopped",
the WSL/Host-Network-Service plumbing is stuck. In order:
1. Task Manager (`Ctrl+Shift+Esc`) → end `Vmmem`/`vmmemWSL` and any `wsl.exe`.
2. Admin PowerShell:
   ```powershell
   netsh winsock reset
   netsh int ip reset
   ipconfig /flushdns
   ```
   `netsh winsock reset` also strips third-party (VPN) hooks from the Winsock
   catalog, so it doubles as a VPN-cleanup.
3. **Reboot Windows** (a plain reboot after the winsock reset, which the reset
   requires to take effect). Nothing in WSL is lost.

### Mirrored networking mode (the roaming/VPN-friendly option)

Instead of WSL's default NAT, mirrored mode shares Windows' network directly —
no `172.x` subnet, and it follows adapter changes. Needs Windows 11 build
22621+. Write from Ubuntu:
```bash
printf '[wsl2]\nnetworkingMode=mirrored\ndnsTunneling=true\nautoProxy=true\n' \
  > /mnt/c/Users/<you>/.wslconfig
```
Then `wsl --shutdown` and reopen. `dnsTunneling` and `autoProxy` specifically
help in VPN/corporate setups. If mirrored misbehaves on your machine, delete the
file to fall back to NAT.

### The connectivity ladder — run these in order to locate the break

```bash
ping -4 -c 3 8.8.8.8                 # raw IPv4 out?  no → routing/VPN (#1,#4,#5)
getent hosts archive.ubuntu.com      # DNS resolves? no → DNS (#2)
curl -I https://archive.ubuntu.com   # HTTPS works?  no → proxy/firewall
```
The first line that fails points at the section to read.

## GPU: known failure modes

| Symptom | Layer | Fix |
|---|---|---|
| `nvidia-smi` missing in WSL | 1 | Windows driver too old, or you installed a driver inside WSL. Remove the Linux driver. |
| `docker run --gpus all` fails | 3 | Toolkit not installed, or Docker not restarted. |
| The `/dev/null` mount test fails | 3 | `accept-nvidia-visible-devices-as-volume-mounts` not set. |
| kind node has no `/dev/dxg` | 4 | `extraMounts` missing on that node — check `labs/10-cluster/main.tf`. |
| Device plugin logs "No devices found. Waiting indefinitely." | 4 | The known WSL issue. Try disabling CDI mode; if it persists, take the simulated path. |
| `nvidia.com/gpu: 0` allocatable | 4 | Plugin started before the runtime was ready. Delete the pod and let it restart. |
