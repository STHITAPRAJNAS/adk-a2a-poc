# adk-a2a-poc

Two Google ADK agents deployed as **two independent A2A services**, calling each
other over the protocol, both served through ADK's `get_fast_api_app` wrapper.
It exists to make three things visible and testable:

- **Agent-to-agent** — each agent publishes its own Agent Card and answers A2A
  JSON-RPC. One of them is also a *client* of the other, which is what makes
  this a network rather than a client/server pair.
- **Human-in-the-loop** — an agent pauses mid-task for a human approval, its A2A
  task sits in `input-required`, and the pause **propagates outward across the
  hop** to whoever called it.
- **Long-running work** — an agent starts a job that outlives the request, hands
  back a portable handle, and the task is resumed later with the outcome.

Chat and UI are ADK's built-in **Dev UI**, served by the same wrapper.

```
                          ┌───────────────────────────────────────────┐
  browser ───── HTTP ────►│ ops_concierge                    :8000    │
  Dev UI                  │   get_fast_api_app(web=True, a2a=True)    │
                          │                                           │
  another ──── A2A ──────►│   A2A SERVER   /a2a/ops_concierge         │
  agent                   │   A2A CLIENT   RemoteA2aAgent ────────────┼──┐
                          │   LlmAgent, no domain tools of its own    │  │
                          └───────────────────────────────────────────┘  │
                                                             A2A JSON-RPC│
                          ┌───────────────────────────────────────────┐  │
                          │ deployment_agent                 :8001    │◄─┘
                          │   get_fast_api_app(web=True, a2a=True)    │
                          │   A2A SERVER   /a2a/deployment_agent      │
                          │   LlmAgent + 4 tools                      │
                          │     ├─ check_release_readiness    fast    │
                          │     ├─ run_compliance_scan        slow    │
                          │     ├─ request_change_approval    HITL    │
                          │     └─ start_deployment           async   │
                          └───────────────────────────────────────────┘
```

The scenario is release management. Ask the concierge to deploy something to
production and it hands the whole job to the release-operations agent, which
checks readiness, runs a compliance scan, **stops for a human to approve the
change**, then **starts a deployment job** and waits for its result.

The interesting part is that a caller talking only to `ops_concierge` gets that
entire contract — including both pauses — without ever addressing
`deployment_agent`. Each hop owns its own A2A task; the pause mirrors outward
and the resume is forwarded inward. `python scripts/a2a_chain_probe.py run`
shows both task ids side by side.

---

## Quick start

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env          # add GOOGLE_API_KEY, or set POC_FAKE_LLM=1
./scripts/run_all.sh          # starts both servers
python scripts/demo_client.py # walk the whole flow, approving by hand
```

Then open the chat UI at
<http://127.0.0.1:8000/dev-ui?app=ops_concierge> and say
*"deploy checkout-api 2.14.0 to production"*.

`make help` lists everything. Endpoints worth opening:

| | |
|---|---|
| Chat UI | <http://127.0.0.1:8000/dev-ui?app=ops_concierge> |
| Specialist's own Dev UI | <http://127.0.0.1:8001/dev-ui?app=deployment_agent> |
| `ops_concierge` Agent Card | <http://127.0.0.1:8000/a2a/ops_concierge/.well-known/agent-card.json> |
| `deployment_agent` Agent Card | <http://127.0.0.1:8001/a2a/deployment_agent/.well-known/agent-card.json> |
| Wiring summary | <http://127.0.0.1:8000/ops/wiring> |
| Background jobs | <http://127.0.0.1:8001/ops/jobs> |
| Approval tickets | <http://127.0.0.1:8001/ops/approvals> |

The specialist's own Dev UI is worth knowing about: it drives that agent
directly with no A2A in the way, which is how you tell an agent bug apart from a
protocol bug.

### Models

With a Gemini key: set `GOOGLE_API_KEY` and leave `POC_FAKE_LLM=0`. Both agents
default to `gemini-2.5-flash`; change `ORCHESTRATOR_MODEL` /
`DEPLOYMENT_AGENT_MODEL` in `.env`.

Without one: set `POC_FAKE_LLM=1` and both agents run on a deterministic
scripted model. See [Testing without an API key](#testing-without-an-api-key)
for exactly what that does and does not cover.

---

## How to test it

There are four levels, cheapest first. Run them in this order when something
breaks — each one rules out a layer.

### 1. Is the network discoverable?

```bash
make cards        # python scripts/a2a_chain_probe.py cards
```

Fetches both Agent Cards and prints the endpoints, transports and skills each
agent advertises. If this fails, nothing else will: `RemoteA2aAgent` refuses a
card whose RPC URL is not same-origin with where the card was fetched, and
refuses plain http off a loopback host.

### 2. Does one agent behave correctly on the wire?

```bash
make probe                                    # deployment_agent, with the HITL resume
python scripts/a2a_probe.py --agent ops_concierge run
make wrong-resume                             # the failure mode worth knowing
```

Raw JSON-RPC, no ADK client. You see `submitted → working → input-required`, the
pending call arriving as a DataPart flagged `adk_is_long_running`, and the
function response that resumes it. `--agent` picks either agent, since both are
A2A servers.

### 3. Do the two agents work with each other?

```bash
make chain          # the real thing: caller → ops_concierge → deployment_agent
make chain-reject   # rejection branch across both hops
make chain-direct   # same flow entering at the specialist, for comparison
```

This is the test that answers *"do two remote agents actually work together"*.
The probe addresses **only** `ops_concierge` over A2A and never speaks to
`deployment_agent` — yet it drives the full approve-and-deploy flow. It prints
both hops' task ids so you can see they are distinct, and `--direct` lets you
confirm the caller's contract is identical with the hop and without it.

### 4. Does the chat layer work?

```bash
make demo           # prompts you for the approval decision
make demo-approve   # unattended
```

Drives the orchestrator's `/run_sse` — the same endpoint the Dev UI uses — and
narrates each event. Open <http://127.0.0.1:8000/dev-ui?app=ops_concierge>
alongside to watch the conversation and its trace update live.

### The automated suite

```bash
make test        # 40 tests, no API key needed, ~80s
make test-live   # the same 40 against real Gemini (needs GOOGLE_API_KEY)
```

| file | what it covers |
|---|---|
| `tests/test_tools.py` | Tool logic, the job registry, approval tickets. Pure unit. |
| `tests/test_agent_card.py` | Both cards parse, and their RPC URLs pass the same-origin and loopback rules `RemoteA2aAgent` enforces. |
| `tests/test_a2a_protocol.py` | Wire-level, one agent: task states, the long-running DataPart, resume, and that text does *not* resume. |
| `tests/test_a2a_chain.py` | **Two agents over A2A**: separate task per hop, pause mirrors outward, resume forwards inward, caller finishes without addressing hop 2. |
| `tests/test_orchestrator_e2e.py` | The ADK client half, through a real `Runner` against a real remote server. |

Everything runs against real servers on real sockets — the fixtures in
`tests/conftest.py` start them, or reuse a stack you already have running. The
A2A hop is never mocked, because the hop is the thing under test.

---

## Testing without an API key

`POC_FAKE_LLM=1` (the default in `.env.example`, and forced in the test suite)
swaps both agents' `model=` for `ScriptedLlm` in `common/fake_llm.py` — a
`BaseLlm` subclass whose `generate_content_async` yields a response chosen by a
plain Python function instead of by a network call.

The decider reads the conversation ADK is about to send and picks the next move
from what it can already see:

```python
def _deployment_decider(conversation):
    if conversation.response_for("check_release_readiness") is None:
        return _call("check_release_readiness", ...)      # emit a FunctionCall
    if conversation.response_for("run_compliance_scan") is None:
        return _call("run_compliance_scan", ...)
    ...
```

**This is a substitution at the model boundary and nowhere else.** Everything
below it is the real system: the real `LlmAgent`, the real tool executor, the
real `LongRunningFunctionTool` handling, the real `A2aAgentExecutor`, real
sockets, real Agent Cards, real JSON-RPC, real task stores. A `FunctionCall` the
scripted decider emits is indistinguishable to ADK from one Gemini emitted, so
every task-state transition and every DataPart on the wire is genuine.

**What it does and does not prove:**

| | scripted model | real Gemini |
|---|---|---|
| A2A task state machine | ✅ | ✅ |
| Long-running call → `input-required` | ✅ | ✅ |
| Function response resumes the task | ✅ | ✅ |
| Pause propagating across a hop | ✅ | ✅ |
| Agent Card discovery and validation | ✅ | ✅ |
| That the *instructions* make a model call the right tools in the right order | ❌ | ✅ |
| Tool-description quality, delegation routing, output phrasing | ❌ | ✅ |

So the scripted run is the protocol test and the regression suite; it is not a
substitute for running the thing once with a real key. When you have one:

```bash
# .env: POC_FAKE_LLM=0 and GOOGLE_API_KEY=...
./scripts/run_all.sh && make chain && make test-live
```

A failure under `test-live` that passes under `make test` is almost always a
prompt problem — an instruction the model did not follow — not a protocol
problem, and the split is the point of having both.

---

## Driving human-in-the-loop from the Dev UI

The Dev UI is the chat layer, but a pending approval is a *function call*, not a
question — and the chat box sends text. Text does not resume a paused task; it
ends it unanswered (`make wrong-resume` demonstrates this, and
`tests/test_a2a_protocol.py` pins it). So:

- use **`python scripts/demo_client.py`** to answer the gate, and watch the
  conversation and its trace update live in the Dev UI alongside; or
- POST the function response yourself:

```bash
curl -sN http://127.0.0.1:8000/run_sse -H 'content-type: application/json' -d '{
  "appName": "ops_concierge",
  "userId": "demo-operator",
  "sessionId": "<your session id>",
  "newMessage": {"role": "user", "parts": [{"functionResponse": {
      "id": "<the pending function call id>",
      "name": "request_change_approval",
      "response": {"ticket_id": "CHG-...", "approved": true, "decided_by": "you"}
  }}]}
}'
```

The pending call's id is on the last event of the previous turn, in
`longRunningToolIds`.

---

## Layout

```
agents/ops_concierge/
    agent.py                   front door: LlmAgent + RemoteA2aAgent sub-agent
    agent.json                 its own Agent Card — it is an A2A server too
remote_agents/deployment_agent/
    agent.py                   specialist: LlmAgent + 4 tools
    tools.py                   the fast / slow / HITL / async tools
    agent.json                 its Agent Card
servers/
    orchestrator_server.py     get_fast_api_app(web=True, a2a=True)  :8000
    remote_agent_server.py     get_fast_api_app(web=True, a2a=True)  :8001
common/
    a2a_wire.py                hand-rolled A2A JSON-RPC client, shared by the
                               probes and the protocol tests
    config.py                  one .env, read once
    jobs.py                    background job registry (the "long" in long-running)
    approvals.py               change-approval tickets
    fake_llm.py                deterministic scripted model, for POC_FAKE_LLM=1
scripts/
    a2a_chain_probe.py         drives the whole network over A2A — the main event
    a2a_probe.py               raw JSON-RPC against a single agent
    demo_client.py             drives the chat layer (/run_sse) and narrates it
tests/                         unit, agent cards, wire-level A2A, the two-hop
                               chain, and ADK-level end to end
```

Two documents go deeper:

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — how *this repository* works: what
  `get_fast_api_app` mounts, how the agents are wired, what crosses a hop, and
  the two ADK sharp edges the wiring had to work around.
- **[`docs/a2a-negotiation-walkthrough.md`](docs/a2a-negotiation-walkthrough.md)**
  — *start here if A2A is new to you.* One worked example, told turn by turn:
  two agents negotiate a freight rate, one of them stops for a human, and the
  wire traffic is shown at every step.
- **[`docs/a2a-protocol-mechanics.md`](docs/a2a-protocol-mechanics.md)** — the
  same ground as reference rather than story: the task state machine, what
  streaming, the task store, the event queue and the push-notification store
  each do, why a parked agent is not running, and therefore who has to wake it.
  Claims marked **[verified]** were run against this stack, not read from docs.

Both have a styled `.html` twin in `docs/` if you prefer reading them that way.

There is also **[`k8s-lab/`](k8s-lab/)** on the `claude/k8s-a2a-lab` branch — a
hands-on path that runs these two agents on Kubernetes with a service mesh and
three different gateways, to make the east-west/north-south distinction
something you can measure rather than read about.

---

## Versions

Pinned, because ADK's A2A surface is marked `@a2a_experimental` and does break
across minors.

| | |
|---|---|
| `google-adk` | 2.8.0 |
| `a2a-sdk` | 1.1.2 |
| Python | 3.11+ |

The A2A endpoint ADK mounts answers both JSON-RPC generations on the same URL:
the 0.3 method names (`message/send`, `message/stream`, `tasks/get`) and the 1.x
proto-JSON names (`SendMessage`, `SendStreamingMessage`, `GetTask`). The scripts
here use the 0.3 names, which is what most A2A tooling speaks today.

---

## Not in scope

This is a proof of concept for protocol behaviour, and it is deliberately not
production-shaped:

- **No authentication.** The A2A endpoint is open. Real deployments attach
  credentials with a `RequestInterceptor` on the client and validate them in an
  `ExecuteInterceptor.before_agent` on the server.
- **In-memory everything.** Sessions, A2A tasks, jobs and approval tickets are
  all process-local and vanish on restart. `get_fast_api_app` takes
  `session_service_uri` and `task_store_uri` for the real thing.
- **Loopback only.** `RemoteA2aAgent` accepts plain http only on a loopback
  host; anywhere else the Agent Card must advertise https.
- **Simulated work.** No cluster is touched. `common/jobs.py` sleeps.
- **No registry.** Each agent's downstream URL comes from `.env`. A real network
  of more than a handful of agents wants a catalogue that hands out Agent Cards,
  so an agent can be moved or scaled without editing its callers' config.
- **Two hops, one direction.** The chain is a line, not a mesh, and no agent
  calls back to one that called it. Adding a third agent is the same pattern —
  `ARCHITECTURE.md` says where — but cycles need loop protection this does not
  have.
