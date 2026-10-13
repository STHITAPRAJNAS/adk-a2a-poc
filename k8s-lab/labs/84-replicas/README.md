# Lab 84 — Two replicas: the task is shared, the work is not

Run everything from the `k8s-lab` folder (or `mac-lab`).

Lab 80 made tasks survive a restart by putting the task store and the session
store in a database. The obvious next step is two replicas behind one Service,
and it looks like it should just work: every replica can read every task.

It does not. A shared store lets any replica **read** a task. While a task
runs, two things exist only in the memory of the pod running it: the executor
doing the work, and the live event stream subscribers read. Send the wrong call
to the other pod and you get two failures that look like success:

```
 a2a-probe ──SendStreamingMessage──► replica A   runs the release
           ──SubscribeToTask───────► replica B   ✗ snapshot, then silence
           ──CancelTask────────────► replica B   ✗ "CANCELED"… then A carries on
                                        │
                            a2a-postgres (tasks, sessions, owners)
```

This is the A2A twin of the AG-UI bug in [`agui/`](../../../agui/): shared
data, per-pod memory, and a load balancer that does not care.

## Before you start

The agents need this repo's newer code (the replica probe and the
`A2A_OWNER_ROUTING` switch), and the image now carries the Postgres driver.
Rebuild, and recreate the probe pod so it runs the new image:

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

Create the database password and start the database:

```bash
kubectl -n agents create secret generic a2a-db --from-literal=password="$(openssl rand -hex 24)"
kubectl apply -f labs/84-replicas/postgres.yaml
kubectl -n agents rollout status deploy/a2a-postgres
```

Then the specialist, twice. This is a separate copy, `deployment-agent-ha`:
lab 80 gave the chart's `deployment-agent` a volume only one pod can mount, and
this way labs 80–83 keep working untouched.

```bash
kubectl apply -f labs/84-replicas/specialist-ha.yaml
kubectl -n agents rollout status deploy/deployment-agent-ha
kubectl -n agents get pods -l app=deployment-agent-ha -o wide
```

Two pods, ideally on two nodes. Both read and write `a2a-postgres`.

## Step 1 — subscribe on the other replica

`replica-probe.sh` finds the two pods' IPs, starts a release on A, and while A
is in the 8-second compliance scan, subscribes to the task on B:

```bash
./labs/84-replicas/replica-probe.sh subscribe
```

```
    0.1s  A send       SUBMITTED
    0.2s  A send       WORKING
    1.3s  B subscribe  WORKING
    8.4s  A send       INPUT_REQUIRED
   23.4s  B subscribe  nothing new for 15s after A finished; giving up

✗ STUCK: the task reached INPUT_REQUIRED on A; B's subscriber saw ['WORKING'] and is still waiting.
```

B found the task in Postgres and sent the stored snapshot. Then nothing,
forever: the events are produced in A's memory, and B's stream for that task is
an empty local queue nobody writes to. A browser or an orchestrator that
reconnects through the Service has a one-in-two chance of landing here, and it
cannot tell: the stream is open, it just never says anything again.

## Step 2 — cancel on the other replica

```bash
./labs/84-replicas/replica-probe.sh cancel
```

```
    1.2s  B cancel     answered CANCELED
    1.2s  GetTask      CANCELED
    8.3s  A send       INPUT_REQUIRED
    9.3s  GetTask      INPUT_REQUIRED (after A's stream ended)

✗ RESURRECTED: B answered CANCELED, then the task became INPUT_REQUIRED.
```

Worse than step 1. B wrote CANCELED to the shared store and told the caller
it worked. A never heard of it, finished the scan, and wrote INPUT_REQUIRED
over a state the spec calls final. The "cancelled" release went on to open an
approval ticket. Every caller that checked after the cancel saw CANCELED; every
caller that checks now sees a live task.

## Step 3 — send the call to the pod that runs the task

```bash
kubectl -n agents set env deploy/deployment-agent-ha A2A_OWNER_ROUTING=1
kubectl -n agents rollout status deploy/deployment-agent-ha
./labs/84-replicas/replica-probe.sh subscribe
./labs/84-replicas/replica-probe.sh cancel
```

```
    8.4s  B subscribe  INPUT_REQUIRED
✓ B's subscription followed the task live to INPUT_REQUIRED (forwarded to deployment-agent-ha-…, which runs it)

    1.3s  A send       CANCELED
    1.3s  B cancel     answered CANCELED (forwarded to deployment-agent-ha-…)
✓ canceled, and it stayed canceled: the work stopped where it ran
```

What the switch does (`common/task_ownership.py`):

- While its executor runs a task, a pod records "task X runs here, reach me at
  `http://<pod IP>:8001`" in a table next to the task store (`a2a_task_owner`),
  and removes the row when the run ends.
- A pod that receives `SubscribeToTask` or `CancelTask` for a task another pod
  owns forwards the request there unchanged (same headers, same token) and
  streams the answer back. The answer carries `x-a2a-served-by`.
- If the owner does not answer (it died mid-task), the stale claim is dropped
  and the call is served locally, as before.
- `SendMessage`, `GetTask` and `ListTasks` are not touched: the store answers
  them correctly from any pod.

See it in the logs:

```bash
kubectl -n agents logs -l app=deployment-agent-ha --tail=50 | grep -E "running here|forwarding"
```

## Other ways to fix it

| Fix | Trade-off |
|---|---|
| Forward to the owner (this lab) | Small; every replica stays equal. One extra hop for the two calls that need it. |
| Sticky routing by task id at the load balancer | Needs a balancer that reads the JSON-RPC body, and breaks when the pod restarts. |
| A shared event bus (Redis pub/sub, Postgres `LISTEN/NOTIFY`) | Any pod can serve any stream. Replaces the SDK's in-process queues: a bigger change. |
| One replica | The honest answer for many agents. Scale with more agents, not more copies. |

And the cancel side has a second guard worth having whatever you choose: an
executor that checks the store for a terminal state before each write would
refuse to resurrect a task even if a cancel slipped past.

## What else lives in one pod's memory

The specialist also keeps its approval tickets and deployment jobs in memory
(`common/approvals.py`, `common/jobs.py`). With two replicas, a ticket opened on
A is unknown to B. Owner routing does not fix that, and neither does any A2A
setting: application state that must outlive a pod or be seen by every pod
belongs in the database too. Lab 80 made that point for one pod; this lab makes
it for two.

## Verify

```bash
./scripts/verify-84-replicas.sh
```

## Undo

```bash
kubectl delete -f labs/84-replicas/specialist-ha.yaml -f labs/84-replicas/postgres.yaml
kubectl -n agents delete secret a2a-db
```
