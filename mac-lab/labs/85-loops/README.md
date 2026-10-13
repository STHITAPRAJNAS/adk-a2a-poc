# Lab 85 — A delegation loop, and the guard that stops it

Run everything from the `k8s-lab` folder (or `mac-lab`).

An agent delegates to "whoever handles releases" by trusting a card to say who
that is. Point two agents' cards at each other (a copy-pasted values file, a
stale registry entry, two teams each configuring the other as the specialist)
and one request goes round and round:

```
 a2a-probe ──► loop-a ──► loop-b ──► loop-a ──► loop-b ──► …
              task 1     task 2     task 3     task 4
```

Every hop is a valid A2A call, so nothing in the protocol stops it. Each hop
opens a task, holds a connection and an LLM turn, and waits on the next one.
The caller sees a request that never answers.

This lab builds that loop with two copies of the ordinary concierge and no code
changes, watches it run, and then turns on a guard that refuses the request
when it comes back around, and tells the caller why.

## Before you start

The guard and the loop probe are in this repo's newer code. If you did lab 84
you already have them; otherwise:

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

Deploy the pair:

```bash
kubectl apply -f labs/85-loops/loop-pair.yaml
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
```

`loop-a` reads `loop-b`'s card as "the release agent", and `loop-b` reads
`loop-a`'s. Both are the plain concierge on the scripted model, which hands any
release request to the release agent.

Shorter commands for the rest of the lab:

```bash
alias loopprobe='kubectl -n agents exec a2a-probe -- python scripts/a2a_loop_probe.py --entry http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge --agents http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge http://loop-b.agents.svc.cluster.local:8000/a2a/ops_concierge'
```

## Step 1 — the loop

```bash
loopprobe
```

```
one release request into the pair

  tasks opened on loop-a.agents.svc.cluster.local:8000        16
  tasks opened on loop-b.agents.svc.cluster.local:8000        16

✗ LOOP: still bouncing after 30s; 32 tasks opened so far for ONE request.
```

The probe counts each agent's tasks with `ListTasks` before and after. One
request, dozens of tasks, and it is **still going** after the probe gives up:
every hop is waiting on the next, and each has a 15-minute timeout. Watch it:

```bash
kubectl -n agents logs deploy/loop-b --tail=5 -f
```

Stop it (Ctrl+C the logs), then stop the bouncing by restarting both pods.
Nothing else will:

```bash
kubectl -n agents rollout restart deploy/loop-a deploy/loop-b
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
```

With a real model, every one of those hops is an LLM call you pay for.

## Step 2 — the guard

```bash
kubectl -n agents set env deploy/loop-a deploy/loop-b A2A_MAX_HOPS=4
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
loopprobe
```

```
  tasks opened on loop-a.agents.svc.cluster.local:8000        1
  tasks opened on loop-b.agents.svc.cluster.local:8000        1
  the entry agent said: deployment_agent could not take this request: Delegation loop: loop-a is already in this request's trail (loop-a → loop-b → loop-a).

✓ the request ended after 4.9s and 2 task(s), state COMPLETED
```

What the switch does (`common/hops.py`):

- Every outbound A2A call carries the delegation trail so far, the way lab 83
  carries `traceparent`: `X-A2A-Trail: loop-a,loop-b`.
- An agent refuses a request whose trail already contains its own name (a
  cycle) or is already `A2A_MAX_HOPS` long (a chain deeper than anyone meant),
  with a JSON-RPC error (`-32010` loop, `-32011` too deep) that names the path.
- The name is `A2A_AGENT_ID`, here the pod's `app` label: two deployments of
  the same code are two agents, and need two names in the trail.

See the refusal in the log:

```bash
kubectl -n agents logs deploy/loop-a --tail=20 | grep refusing
```

## Step 3 — depth, not just cycles

A chain does not have to be a cycle to be wrong. Set the limit below the
pair's depth and the very first hop is refused:

```bash
kubectl -n agents set env deploy/loop-a deploy/loop-b A2A_MAX_HOPS=1
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
loopprobe
```

```
  the entry agent said: deployment_agent could not take this request: Delegation too deep: 2 hops, the limit here is 1 (loop-a → loop-b).
```

Put it back to 4 before you verify.

## Why the caller hears the reason

Without help, ADK's `RemoteA2aAgent` logs a downstream JSON-RPC error and
records an event with no content, and the A2A server ends the task
**COMPLETED with no text**: the user learns nothing. With
`SURFACE_DOWNSTREAM_ERRORS=1` the concierge adds an `after_agent_callback`
(`common.downstream.surface_downstream_error`) that turns the error into the
remote agent's answer. `A2A_MAX_HOPS` switches it on by default, which is why
the refusal above reads as a sentence. It is its own switch because it helps
elsewhere too: set it on `ops-concierge` in lab 82 and the token the specialist
refuses reaches the user as "could not take this request: HTTP Error 401…"
instead of an empty answer.

## In a real fleet

- Make the trail an A2A extension and carry it in message metadata, so it
  survives non-HTTP bindings and proxies that drop unknown headers.
- Pass a deadline and a budget down the same way. A hop limit stops loops; a
  deadline stops a chain that is merely slow; a budget stops one that is
  expensive.
- Treat the cards that drive delegation as configuration with review, not as
  data anyone can change: the loop here was made entirely of cards.

## Verify

```bash
./scripts/verify-85-loops.sh
```

## Undo

```bash
kubectl delete -f labs/85-loops/loop-pair.yaml
```
