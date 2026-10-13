# Lab 84 — Two replicas: the task is shared, the work is not

Run everything from the `k8s-lab` folder (or `mac-lab`). About 20 minutes.

## In plain words

You run **two copies** (replicas) of the release agent behind one Service, so
either copy can take any request. Both copies keep their tasks in the **same
database**, so either copy can look any task up.

That sounds like it should just work. It doesn't, because a task has two parts:

| Part | Where it lives | Who can use it |
|---|---|---|
| The **record**: id, state, history | the shared database | either copy |
| The **work** in progress, and the live updates it sends out | the memory of the copy that started it | only that copy |

Think of a shared order book in a kitchen with two cooks. Either cook can read
any order. Only the cook actually making the dish can tell you when it is
ready, or stop making it.

Now send a follow-up call to the **other** copy, the one not doing the work:

- **"Keep me posted on this task"** (`SubscribeToTask`): it reads the record,
  says "WORKING", and then never says anything again. The updates are being
  produced by the other copy, and they never reach this one.
- **"Cancel this task"** (`CancelTask`): it marks the record CANCELED and tells
  you "done". The copy doing the work never hears about it, carries on, and a
  few seconds later overwrites CANCELED with its next state. The cancelled
  release goes ahead and asks a person for approval.

Both look like success when they happen. That is what makes them dangerous.

The fix in this lab: each copy writes down "I am working on task X, reach me at
this address" in the shared database, and a copy that gets one of those two
calls for somebody else's task **passes it on** to the right copy.

This is the A2A version of the AG-UI bug in [`agui/`](../../../agui/): shared
data, memory that is not shared, and a load balancer that does not care which
copy it picks.

```
 a2a-probe ──"start a release"────► copy A   does the work
           ──"keep me posted"─────► copy B   ✗ "WORKING"… then silence
           ──"cancel it"──────────► copy B   ✗ "CANCELED"… then A carries on
                                      │
                         a2a-postgres (the shared record of every task)
```

## Words used below

| Word | Meaning here |
|---|---|
| replica / copy / pod | one running instance of the release agent; this lab has two |
| task store | the database table holding every A2A task's record |
| owner | the copy whose memory holds a task's running work |
| subscribe | an open connection on which the agent streams updates (`SubscribeToTask`) |
| the probe | a pod inside the cluster that sends the test requests and reports what happened |

## Before you start

**1. Rebuild the agent image and restart the probe pod.** The new switch and the
test script are in this repo's newer code, and the image now includes the
Postgres driver. The probe pod has to be recreated so it uses the new image.

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

You should see the image build, then `pod/a2a-probe condition met`.

**2. Start the shared database.** The first line makes a random password and
stores it in a Secret; nothing secret is written to a file.

```bash
kubectl -n agents create secret generic a2a-db --from-literal=password="$(openssl rand -hex 24)"
kubectl apply -f labs/84-replicas/postgres.yaml
kubectl -n agents rollout status deploy/a2a-postgres
```

You should see `deployment "a2a-postgres" successfully rolled out`.

**3. Start two copies of the release agent.** This is a separate deployment,
`deployment-agent-ha`, next to the one labs 20–83 use, so those labs keep
working. (Lab 80 gave the original a disk only one pod can use.)

```bash
kubectl apply -f labs/84-replicas/specialist-ha.yaml
kubectl -n agents rollout status deploy/deployment-agent-ha
kubectl -n agents get pods -l app=deployment-agent-ha -o wide
```

You should see **two** pods, `Running`, `1/1`, ideally on two different nodes.
Both talk to `a2a-postgres`.

## Step 1 — "keep me posted" sent to the wrong copy

```bash
./labs/84-replicas/replica-probe.sh subscribe
```

The script finds the two pods, calls them A and B, asks **A** to start a
release (A then spends 8 seconds on a compliance scan), and one second later
asks **B** to keep it posted on that task.

What you should see:

```
A = deployment-agent-ha-…-x7k2p (10.244.1.12)   B = deployment-agent-ha-…-q9m4d (10.244.2.8)
    0.1s  A send       SUBMITTED
    0.2s  A send       WORKING
    1.3s  B subscribe  WORKING
    8.4s  A send       INPUT_REQUIRED
   23.4s  B subscribe  nothing new for 15s after A finished; giving up

✗ STUCK: the task reached INPUT_REQUIRED on A; B's subscriber saw ['WORKING'] and is still waiting.
```

How to read it, line by line:

- `A send WORKING`: A accepted the release and is working on it.
- `B subscribe WORKING`: B found the task in the database and reported its
  state at that moment. So far so good.
- `A send INPUT_REQUIRED`: on A, the scan finished and the task now waits for
  a human approval.
- B never reports that. Its connection is still open, so whoever is listening
  (a web page, another agent) just keeps waiting on "WORKING".

**Why:** the updates come from the work, and the work is in A's memory. B has
nothing that will ever send it an update for this task.

**How often it bites:** with two copies and a load balancer, about half of all
reconnects land on the wrong copy.

## Step 2 — "cancel it" sent to the wrong copy

```bash
./labs/84-replicas/replica-probe.sh cancel
```

Same start (A begins a release); then **B** is asked to cancel it.

What you should see:

```
    1.2s  B cancel     answered CANCELED
    1.2s  GetTask      CANCELED
    8.3s  A send       INPUT_REQUIRED
    9.3s  GetTask      INPUT_REQUIRED (after A's stream ended)

✗ RESURRECTED: B answered CANCELED, then the task became INPUT_REQUIRED.
```

How to read it:

- `B cancel answered CANCELED` and `GetTask CANCELED`: B wrote CANCELED into
  the database and said it worked. Anyone checking now sees a cancelled task.
- `A send INPUT_REQUIRED`: A never heard of the cancel. It finished the scan
  and wrote its next state over the record.
- `GetTask INPUT_REQUIRED`: the task is alive again.

**Why this is worse than step 1:** the A2A spec says CANCELED is final; once a
task gets there it must never change. Here it did, the work went on, and an
approval request for a cancelled release is now waiting in a person's queue.

## Step 3 — turn on the fix and run both again

```bash
kubectl -n agents set env deploy/deployment-agent-ha A2A_OWNER_ROUTING=1
kubectl -n agents rollout status deploy/deployment-agent-ha
./labs/84-replicas/replica-probe.sh subscribe
./labs/84-replicas/replica-probe.sh cancel
```

The first line switches the fix on; Kubernetes restarts both copies with it.

What you should see:

```
    8.4s  B subscribe  INPUT_REQUIRED
✓ B's subscription followed the task live to INPUT_REQUIRED (forwarded to deployment-agent-ha-…, which runs it)

    1.3s  A send       CANCELED
    1.3s  B cancel     answered CANCELED (forwarded to deployment-agent-ha-…)
✓ canceled, and it stayed canceled: the work stopped where it ran
```

Both calls still went to B, but B passed them to A, the copy doing the work:
the subscription now sees every update, and the cancel actually stops the work.

## How the fix works

The switch is `A2A_OWNER_ROUTING=1`; the code is `common/task_ownership.py`.

1. **Sign in, sign out.** When a copy starts working on a task, it adds a row
   to a small table in the shared database: *task X runs here, at
   `http://<my pod IP>:8001`*. When the work ends, it removes the row.
2. **Pass it on.** When a copy receives `SubscribeToTask` or `CancelTask`, it
   looks the task up in that table. If another copy owns it, it sends the
   request there unchanged (same token, same trace header) and streams the
   answer back. The answer carries a header, `x-a2a-served-by`, naming the copy
   that really handled it.
3. **Dead owners.** If the owner does not answer (its pod was killed mid-task),
   the stale row is deleted and the call is handled locally, as before.
4. **Everything else is untouched.** `SendMessage`, `GetTask` and `ListTasks`
   only need the record, and any copy can read that.

See it happen in the logs:

```bash
kubectl -n agents logs -l app=deployment-agent-ha --tail=50 | grep -E "running here|forwarding"
```

You should see `running here` from one pod and `forwarding to …, which runs
it` from the other.

## Other ways to fix it

| Fix | Good | Costs |
|---|---|---|
| Pass the call to the owner (this lab) | small change; every copy stays the same | one extra hop for two kinds of call |
| Sticky routing: the load balancer always sends a task's calls to the same copy | no code change in the agent | the balancer must read the request body; breaks when that copy restarts |
| A shared message bus (Redis, Postgres `LISTEN/NOTIFY`) carrying the live updates | any copy can serve any subscriber | replaces how the A2A library delivers updates: a bigger change |
| Run one copy | nothing to coordinate | no redundancy; scale by adding different agents instead |

Whatever you choose, it is worth adding one more guard: before the agent
writes a new state, it checks whether the task is already CANCELED (or another
final state) and stops if so. That alone would have stopped step 2's cancel
being undone.

## What else is still in one copy's memory

The release agent also keeps its approval tickets and deployment jobs in memory
(`common/approvals.py`, `common/jobs.py`). With two copies, a ticket opened by A
does not exist on B. The fix in this lab does not change that, and no A2A
setting can: anything that must survive a restart, or be visible to every copy,
has to live in the database. Lab 80 showed that for one copy; this lab shows it
for two.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| `need two running deployment-agent-ha pods` | a pod is still starting, or crashed | `kubectl -n agents get pods -l app=deployment-agent-ha`; if one is in `CrashLoopBackOff`, look at `kubectl -n agents logs <pod>` |
| pods crash with a database error at start | they started before Postgres was ready | `kubectl -n agents rollout restart deploy/deployment-agent-ha` |
| `ModuleNotFoundError: asyncpg` in the pod log | the image was not rebuilt | `make image`, then the restart above |
| `error: unable to upgrade connection` or `pods "a2a-probe" not found` | the probe pod is missing | `make probe` |
| `probe failed: … No such file` for the script | the probe pod runs the old image | `kubectl -n agents delete pod a2a-probe`, then `make probe` |
| step 3 still says STUCK | the copies did not restart with the switch | `kubectl -n agents get deploy deployment-agent-ha -o yaml | grep -A1 OWNER_ROUTING` should show `"1"` |

## Check your work

```bash
./scripts/verify-84-replicas.sh
```

It passes only with the fix on and both copies running.

## Clean up

```bash
kubectl delete -f labs/84-replicas/specialist-ha.yaml -f labs/84-replicas/postgres.yaml
kubectl -n agents delete secret a2a-db
```
