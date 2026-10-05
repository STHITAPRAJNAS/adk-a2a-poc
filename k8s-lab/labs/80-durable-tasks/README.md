# Lab 80 — Durable tasks: kill the pod while a human decides

Run everything from the `k8s-lab` folder (or `mac-lab`).

An approval can take an hour. A pod can be rescheduled in a second: a node
drain, an OOM kill, a rollout, a liveness probe that lost patience. This lab
parks a release at the human gate, deletes the pod holding it, and asks the
only question that matters: **can the approval still land?**

```
 a2a-probe ──A2A──► ops-concierge ──A2A──► deployment-agent
 (in-cluster)       task A                  task B  ⏸ input-required
                                                    approval ticket CHG-…
                                            ✗ kubectl delete pod
                                            … new pod, empty memory …
 resume ─────────► task A ───────────────► task B ?
```

You will see it fail **two different ways** before it works, and the second
failure is the one that bites people in production, because it looks like a
success.

## Before you start

The agents need this repo's newer code (the probes and the durability switches),
so rebuild and reload the image, then restart both agents onto it:

```bash
make image
kubectl -n agents rollout restart deploy/ops-concierge deploy/deployment-agent
kubectl -n agents rollout status deploy/deployment-agent
```

Start the probe pod. Every exercise in labs 80–83 runs from here:

```bash
make probe
```

That applies `probe.yaml` and, if Istio is installed, `probe-mesh-allow.yaml`.
The second file matters only if you applied lab 40's authorization policies,
which let nothing but the concierge reach the specialist. It adds one permitted
caller (the probe's own service account) and loosens nothing else; lab 81 needs
it to ask the specialist about its own task.

Make the commands shorter for the rest of the lab:

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
```

## Step 1 — in memory: the task is simply gone

Park a release at the approval gate:

```bash
probe pause
```

You get both task ids (the concierge's and, one hop in, the specialist's), a
ticket id, and `✓ parked at request_change_approval`. Now delete the pod that
holds the gate, and wait for its replacement:

```bash
kubectl -n agents delete pod -l app.kubernetes.io/instance=deployment-agent
kubectl -n agents rollout status deploy/deployment-agent
```

Answer the gate:

```bash
probe resume
```

```
✗ the resume did not land: the stream closed and the task still says working
```

Ask the concierge why:

```bash
kubectl -n agents logs deploy/ops-concierge | grep -i "not found"
```

```
A2A request failed: Task 3f2c… not found
```

The new pod answered `TaskNotFoundError` (-32001): the task lived in the old
pod's memory. Notice also what the **caller** got: not an error, but a task
stuck in `working` forever. A downstream failure did not propagate as a
failure. Remember that; lab 82 shows it again.

## Step 2 — persist the task store: the dangerous half-fix

Give the specialist a volume and put its A2A task store there:

```bash
kubectl apply -f labs/80-durable-tasks/state-pvc.yaml
kubectl -n agents patch deploy deployment-agent --patch-file labs/80-durable-tasks/durable-tasks-only.yaml
kubectl -n agents rollout status deploy/deployment-agent
```

Repeat the experiment:

```bash
probe pause
kubectl -n agents delete pod -l app.kubernetes.io/instance=deployment-agent
kubectl -n agents rollout status deploy/deployment-agent
probe resume
```

```
   states           working → completed
   agent says       Function call not found for function response ids: {'fc-…'}
✗ COMPLETED, BUT WRONG: the A2A task survived the restart, the ADK
  session holding the paused call did not. The approval answered nothing.
```

This is the important one. The task was found, so the protocol was happy. But
an ADK agent keeps **two** pieces of state:

| Store | Holds | Switch |
|---|---|---|
| A2A task store | the task: id, state, history — what `GetTask` reads | `TASK_STORE_URI` |
| ADK session store | the paused invocation, including the pending function call the approval must answer | `SESSION_SERVICE_URI` |

The task survived; the session did not. The approval arrived, matched no
pending call, and the agent **completed the task with an error message as its
answer**. A caller that checks only the state sees `completed`.

Why was the session in memory at all? On a laptop ADK writes sessions to SQLite
under each agent's folder. On Kubernetes it detects `KUBERNETES_SERVICE_HOST`
and deliberately uses in-memory sessions instead (the image's filesystem is
read-only, and writing state into a container is a bug). You have to give it
somewhere real.

## Step 3 — persist both

```bash
kubectl -n agents patch deploy deployment-agent --patch-file labs/80-durable-tasks/durable-specialist.yaml
kubectl -n agents rollout status deploy/deployment-agent
probe pause
kubectl -n agents delete pod -l app.kubernetes.io/instance=deployment-agent
kubectl -n agents rollout status deploy/deployment-agent
probe resume
```

```
✓ the gate was answered and the release moved on: job job-… is running
```

Or run the whole cycle as a check:

```bash
./scripts/verify-80-durable.sh
```

## What you just learned

- **"Survives a restart" has two halves on ADK**, and the half people forget
  fails silently, as `completed`.
- **Durable tasks are not durable work.** Look at the tickets after a restart:

  ```bash
  kubectl -n agents exec deploy/deployment-agent -- python scripts/a2a_prod_probe.py --specialist http://127.0.0.1:8001/a2a/deployment_agent tickets
  ```

  Empty. This PoC keeps approval tickets and deployment jobs in memory, so a
  restart forgets the ticket a human was looking at, and a running rollout's
  job record. In production those live in the change-management system and the
  CD system, not in the agent. A task store only remembers the conversation.
- **One volume is one replica.** SQLite on a ReadWriteOnce volume is right for
  this lab and wrong for `replicas: 2`, where the resume can land on the other
  pod. Use a shared database for both stores (`postgresql+asyncpg://…` works for
  both switches; the image would need `asyncpg`). Proxies lesson in the A2A
  Proving Ground (`a2a-proving-ground/`, Infrastructure → Proxies) has an
  interactive version of exactly this.

### Stretch: kill the front door instead

The concierge has the same two stores, for the caller's task. Kill it while
parked, resume, and read the error the probe gets back. Then make it durable:

```bash
kubectl -n agents patch deploy ops-concierge --patch-file labs/80-durable-tasks/durable-concierge.yaml
```

## Undo

`kubectl patch` changes live objects behind Helm's back, and a plain
`helm upgrade` leaves such changes alone (it only touches fields the chart
manages). Put both agents back exactly as the chart renders them:

```bash
make reset-agents
```

That also drops anything else set with `kubectl set env` (lab 55's `OPA_URL`,
labs 81–83's switches). The volumes stay; delete them with
`kubectl delete -f labs/80-durable-tasks/state-pvc.yaml` once no pod uses them.

Keep the probe pod; labs 81–83 use it.
