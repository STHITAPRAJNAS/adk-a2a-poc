# Lab 81 — Cancel that reaches every hop

Every A2A hop owns its own task. When a caller cancels the concierge's task,
A2A says what happens to *that* task. It says nothing about the task the
concierge opened one hop in on the caller's behalf. Someone has to forward the
cancel, and out of the box nobody does.

```
 caller ──CancelTask──► ops-concierge            deployment-agent
                        task A  → canceled ✓     task B  ⏸ input-required … forever
                                                 ticket CHG-…  still pending,
                                                 in a human's queue
```

Run everything from the `k8s-lab` folder (or `mac-lab`). This lab uses the
probe pod from lab 80; start it with `make probe` if you skipped that lab, and
set the alias again in a new shell:

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
```

`probe cancel` asks the specialist directly about its own task. If you applied
lab 40's authorization policies, that needs `probe-mesh-allow.yaml`, which
`make probe` applies for you.

## Step 1 — ADK's default: the downstream task is orphaned

```bash
probe pause
probe cancel
```

```
── CancelTask 7f1e… on the front door
   front-door task is now canceled

── what the specialist says about its own task
   downstream 0b9c…  input-required

⚠ ORPHANED: the front door says canceled, the specialist is still waiting.
```

And the human cost, the ticket nobody will ever need to decide:

```bash
kubectl -n agents exec deploy/deployment-agent -- python scripts/a2a_prod_probe.py --specialist http://127.0.0.1:8001/a2a/deployment_agent tickets
```

```
CHG-4D1A9C02  pending   checkout-api 2.14.0
```

ADK's `A2aAgentExecutor.cancel` publishes `canceled` for the task it was asked
about, and stops there. The concierge's session *knows* the downstream task id
(it is how the resume finds it), but nothing uses it on cancel.

## Step 2 — turn on propagation

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent CANCEL_PROPAGATION=1
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
probe cancel
```

```
   front-door task is now canceled
   downstream 51aa…  canceled
✓ PROPAGATED: the downstream task was canceled too
```

The tickets now say `voided`. Read what each hop did:

```bash
kubectl -n agents logs deploy/ops-concierge | grep "cancel"
kubectl -n agents logs deploy/deployment-agent | grep "cancel"
```

```
[common.cancellation] cancel 51ab…: forwarding to deployment_agent task(s) ['51aa…']
[common.cancellation] cancel → deployment_agent task 51aa…: now TASK_STATE_CANCELED
[servers.remote_agent_server] cancel: voided approval ticket CHG-…
```

Or check it in one go:

```bash
./scripts/verify-81-cancel.sh
```

## How it works (`common/cancellation.py`)

`CANCEL_PROPAGATION=1` swaps ADK's executor for a subclass that overrides only
`cancel`:

1. **Publish `canceled` for its own task first.** Order matters: a2a-sdk stops
   the agent run *before* calling `cancel`, and the event queue closes as soon
   as that run winds down. An event published after a network round trip is
   silently dropped and the task keeps its old state. (The first version of this
   code did it the other way round and failed exactly like that.)
2. **Forward.** Read the session behind the task, take the downstream task ids
   `RemoteA2aAgent` recorded there (`a2a:task_id` in event metadata), and send
   each one `CancelTask`, through the same authenticated, traced HTTP client the
   conversation used (labs 82 and 83).
3. **Release local holds.** The leaf has no downstream. What it has is a pending
   approval ticket and maybe a running deployment job. It voids the ticket and
   stops the job.

Forwarding failures are logged, never raised: the caller asked for *this* task
to stop, and it does.

## Design questions worth arguing about

- **Should cancel propagate at all?** Here, yes: the downstream work exists only
  to serve the canceled request. A shared, long-lived downstream task serving
  several callers should not be killed by one of them. That is a product
  decision, which is exactly why A2A does not make it for you.
- **What can't be undone?** Canceling a task does not roll back a deployment
  that already reached production. Cancel stops *future* work; compensation
  (roll back, notify) is a separate step you design.
- **What if the downstream is unreachable?** Then the cancel is best-effort, and
  you need a sweeper: something that finds tasks whose parent is gone. The
  parent id would have to travel with the request (A2A's `metadata` or an
  extension) for that to be possible.

## Undo

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent CANCEL_PROPAGATION-
```
