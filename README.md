# adk-a2a-poc

Two Google ADK agents in two processes, wired to each other over the **A2A
protocol**, both served through ADK's `get_fast_api_app` wrapper, built to make
two things visible and testable:

- **Human-in-the-loop** — the remote agent pauses mid-task for a human approval
  and the A2A task sits in `input-required` until a decision arrives.
- **Long-running work** — the remote agent starts a job that outlives the
  request, hands back a handle, and the task is resumed later with the outcome.

Chat and UI are ADK's built-in **Dev UI**, served by the same wrapper.

```
                    ┌──────────────────────────────────────────┐
  browser ────────► │ ops_concierge          :8000             │
  Dev UI            │   get_fast_api_app(web=True)             │
                    │   LlmAgent                               │
                    │     └─ sub_agent: RemoteA2aAgent  ───────┼──┐
                    └──────────────────────────────────────────┘  │
                                                       A2A JSON-RPC│
                    ┌──────────────────────────────────────────┐  │
                    │ deployment_agent       :8001             │ ◄┘
                    │   get_fast_api_app(web=True, a2a=True)   │
                    │   LlmAgent + 4 tools                     │
                    │     ├─ check_release_readiness   fast    │
                    │     ├─ run_compliance_scan       slow    │
                    │     ├─ request_change_approval   HITL    │
                    │     └─ start_deployment          async   │
                    └──────────────────────────────────────────┘
```

The scenario is release management. Ask the concierge to deploy something to
production and it hands the whole job to the remote release-operations agent,
which checks readiness, runs a compliance scan, **stops for a human to approve
the change**, then **starts a deployment job** and waits for its result.

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

`make help` lists everything.

### Running with no API key

Set `POC_FAKE_LLM=1` in `.env` and both agents run on a deterministic scripted
model (`common/fake_llm.py`) instead of Gemini. The tools, the A2A traffic and
every task state transition are identical — only the token generation is
replaced. This is how the test suite runs, and it is the fastest way to see the
protocol before spending a quota.

With a real key, leave `POC_FAKE_LLM=0` and set `GOOGLE_API_KEY`. Models are
`gemini-2.5-flash` on both sides by default; change `ORCHESTRATOR_MODEL` /
`DEPLOYMENT_AGENT_MODEL` in `.env`.

---

## What to look at

| Command | Shows |
|---|---|
| `make demo` | The full flow with a real approval prompt in your terminal. |
| `make demo-approve` / `make demo-reject` | Both branches of the human gate, unattended. |
| `make probe-card` | Agent Card discovery. |
| `make probe` | The raw A2A JSON-RPC wire trace, including the resume. |
| `make wrong-resume` | What happens when you answer a paused task with plain text. |
| `make test` | 34 tests, protocol-level and end-to-end, no API key needed. |

Endpoints worth opening:

- Chat UI — <http://127.0.0.1:8000/dev-ui?app=ops_concierge>
- Remote agent's own Dev UI — <http://127.0.0.1:8001/dev-ui?app=deployment_agent>
  (drive the remote directly, with no A2A in the way, to tell an agent bug apart
  from a protocol bug)
- Agent Card — <http://127.0.0.1:8001/a2a/deployment_agent/.well-known/agent-card.json>
- Wiring summary — <http://127.0.0.1:8000/ops/wiring>
- Background jobs — <http://127.0.0.1:8001/ops/jobs>
- Approval tickets — <http://127.0.0.1:8001/ops/approvals>

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
agents/ops_concierge/          A2A client. LlmAgent + RemoteA2aAgent sub-agent.
remote_agents/deployment_agent/
    agent.py                   A2A server agent (LlmAgent + 4 tools)
    tools.py                   the fast / slow / HITL / async tools
    agent.json                 the A2A Agent Card ADK serves
servers/
    orchestrator_server.py     get_fast_api_app(web=True)            :8000
    remote_agent_server.py     get_fast_api_app(web=True, a2a=True)  :8001
common/
    config.py                  one .env, read once
    jobs.py                    background job registry (the "long" in long-running)
    approvals.py               change-approval tickets
    fake_llm.py                deterministic scripted model, for POC_FAKE_LLM=1
scripts/
    demo_client.py             drives the whole flow and narrates it
    a2a_probe.py               raw JSON-RPC against the remote agent
tests/                         unit, wire-level A2A, and end-to-end
```

`ARCHITECTURE.md` explains the mechanism in detail: the task state machine, how
a long-running tool becomes `input-required`, how a function response gets routed
back onto the same task, and the two ADK sharp edges this PoC had to work around.

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
