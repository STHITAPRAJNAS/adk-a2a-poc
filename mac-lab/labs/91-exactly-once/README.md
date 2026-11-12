# Lab 91 — Deploy once, even when the answer is lost

Run everything from the `k8s-lab` folder (or `mac-lab`). About 15 minutes.

## In plain words

Up to now, `start_deployment` started a job inside the release agent's own
process. A real release agent calls a **CD system** over the network: "deploy
checkout-api 2.14.0 to production". That call can fail in a way that looks
harmless and is not:

```
 release agent ──── "deploy it" ────►  CD system   starts the deployment ✓
 release agent  ◄──── (answer lost) ─  CD system
 release agent: "no answer… try again"
 release agent ──── "deploy it" ────►  CD system   starts it AGAIN ✗
```

The agent cannot tell "it never happened" from "it happened, I just did not
hear back". Retrying is right: giving up would leave a release half-done. But
the retry must be **safe to repeat**.

The fix is an **idempotency key**: a name for the operation, sent with every
try. The CD system remembers each key and the answer it gave. Same key again?
It sends back the first answer and starts nothing new.

The key this lab uses is the **approval ticket**, the change a person
approved. One approval, one deployment, however many times anyone asks.

## Words used below

| Word | Meaning here |
|---|---|
| side effect | something a tool does to the world: a deployment, a payment, an email |
| retry | calling again after a timeout or an error |
| idempotent | doing it twice has the same effect as doing it once |
| `Idempotency-Key` | the HTTP header that names the operation (an IETF draft; Stripe and the Agentic Commerce Protocol use the same header) |
| the ledger | the CD system's list of every deployment it started |
| lost response | the work happened, the answer did not arrive in time |

## Before you start

Do this lab with lab 82 undone (`make reset-agents`) and lab 55's tools policy
off: lab 82 makes the probe need a token, and lab 55's policy refuses
production deploys before they reach the CD system.

**1. Build the new image and restart the probe pod.**

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

**2. Start the CD system.**

```bash
kubectl apply -f labs/91-exactly-once/cd-system.yaml
kubectl -n agents rollout status deploy/cd-system
```

**3. Point the release agent at it.** `CD_TIMEOUT_SECONDS=3` is how long one
try may take; it tries up to three times.

```bash
kubectl -n agents set env deploy/deployment-agent CD_URL=http://cd-system.agents.svc.cluster.local:8420 CD_TIMEOUT_SECONDS=3
kubectl -n agents rollout status deploy/deployment-agent
```

**4. Save short names for the two test commands.**

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
alias cdprobe='kubectl -n agents exec a2a-probe -- python scripts/cd_probe.py'
CD=http://cd-system.agents.svc.cluster.local:8420
```

`probe` drives a release, as in labs 80–83. `cdprobe` reads and controls the
CD system. They only last for this terminal window.

## Step 1 — a normal release

```bash
probe pause
probe resume
cdprobe list $CD
```

`probe resume` approves the change; the release agent calls the CD system. You
should see, among the resume output:

```
   CD system        dep-0001 after 1 attempt(s)
```

and from `cdprobe list`:

```
deployments in the CD ledger: 1
  dep-0001  checkout-api 2.14.0 → production  ticket CHG-9D1F27B0  key (no key)

✓ one deployment per approved change
```

Your ticket ids will differ. No surprise yet. Note `key (no key)`: the agent sends no idempotency key.

## Step 2 — lose one answer

Empty the ledger, start a new release, and tell the CD system to lose its next
answer: it will start the deployment, then reply only after 6 seconds. The
agent gives up waiting after 3.

```bash
cdprobe reset $CD
probe pause
cdprobe lose-next $CD
probe resume
cdprobe list $CD
```

What you should see:

```
   CD system        dep-0002 after 2 attempt(s)
```

```
deployments in the CD ledger: 2
  dep-0001  checkout-api 2.14.0 → production  ticket CHG-4E63071F  key (no key)
  dep-0002  checkout-api 2.14.0 → production  ticket CHG-4E63071F  key (no key)

✗ DEPLOYED 2 TIMES: one approval (CHG-4E63071F), 2 deployments
```

A person approved **one** change. Production got **two** deployments. Read
both sides:

```bash
kubectl -n agents logs deploy/deployment-agent --tail=30 | grep "CD attempt"
kubectl -n agents logs deploy/cd-system --tail=10
```

```
WARNING:     [deployment_agent.tools] CD attempt 1/3 for CHG-4E63071F: ReadTimeout after 3s, retrying
INFO:     [deployment_agent.tools] CD attempt 2: dep-0002 started
```

```
INFO:     [servers.cd_server] STARTED dep-0001: checkout-api 2.14.0 → production for CHG-4E63071F (Idempotency-Key none)
WARNING:     [servers.cd_server] losing the response for dep-0001: answering after 6s
INFO:     [servers.cd_server] STARTED dep-0002: checkout-api 2.14.0 → production for CHG-4E63071F (Idempotency-Key none)
```

The agent's log says "attempt 1 timed out". The CD system's log says
"attempt 1 started a deployment". Both are true. Every retry policy has this
gap. A real CD system would now be rolling out the same version twice, or
fighting itself over the same pods.

## Step 3 — send the approval ticket as the key

```bash
kubectl -n agents set env deploy/deployment-agent IDEMPOTENT_DEPLOYS=1
kubectl -n agents rollout status deploy/deployment-agent
cdprobe reset $CD
probe pause
cdprobe lose-next $CD
probe resume
cdprobe list $CD
```

What you should see:

```
   CD system        dep-0001 after 2 attempt(s)   ← replayed: nothing new started
```

```
deployments in the CD ledger: 1
  dep-0001  checkout-api 2.14.0 → production  ticket CHG-333C04D7  key CHG-333C04D7

✓ one deployment per approved change
```

The answer was still lost and the agent still retried. This time the retry
carried `Idempotency-Key: CHG-333C04D7`, the CD system recognised it, and sent
back `dep-0001` instead of starting `dep-0002`.

```bash
kubectl -n agents logs deploy/cd-system --tail=10 | grep replayed
```

```
INFO:     [servers.cd_server] replayed dep-0001 for CHG-333C04D7 (Idempotency-Key CHG-333C04D7): nothing new started
```

## Step 4 — a key names one operation

A key is bound to what it was first used for. Call the CD system yourself,
the way a second agent or a double click would, then try to reuse the key for
something else:

```bash
cdprobe deploy $CD --ticket CHG-TEST --key CHG-TEST
cdprobe deploy $CD --ticket CHG-TEST --key CHG-TEST
cdprobe deploy $CD --ticket CHG-TEST --key CHG-TEST --version 9.9.9
```

```
started dep-0002 (checkout-api 2.14.0)
✓ replayed dep-0002: the same deployment, nothing new
✗ refused, HTTP 422: Idempotency-Key CHG-TEST was already used for a different deployment; a key names one operation.
```

Without that check, a bug that reused a key would silently turn a request for
9.9.9 into a replay of 2.14.0.

## Why the approval ticket, and not a random key

Where the key comes from decides which duplicates it catches:

| Key | Catches |
|---|---|
| a new random value on every try | nothing: each retry looks new |
| one random value per tool call, reused across its retries | a lost response (this lab's step 2) |
| the approval ticket | that, **and** the model calling the tool twice, a second replica, a person approving twice, a replay after a crash |

The ticket is the thing a person actually approved, so "one ticket, one
deployment" is the rule you want. Deploying the same change again on purpose
needs a new approval, which is also what you want.

## How it works

- **The CD system** (`servers/cd_server.py`) keeps two tables in SQLite: the
  deployments, and key → (fingerprint of the request, the answer it gave).
  New key: start, store, answer. Known key, same fingerprint: answer from the
  store. Known key, different fingerprint: 422.
- **The tool** (`start_deployment` in `remote_agents/deployment_agent/tools.py`)
  calls `POST /deployments` with a 3-second timeout, up to three times, and
  with `IDEMPOTENT_DEPLOYS=1` adds `Idempotency-Key: <approval ticket>`.
- **The key must be stored with the effect, atomically.** The CD system writes
  the deployment and the key in one transaction. Store the key after the
  effect, and a crash between the two gives you the duplicate back.

## In a real system

- **Durable execution** engines (Temporal, Restate, DBOS) record each step's
  result, so a workflow that restarts after a crash reads "the CD call
  returned dep-0001" instead of calling again. That gives you steps that run
  at least once. A crash can still land between the call and the record, so
  the idempotency key is still what turns "at least once" into "once".
- **Ask the downstream for it.** Payment APIs, cloud APIs and good CD systems
  accept an idempotency key. When one does not, look before you act ("is
  there already a deployment for CHG-…?"), and accept that the look and the
  act are not atomic.
- **Keys expire.** The IETF draft lets a server forget keys after a while.
  Pick a lifetime longer than your longest retry or replay.
- **Payments (lab 86) already work this way.** AP2's mandates are bound to one
  checkout, and the wallet refuses a second presentation; ACP's checkout API
  takes the same `Idempotency-Key` header.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| no `CD system` line after `probe resume` | `CD_URL` is not set, or the pod runs the old image | redo "Before you start" steps 1 and 3 |
| `the gate was answered … which policy then refused` | lab 55's tools policy is on | `kubectl -n agents set env deploy/deployment-agent OPA_URL-` |
| `probe pause` fails with HTTP 401 | lab 82 is still applied | `make reset-agents`, then step 3 of "Before you start" again |
| `could not reach the CD system` | cd-system is not running | `kubectl -n agents rollout status deploy/cd-system` |
| step 2 shows 1 deployment | the lose-next was not set, or `IDEMPOTENT_DEPLOYS` is already on | rerun `cdprobe lose-next $CD` right before `probe resume`; check `kubectl -n agents set env deploy/deployment-agent --list` |
| `status 'failed'` with `cd_unreachable` | all three tries timed out | the CD system was asked to lose more than one answer; `cdprobe lose-next $CD 0` |

## Check your work

```bash
./scripts/verify-91-exactly-once.sh
```

It runs step 3 again (empty ledger, lost answer, retry) and passes when the
ledger holds exactly one deployment for the approval.

## Clean up

```bash
kubectl -n agents set env deploy/deployment-agent CD_URL- CD_TIMEOUT_SECONDS- IDEMPOTENT_DEPLOYS-
kubectl delete -f labs/91-exactly-once/cd-system.yaml
```
