# Lab 88 — Suspend an agent while it waits for a person

Run everything from the `k8s-lab` folder (or `mac-lab`). About 20 minutes.

## In plain words

A release waits at the approval gate. The person who approves it is in a
meeting, then at lunch. For that whole hour the release agent sits in a pod,
holding memory and a slot on a node, doing nothing.

**Agent Sandbox** (a Kubernetes SIG Apps project) treats one agent instance as
one object, a `Sandbox`: one pod, a stable name, and its own disk. You can
**suspend** it: the pod goes away and the disk stays. **Resume** it and a new
pod starts on the same disk.

Lab 80 showed what has to be on that disk for a paused release to survive:
the A2A task store **and** the ADK session store. Put both there, and you can
suspend the agent while the person decides, then resume it to take the answer.

```
 park at the gate ──► suspend ──────────────► resume ──► answer the gate
 pod running          pod deleted              new pod       release moves on
 disk: tasks.db,      disk kept: the paused    same disk
       sessions.db    call is still on it
```

## Words used below

| Word | Meaning here |
|---|---|
| Sandbox | one agent instance: a pod, a stable hostname, its own disk (`agents.x-k8s.io/v1beta1`) |
| suspend | set `spec.operatingMode: Suspended`: the pod is deleted, the disk is kept |
| resume | set it back to `Running`: a new pod starts and re-attaches the same disk |
| volumeClaimTemplates | the disk the Sandbox asks for; it lives as long as the Sandbox does |

## Before you start

**1. Install the Agent Sandbox controller** (core only; this lab needs no
extensions):

```bash
source versions.env
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox.yaml"
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
kubectl get crd sandboxes.agents.x-k8s.io
```

**2. Start the release agent as a Sandbox:**

```bash
kubectl apply -f labs/88-agent-sandbox/sandbox.yaml
kubectl -n agents wait --for=condition=Ready sandbox/release-agent --timeout=180s
```

**3. Find its address and save a short name for the probe:**

```bash
SB=$(kubectl -n agents get sandbox release-agent -o jsonpath='{.status.serviceFQDN}')
echo "$SB"
URL="http://$SB:8001/a2a/deployment_agent"
alias sbprobe="kubectl -n agents exec a2a-probe -- env A2A_PROBE_STATE=/tmp/lab88.json python scripts/a2a_prod_probe.py --entry $URL --specialist $URL"
```

`serviceFQDN` is the stable name the controller gave the Sandbox's Service.
The probe talks to the release agent directly, without the concierge in
between. (No probe pod? `make probe`.)

## Step 1 — park a release at the gate

```bash
sbprobe pause
```

```
✓ parked at request_change_approval
```

See the pod, and the disk it writes to:

```bash
kubectl -n agents get pods -l app=release-agent-sandbox
kubectl -n agents get pvc
```

## Step 2 — suspend it

```bash
kubectl -n agents patch sandbox release-agent --type merge -p '{"spec":{"operatingMode":"Suspended"}}'
kubectl -n agents wait --for=condition=Suspended sandbox/release-agent --timeout=120s
kubectl -n agents get pods -l app=release-agent-sandbox
kubectl -n agents get pvc
```

No pod (`No resources found`). The disk is still there. Nothing is running
for this agent, and nothing is costing a node slot.

## Step 3 — resume it and answer the gate

```bash
kubectl -n agents patch sandbox release-agent --type merge -p '{"spec":{"operatingMode":"Running"}}'
kubectl -n agents wait --for=condition=Ready sandbox/release-agent --timeout=180s
sbprobe resume
```

```
✓ the gate was answered and the release moved on: job job-… is running
```

A different pod (check its name), the same disk, and the approval landed on
the call that was paused before the suspend.

## Step 4 — what if the stores are not on the disk?

This is lab 80 again, in a Sandbox. Remove the two store variables, park,
suspend, resume:

```bash
kubectl -n agents patch sandbox release-agent --type json -p '[{"op":"remove","path":"/spec/podTemplate/spec/containers/0/env/6"},{"op":"remove","path":"/spec/podTemplate/spec/containers/0/env/5"}]'
kubectl -n agents get sandbox release-agent -o jsonpath='{.spec.podTemplate.spec.containers[0].env[*].name}'; echo
```

The second command lists the variables; `TASK_STORE_URI` and
`SESSION_SERVICE_URI` must be gone. A change to the pod template takes effect
on the next pod, so suspend and resume once to pick it up, then repeat steps
1–3:

```bash
kubectl -n agents patch sandbox release-agent --type merge -p '{"spec":{"operatingMode":"Suspended"}}'
kubectl -n agents wait --for=condition=Suspended sandbox/release-agent --timeout=120s
kubectl -n agents patch sandbox release-agent --type merge -p '{"spec":{"operatingMode":"Running"}}'
kubectl -n agents wait --for=condition=Ready sandbox/release-agent --timeout=180s
```

Now `sbprobe resume` after a suspend fails, because the task and the paused
call lived in the old pod's memory:

```
✗ the resume was refused
```

The new pod answered `TaskNotFoundError` (-32001): it has never heard of the
task. **Suspend keeps the disk, not memory.** Put the stores back with
`kubectl apply -f labs/88-agent-sandbox/sandbox.yaml`.

## Sandbox or Deployment?

| | Deployment (labs 20–84) | Sandbox (this lab) |
|---|---|---|
| Unit | interchangeable copies | one agent instance |
| Name | a Service in front of any copy | a stable hostname for this instance |
| Disk | shared, or none | its own, kept while suspended |
| Idle | keeps running | suspend: pod gone, disk kept |
| Use it for | an agent service many callers share | an agent per task, user or session, that may sit idle |

The release agent in this repo is a shared service, so the Deployment is the
right default. A Sandbox fits when each task, user or session gets its own
agent, which is where idle agents add up.

## In a real system

- **Isolate the runtime.** Agents that run code they generate should use
  gVisor or Kata (`runtimeClassName` in the pod template). kind has neither.
- **Start fast.** The optional extensions add `SandboxTemplate`,
  `SandboxClaim` and `SandboxWarmPool`: a pool of ready sandboxes handed out on
  request, so a new agent does not wait for a pod to start.
- **Lock its egress too.** Lab 87's policy selects the deployment-agent pods;
  a Sandbox has its own labels (`app: release-agent-sandbox`), so give it its
  own policy.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| `no matches for kind "Sandbox"` | the controller is not installed | step 1 of "Before you start" |
| `wait … condition=Ready` times out | the pod cannot start | `kubectl -n agents describe sandbox release-agent`, then `kubectl -n agents get pods -l app=release-agent-sandbox` and its logs |
| the pod crashes with `unable to open database file` | the disk is not writable by user 10001 | on kind's default storage it is; with another storage class check that it honours `fsGroup` |
| `serviceFQDN` is empty | `service: true` was not applied | `kubectl apply -f labs/88-agent-sandbox/sandbox.yaml` again |
| `sbprobe resume` says `the resume was refused` after a suspend | the stores are not on the disk | step 4 explains; re-apply `sandbox.yaml` |
| `wait … condition=Suspended` times out | an older controller without that condition | `kubectl -n agents get pods -l app=release-agent-sandbox` until there is none |

## Check your work

```bash
./scripts/verify-88-sandbox.sh
```

It parks a release, suspends the Sandbox, checks the pod is gone and the disk
is kept, resumes it, and checks the approval lands.

## Clean up

```bash
kubectl delete -f labs/88-agent-sandbox/sandbox.yaml
kubectl delete -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox.yaml"
```

Deleting the Sandbox also deletes its disk.
