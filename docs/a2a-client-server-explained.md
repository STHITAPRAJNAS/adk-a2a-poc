# A2A client ↔ server, from the wire up

If the other A2A docs feel dense, start here. This one answers a single question:
**what actually happens between an A2A client and an A2A server?** — using a real
trace captured from this repo, not a description of one.

Every line of the trace below was produced by:

```bash
POC_FAKE_LLM=1 ./scripts/run_all.sh          # start both agents (no API key needed)
python scripts/a2a_probe.py run --approve     # a raw client talks to one server
```

`a2a_probe.py` is a hand-rolled client (see `common/a2a_wire.py`) — deliberately
*not* an SDK — so nothing hides what crosses the wire.

---

## 1. Who is the client and who is the server?

An A2A **server** is an agent that exposes an HTTP endpoint others can call. An
A2A **client** is whatever calls it. That's the whole distinction — it's about
*direction of the call*, not about being "smart".

In this PoC:

```
        A2A client                         A2A server
   ┌───────────────────┐             ┌────────────────────────┐
   │ ops_concierge      │  HTTP/JSON  │ deployment_agent        │
   │ (:8000)            │ ──────────► │ (:8001)                 │
   │ has NO deploy tools│             │ owns all the real tools │
   │ only knows how to  │ ◄────────── │ check_release_readiness │
   │ CALL the server    │  SSE stream │ run_compliance_scan …   │
   └───────────────────┘             └────────────────────────┘
```

A curl command is also a client. So is `a2a_probe.py`. The concierge is *just an
agent that happens to be a client of the deployment agent*. When you understand
"a client is anything that POSTs to `/a2a/<agent>`", A2A stops being mysterious.

> One subtlety worth internalising early: **both** agents are servers here
> (`get_fast_api_app(..., a2a=True)` on each). `ops_concierge` is a server *to
> the outside world* and a client *of `deployment_agent`*. An agent is usually
> both. See §5.

---

## 2. The server's public surface

A2A servers advertise themselves with a **card** at a well-known URL, then do the
work at a JSON-RPC endpoint. That's the entire contract:

```
GET  /a2a/deployment_agent/.well-known/agent-card.json   ← "who I am, how to reach me"
POST /a2a/deployment_agent                               ← the actual work (JSON-RPC)
```

The very first thing any client does is fetch the card. Real output:

```
GET http://127.0.0.1:8001/a2a/deployment_agent/.well-known/agent-card.json
  name        deployment_agent
  version     1.0.0
  transports  ['JSONRPC']
  rpc url     ['http://127.0.0.1:8001/a2a/deployment_agent']
  streaming   True
  skills
    - release_readiness:     Release readiness check
    - compliance_scan:       Pre-release compliance scan
    - human_change_approval: Human change approval
    - deployment_execution:  Deployment execution
```

The card tells the client three things it needs: **where** to POST (`rpc url`),
**how** (`transports` → JSONRPC), and **whether** it can stream (`streaming:
True`, so ask for SSE). The `skills` are advertised capabilities — this is what a
client's LLM reads to decide "yes, this is the agent I should delegate to".

---

## 3. One call, one task — the real trace

Now the client POSTs a request. This is the request line from the trace:

```
POST http://127.0.0.1:8001/a2a/deployment_agent  method=message/stream
  request: {"messageId":"40b8376…","kind":"message","role":"user",
            "parts":[{"kind":"text","text":"Please deploy checkout-api 2.14.0 to production."}]}
```

A few things to notice about this envelope, because they *are* the protocol:

- It's **JSON-RPC 2.0**. `method: "message/stream"` = "run this and stream events
  back". (There's also `message/send` for non-streaming.)
- The payload is a **message** with **parts**. Here one text part. Parts are how
  A2A carries mixed content (text, files, structured data) uniformly.
- There is **no `taskId`** on this first message. That's what makes it a *new*
  task. The server mints one.

The server responds with an **SSE stream** — a sequence of frames, each a small
JSON object describing one step. Here is the real stream, annotated:

```
  << task d3bf2065-…  context 74198989-…      ← server MINTED a task id + context id
  << submitted  [task]                        ← state 1: task accepted
  << working    [status-update]               ← state 2: agent is running
       function_call:     check_release_readiness {service:checkout-api, env:production, …}
       function_response: {ready:true, requires_human_approval:true, risk:high, …}
       function_call:     run_compliance_scan {service:checkout-api, env:production}
       function_response: {passed:true, controls_checked:[SOC2-CC7.2, …], …}
       function_call [LONG-RUNNING]: request_change_approval {risk:high, …}   ← id fc-852230e…
       function_response: {ticket_id:CHG-209C74E9, awaiting:{…}}
       text: Waiting on human approval for ticket CHG-209C74E9.
  << input-required  [status-update]          ← state 3: PAUSED, waiting on a human
       function_call [LONG-RUNNING]: request_change_approval  (id fc-852230e…)
```

Read the **state column** top to bottom — that's the A2A task state machine:

```
submitted ──► working ──► input-required
                              (parked on a long-running call)
```

The server ran two ordinary tools inline (readiness, scan) and streamed their
calls + results as they happened. Then it hit `request_change_approval`, which is
a **long-running** tool. Instead of blocking, the server:

1. tagged the frame `[LONG-RUNNING]` and gave the call an id (`fc-852230e…`),
2. drove the task to **`input-required`** — "I can't proceed until someone answers
   this",
3. ended the stream. The HTTP response is over, but **the task is not** — it's
   parked server-side, remembered by its `task_id`.

You can prove it's parked, not finished, with a separate call:

```
POST …/a2a/deployment_agent  method=tasks/get  id=d3bf2065-…
  state    input-required
  history  8 message(s)
```

`tasks/get` is the client asking the server "what's the state of that task?" — a
read, no side effects. The state is still `input-required`. The task is waiting.

---

## 4. Resuming the *same* task (this is the A2A-specific bit)

This is where A2A differs from a plain REST call. A REST call is one
request/response and it's done. An A2A task can pause and be **resumed** — but
only if the client sends the answer correctly. Here's the real resume request:

```
POST …/a2a/deployment_agent  method=message/stream  (resume)
  request: {"messageId":"0abb804…",
            "taskId":"d3bf2065-…",                    ← SAME task id as before
            "parts":[{"kind":"data",                   ← a DATA part, not text
                      "data":{"id":"fc-852230e70a2c",  ← SAME call id we were parked on
                              "name":"request_change_approval",
                              "response":{"ticket_id":"CHG-209C74E9","approved":true,…}},
                      "metadata":{"adk_type":"function_response"}}]}   ← tagged as a response
```

Three things make this a resume rather than a new task:

1. **`taskId` is the parked task's id.** Omit it → you'd start a fresh task and
   the gate would stay open forever.
2. The part is a **function-response DataPart**, not text. Its `id` matches the
   pending call's id (`fc-852230e…`), and its metadata says
   `adk_type: function_response`. That's how the server knows *which* pending call
   this answers.
3. The `response` payload is the human's decision (`approved: true`).

The server picks the task back up exactly where it paused and streams the next
leg — real output:

```
  << task d3bf2065-…                          ← SAME task id, continued
  << working  [status-update]
       function_call [LONG-RUNNING]: start_deployment {…, approval_ticket:CHG-209C74E9}
       function_response: {job_id:job-5e8a58e976, poll_url:…/ops/jobs/job-5e8a58e976, …}
       text: Deployment job job-5e8a58e976 is running; awaiting its result.
  << input-required  [status-update]          ← parked AGAIN, on the deployment job
```

The approval unblocked it; it then hit *another* long-running tool
(`start_deployment`) and parked again on the job result. Same pattern, same
mechanism. A task is a little state machine you drive one resume at a time.

> **The trap:** answer a paused task with plain **text** instead of a
> function-response DataPart and it does *not* error — the agent just runs again,
> produces no new pending call, and the task reaches `completed` with the gate
> never answered. `python scripts/a2a_probe.py wrong-resume` demonstrates exactly
> this. Resume with a DataPart, never text.

---

## 5. When the client is itself an agent (the two-hop chain)

Everything above used a dumb probe as the client. In the real app the client is
`ops_concierge`, and it does the identical thing under the hood. Captured from
`python scripts/a2a_chain_probe.py run`:

```
── turn 1 — release request → ops_concierge
   states           submitted → working → input-required
   this hop's task  9632be4d-…      ← the task the OUTSIDE caller created on the concierge
   downstream task  b248b6b0-…      ← a SECOND task the concierge created on deployment_agent
   tool result      transfer_to_agent: {…}          ← concierge delegates
   tool result      check_release_readiness: {…}    ← (these actually ran on deployment_agent,
   tool result      run_compliance_scan: {…}          streamed back up through the concierge)
   agent says       Waiting on human approval for ticket CHG-264F2AE8.
```

Look at the two task ids. **One conversation, two tasks:**

```
 outside caller ──task 9632be4d──► ops_concierge ──task b248b6b0──► deployment_agent
                  (hop-1 task)      (client here)   (hop-2 task)     (server)
```

- The outside caller only ever knows about **task 9632be4d** (hop 1).
- When the concierge delegated (`transfer_to_agent`), its own `RemoteA2aAgent`
  became a *client* and opened **task b248b6b0** on the deployment agent — exactly
  the `message/stream` → `input-required` → resume dance from §3–4, one layer
  down.
- The concierge stamps that downstream id onto its own event metadata, which is
  how the probe can even see `b248b6b0`. Each hop owns its own task; each hop
  resumes its own task independently.

That's the payoff of the "an agent is both client and server" point: the *same*
pause/resume machinery composes across hops. The human approval that arrives at
the concierge (hop 1) is relayed as a function-response into the downstream task
(hop 2), and each task advances on its own id.

---

## 6. The one-paragraph summary

An A2A **server** publishes a card (`/.well-known/agent-card.json`) and a
JSON-RPC endpoint (`/a2a/<agent>`). A **client** — a curl, a probe, or another
agent's `RemoteA2aAgent` — fetches the card, then POSTs `message/stream` with a
message-of-parts. The server mints a **task**, streams back SSE frames carrying a
state machine (`submitted → working → input-required/completed`) with tool calls
and results inline, and **parks** on any long-running call instead of blocking.
The client resumes by POSTing on the **same `taskId`** a **function-response
DataPart** whose id matches the pending call. When the client is itself an agent,
it opens its *own* downstream task on the next server, and the whole thing
composes — one conversation, one task per hop.

## Reproduce it yourself

```bash
POC_FAKE_LLM=1 ./scripts/run_all.sh
python scripts/a2a_probe.py card                 # §2 — the card
python scripts/a2a_probe.py run --approve        # §3–4 — one client, one server, full HITL
python scripts/a2a_chain_probe.py run            # §5 — two hops, two tasks
python scripts/a2a_probe.py wrong-resume         # the text-vs-DataPart trap
./scripts/stop_all.sh
```

See also: [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the ADK wiring behind this,
and [`docs/a2a-protocol-mechanics.md`](a2a-protocol-mechanics.md) for the task
store / event queue internals.
