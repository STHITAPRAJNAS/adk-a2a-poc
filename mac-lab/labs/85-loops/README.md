# Lab 85 — A delegation loop, and the guard that stops it

Run everything from the `k8s-lab` folder (or `mac-lab`). About 15 minutes.

## In plain words

The concierge does not do releases itself. It hands them to "the release
agent", and it finds out **who** that is by reading an Agent Card: a small
JSON file that says "the release agent lives at this address".

Now imagine two concierges, A and B, whose cards point **at each other**. A's
card says "the release agent is B"; B's card says "the release agent is A".
Nobody wrote buggy code. Someone copied a config file, or a registry entry went
stale. A release request now goes:

```
 you ──► A ──► B ──► A ──► B ──► A ──► …   (forever)
```

Each arrow is a perfectly valid A2A request, so nothing in the protocol says
"stop". Every hop opens a new task, keeps a connection open and, with a real
model, pays for an LLM call, then waits for the next hop to answer. It never
does. You see a request that never finishes.

The fix in this lab is a **trail**: every request carries the list of agents it
has already passed through. An agent that finds its own name on the list knows
the request has come back around, and refuses it with a clear error. The same
list also gives a **hop limit**: refuse anything that has already passed
through too many agents.

## Words used below

| Word | Meaning here |
|---|---|
| hop | one agent calling the next one |
| delegation | an agent handing a request to another agent instead of answering it |
| Agent Card | the JSON describing an agent, including its address |
| trail | the list of agents a request has passed through, sent as the `X-A2A-Trail` header |
| hop limit | `A2A_MAX_HOPS`: the most agents a request may pass through |
| the probe | a pod inside the cluster that sends the test request and reports what happened |

## Before you start

**1. Make sure you have the new image and probe pod.** If you did lab 84, you
already do; skip this.

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

**2. Deploy the two concierges that point at each other.**

```bash
kubectl apply -f labs/85-loops/loop-pair.yaml
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
```

You should see both `successfully rolled out`. They are ordinary copies of the
concierge, running the scripted model (no API key). The only unusual thing is
their cards: in `loop-pair.yaml`, the card mounted into `loop-a` names
`loop-b` as the release agent, and the other way round.

**3. Save a short name for the test command.** It sends one release request to
`loop-a` and counts how many tasks each agent opened while handling it.

```bash
alias loopprobe='kubectl -n agents exec a2a-probe -- python scripts/a2a_loop_probe.py --entry http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge --agents http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge http://loop-b.agents.svc.cluster.local:8000/a2a/ops_concierge'
```

The alias only lasts for this terminal window; run the line again in a new one.

## Step 1 — watch the loop

```bash
loopprobe
```

What you should see (after 30 seconds):

```
one release request into the pair

  tasks opened on loop-a.agents.svc.cluster.local:8000        16
  tasks opened on loop-b.agents.svc.cluster.local:8000        16

✗ LOOP: still bouncing after 30s; 32 tasks opened so far for ONE request.
```

How to read it:

- You sent **one** request. Each agent opened 16 tasks for it: every time the
  request came back, it was treated as brand new work.
- `still bouncing`: the probe gave up waiting, but the agents did not. Each hop
  is still waiting on the next one, and each will wait up to 15 minutes.

Watch it keep going after the probe gave up:

```bash
kubectl -n agents logs deploy/loop-b --tail=5 -f
```

New `POST /a2a/ops_concierge` lines keep appearing. Press Ctrl+C to stop
watching.

**Stop the loop.** Nothing inside the agents will; restarting both pods drops
every waiting request:

```bash
kubectl -n agents rollout restart deploy/loop-a deploy/loop-b
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
```

With a real model, each of those dozens of hops would have been a paid LLM
call, for a request that never got an answer.

## Step 2 — turn on the guard

```bash
kubectl -n agents set env deploy/loop-a deploy/loop-b A2A_MAX_HOPS=4
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
loopprobe
```

The first line switches the guard on for both agents with a limit of 4 hops;
Kubernetes restarts them with it.

What you should see (within a few seconds):

```
  tasks opened on loop-a.agents.svc.cluster.local:8000        1
  tasks opened on loop-b.agents.svc.cluster.local:8000        1
  the entry agent said: deployment_agent could not take this request: Delegation loop: loop-a is already in this request's trail (loop-a → loop-b → loop-a).

✓ the request ended after 4.9s and 2 task(s), state COMPLETED
```

What happened, hop by hop:

1. You → `loop-a`. No trail yet. `loop-a` starts the trail: `loop-a`.
2. `loop-a` → `loop-b`, carrying `X-A2A-Trail: loop-a`. `loop-b` is not on
   the list, so it accepts and adds itself: `loop-a, loop-b`.
3. `loop-b` → `loop-a`, carrying `X-A2A-Trail: loop-a,loop-b`. `loop-a` finds
   **its own name** on the list and refuses: "Delegation loop".
4. The refusal travels back: `loop-b` reports it to `loop-a`, and `loop-a`
   reports it to you, as a sentence.

Two tasks instead of dozens, an answer in seconds instead of never, and the
answer says what went wrong.

See the refusal in the log:

```bash
kubectl -n agents logs deploy/loop-a --tail=20 | grep refusing
```

```
WARNING:     [common.hops] refusing a delegation loop: loop-a → loop-b → loop-a
```

## Step 3 — a chain that is too long, even without a loop

A request does not have to come back around to be wrong: a chain of ten
different agents is usually a mistake too. The hop limit catches that. Set it
to 1 so even the first hand-off is too many:

```bash
kubectl -n agents set env deploy/loop-a deploy/loop-b A2A_MAX_HOPS=1
kubectl -n agents rollout status deploy/loop-a
kubectl -n agents rollout status deploy/loop-b
loopprobe
```

What you should see:

```
  the entry agent said: deployment_agent could not take this request: Delegation too deep: 2 hops, the limit here is 1 (loop-a → loop-b).
```

`loop-b` refused because the request had already passed through one agent and
the limit is 1. No loop was needed.

Put the limit back before you check your work:

```bash
kubectl -n agents set env deploy/loop-a deploy/loop-b A2A_MAX_HOPS=4
```

## How the guard works

The switch is `A2A_MAX_HOPS`; the code is `common/hops.py`.

- **Carrying the trail.** Every A2A request an agent sends to another agent gets
  an `X-A2A-Trail` header: the agents this request has passed through, oldest
  first. It travels the same way lab 83's `traceparent` header does.
- **Checking the trail.** When a request arrives, the agent refuses it if its
  own name is on the trail (a loop: JSON-RPC error `-32010`) or if the trail is
  already `A2A_MAX_HOPS` long (too deep: `-32011`). The error message names the
  whole path, so whoever reads it can see where the loop is.
- **Naming the agents.** The name on the trail is `A2A_AGENT_ID` (here, each
  pod's `app` label). Both pods run the same code, so they need different
  names; with the same name, `loop-b` would refuse the very first hop.

## Why you get a sentence, not an empty answer

Without extra help, when the next agent refuses a request, ADK records the
error in its log and finishes the task **COMPLETED with no text**. The user
gets an empty answer and no idea why.

The switch `SURFACE_DOWNSTREAM_ERRORS=1` fixes that. It turns the refusal into
the agent's answer ("could not take this request: …"). `A2A_MAX_HOPS` turns it
on by default, which is why step 2 printed a sentence. It is also useful on its
own: set it on `ops-concierge` in lab 82, and the token the release agent
rejects reaches the user as "could not take this request: HTTP Error 401…"
instead of nothing.

## In a real system

- **Carry the trail inside the message**, as an A2A extension in message
  metadata, so it survives proxies that drop unknown headers and transports
  other than HTTP.
- **Pass a deadline and a budget the same way.** The hop limit stops loops; a
  deadline stops a chain that is merely slow; a budget stops one that is too
  expensive.
- **Review card changes like code.** The loop in this lab was made entirely of
  two cards.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| `zsh: command not found: loopprobe` | new terminal window | run the `alias loopprobe=…` line again |
| `probe failed` or `No such file` for the script | the probe pod runs the old image | `kubectl -n agents delete pod a2a-probe`, then `make probe` |
| step 2 still says `LOOP` | the agents did not restart with the switch, or the loop from step 1 is still running | rerun the `rollout restart` from step 1, then the step 2 commands |
| step 2 says "Delegation loop" but names `ops_concierge → ops_concierge` | `A2A_AGENT_ID` is missing | `kubectl apply -f labs/85-loops/loop-pair.yaml` again |
| the answer is empty instead of a sentence | `SURFACE_DOWNSTREAM_ERRORS` is off | `kubectl -n agents set env deploy/loop-a deploy/loop-b SURFACE_DOWNSTREAM_ERRORS=1` |

## Check your work

```bash
./scripts/verify-85-loops.sh
```

It passes when the guard is on, the request ends instead of bouncing, and the
answer names the loop.

## Clean up

```bash
kubectl delete -f labs/85-loops/loop-pair.yaml
```
