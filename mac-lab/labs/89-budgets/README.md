# Lab 89 — A token budget that travels with the request

Run everything from the `k8s-lab` folder (or `mac-lab`). About 15 minutes.

## In plain words

Every time an agent asks its model something, someone pays for the tokens. One
release request goes through two agents, and each makes several model calls.
Who decided how much that request may cost? Nobody. Each agent only sees its
own calls.

Lab 85 put a **trail** on every request so a loop gets caught. This lab puts a
**budget** on it the same way: a number of tokens the request may still spend,
sent along with every hop.

```
 you ──► concierge ──────────────► release agent
         budget 2000                 told "1563 left"
         spends 437                  spends until 0, then stops
```

- Each agent takes the smaller of its own limit and what the caller says is
  left.
- Before each model call it checks what is left. Nothing left: it stops with a
  sentence instead of calling the model.
- When it calls the next agent, it says what is left. The next agent cannot
  spend more than the caller had.
- A request that arrives with nothing left is refused before any work starts.

## Words used below

| Word | Meaning here |
|---|---|
| token | the unit models count and charge in; about four characters of English |
| budget | `A2A_TOKEN_BUDGET`: the most tokens one request may spend on this agent and the agents after it |
| `X-A2A-Budget` | the header that carries "tokens left" to the next agent |
| usage | the token counts the model reports after each call (`usage_metadata`) |
| the scripted model | the stand-in model these labs run (`POC_FAKE_LLM=1`); it reports usage like a real one, at about four characters a token |

## Before you start

**1. Make sure you have the new image and probe pod.**

```bash
make image
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
```

**2. Save a short name for the test command** (the same one as labs 80–83):

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
```

The alias only lasts for this terminal window; run the line again in a new one.

## Step 1 — give both agents a budget, and measure

Start with a budget too big to matter, so you can see what one release costs.

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent A2A_TOKEN_BUDGET=100000
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
```

The release parks at the approval gate as usual:

```
✓ parked at request_change_approval
```

Now read what each agent spent:

```bash
kubectl -n agents logs deploy/ops-concierge --tail=50 | grep "budget on"
kubectl -n agents logs deploy/deployment-agent --tail=50 | grep "budget on"
```

```
INFO:     [common.budget] budget on ops_concierge: spent 437 of 100000 tokens in 1 model call(s)
INFO:     [common.budget] budget on deployment_agent: spent 3619 of 99563 tokens in 4 model call(s)
```

Your numbers may differ a little. Look at the release agent's limit: it is
**99563**, not its own 100000. That is 100000 minus the 437 the concierge
spent. The concierge told it so, in the `X-A2A-Budget` header.

So one release costs about 4,000 tokens. That is the number the next two steps
squeeze.

## Step 2 — a budget that runs out halfway

Give the concierge 2,000 tokens: enough to hand the request on, not enough to
finish it.

```bash
kubectl -n agents set env deploy/ops-concierge A2A_TOKEN_BUDGET=2000
kubectl -n agents rollout status deploy/ops-concierge
probe pause
```

What you should see:

```
   tool result      check_release_readiness: {"owning_team": "payments", "ready": true, ...
   tool result      run_compliance_scan: {"passed": true, ...
   agent says       Budget exhausted: deployment_agent has spent 1633 of the 1563 tokens this request was allowed, so it stopped before another model call.

✗ BUDGET SPENT mid-release: the request stopped instead of spending more
```

Hop by hop:

1. The concierge starts with 2000, spends 437 deciding to delegate, and tells
   the release agent `X-A2A-Budget: 1563`.
2. The release agent checks readiness and runs the compliance scan. Those are
   two model calls, 1633 tokens.
3. Before its third call it finds nothing left, and answers with a sentence
   instead. The sentence travels back to you.

No approval was requested, and nothing was deployed. The budget stopped the
work at a model call, which is always a safe place to stop: the tools that ran
had finished.

Notice it spent **1633 of 1563**. The check runs *before* a call, so the last
call that started with budget left is allowed to finish. A budget is soft by
one call.

## Step 3 — nothing left for the next hop

Give the concierge less than its own first call costs:

```bash
kubectl -n agents set env deploy/ops-concierge A2A_TOKEN_BUDGET=300
kubectl -n agents rollout status deploy/ops-concierge
probe pause
```

What you should see:

```
   agent says       deployment_agent could not take this request: JSON-RPC Error -32012: Budget exhausted: the request reached deployment_agent with no tokens left.

✗ BUDGET SPENT before the next hop: the request stopped instead of spending more
```

The concierge made its one call (soft by one call, again), had nothing left,
and still delegated, telling the release agent `X-A2A-Budget: 0`. The release
agent refused before doing anything: no task, no model call.

```bash
kubectl -n agents logs deploy/deployment-agent --tail=20 | grep refusing
```

```
WARNING:     [common.budget] refusing a request with no budget left at deployment_agent
```

Put the concierge back before the next step:

```bash
kubectl -n agents set env deploy/ops-concierge A2A_TOKEN_BUDGET=100000
kubectl -n agents rollout status deploy/ops-concierge
```

## Step 4 — tokens and cost in the trace (needs lab 83's Jaeger)

Lab 83 put both agents into one trace. ADK already writes each model call's
token counts on its span. This step adds a price, so the trace also shows what
the request cost.

If Jaeger is not running, start it as in lab 83:

```bash
kubectl apply -f labs/83-tracing/jaeger.yaml
kubectl -n observability rollout status deploy/jaeger
```

Then turn on tracing and a price. The price, $0.30 per million tokens, is made
up for the lab.

```bash
J=http://jaeger.observability.svc.cluster.local:4318/v1/traces
kubectl -n agents set env deploy/ops-concierge OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$J OTEL_SERVICE_NAME=ops-concierge OTEL_BSP_SCHEDULE_DELAY=1000
kubectl -n agents set env deploy/deployment-agent OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=$J OTEL_SERVICE_NAME=deployment-agent OTEL_BSP_SCHEDULE_DELAY=1000
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent TRACE_PROPAGATION=1 A2A_TOKEN_PRICE_PER_MILLION=0.30
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
```

In a second terminal, open Jaeger:

```bash
kubectl -n observability port-forward svc/jaeger 16686:16686
```

Go to <http://localhost:16686>, pick **Service: ops-concierge**, Find Traces,
and open the newest one. Then:

- Click a **`generate_content poc-scripted-model/deployment_agent`** span. Its
  tags include `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`:
  what that one call cost.
- Click **`invoke_agent deployment_agent`**. Its tags include
  `a2a.budget.limit`, `a2a.budget.spent` and `a2a.budget.cost_usd`: the
  running total for this agent's part of the request.

The `gen_ai.*` names come from OpenTelemetry's GenAI conventions (still marked
Development). OpenTelemetry has **no** standard name for cost, so the `a2a.*`
names are this lab's own. Teams usually compute cost later, from tokens and a
price table, so that a price change does not rewrite old traces.

## How it works (`common/budget.py`)

- **Arriving.** Middleware on `/a2a/` reads `X-A2A-Budget`, takes the smaller
  of it and `A2A_TOKEN_BUDGET`, and keeps that for this request. Zero or less:
  it answers with JSON-RPC error `-32012` and the agent never sees the request.
- **Spending.** Two ADK callbacks on each agent: `before_model_callback`
  returns a sentence instead of calling the model when nothing is left;
  `after_model_callback` subtracts the `usage_metadata` the model reported.
- **Leaving.** The same outbound hook that carries lab 83's `traceparent` and
  lab 85's trail sets `X-A2A-Budget` to what is left.
- **The answer you read.** `A2A_TOKEN_BUDGET` turns on
  `SURFACE_DOWNSTREAM_ERRORS`, as lab 85's hop limit does, so a refusal reaches
  you as a sentence instead of an empty COMPLETED.

## In a real system

- **Budget money, not just tokens.** Different models charge different
  prices, and tools cost money too. Carry a currency amount, or tokens per
  model.
- **Hold back for the answer.** This lab stops at zero. A real agent keeps a
  reserve so it can still write a useful "here is how far I got".
- **Trust the number only from callers you trust.** A caller can send any
  header. The budget can only make a request cheaper, never dearer, because
  each agent takes the smaller number; but the caller who should pay is a
  question for identity (lab 82), not for the header.
- **A deadline travels the same way.** The trail stops loops, the budget stops
  cost, and a deadline stops a chain that is merely slow.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| no `budget on` lines in the log | the pods run the old image, or the switch is off | `make image`, then `kubectl -n agents rollout restart deploy/ops-concierge deploy/deployment-agent`; check `kubectl -n agents set env deploy/ops-concierge --list \| grep BUDGET` |
| step 2 still parks at the gate | the concierge did not restart with 2000 | rerun the `rollout status`; then `probe pause` again |
| `probe failed` or an unknown verdict | the probe pod runs the old image | `kubectl -n agents delete pod a2a-probe`, then `make probe` |
| the answer is empty instead of a sentence | `SURFACE_DOWNSTREAM_ERRORS=0` is set somewhere | `kubectl -n agents set env deploy/ops-concierge SURFACE_DOWNSTREAM_ERRORS-` |
| no `a2a.budget.*` tags in Jaeger | you clicked a `generate_content` span | they are on `invoke_agent deployment_agent` (and `invoke_agent ops_concierge`) |
| on Windows, the browser cannot open `localhost:16686` | WSL is not forwarding localhost to Windows | run the port-forward with `--address 0.0.0.0`, then open `http://<WSL IP>:16686`; `hostname -I` in WSL prints the IP |

## Check your work

```bash
./scripts/verify-89-budgets.sh
```

It passes when both agents have a budget, a release either parks within it or
stops with a budget sentence, and the release agent's log shows what it spent
or refused.

## Clean up

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent A2A_TOKEN_BUDGET- A2A_TOKEN_PRICE_PER_MILLION-
```

If you started tracing in step 4 and want it off too, run lab 83's Undo.
