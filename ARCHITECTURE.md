# How the A2A hop actually works here

This document is the "in depth" half of the PoC. It traces one release request
from the browser to the remote agent and back, naming the exact ADK and A2A
machinery at each step, and it records the two places where the obvious wiring
does not work and why.

Everything below is observable: `python scripts/a2a_probe.py run --approve`
prints the wire trace, and `tests/test_a2a_protocol.py` asserts on it.

For the protocol itself rather than this wiring of it — what streaming, the task
store, the event queue and the push-notification store each do, and why "agent B
notifies agent A when the job finishes" is not a thing A2A can do on its own —
see [`docs/a2a-protocol-mechanics.md`](docs/a2a-protocol-mechanics.md), or
[`docs/a2a-negotiation-walkthrough.md`](docs/a2a-negotiation-walkthrough.md) for
the same ground as one worked negotiation between two agents.

---

## 1. The two processes

Both servers come from the same wrapper,
`google.adk.cli.fast_api.get_fast_api_app`, and **both pass `a2a=True`**. That
matters: an agent in a real network is rarely only a client or only a server. It
is a service other agents call, which in turn calls the services it depends on.
Every interesting property of A2A — task identity, pause and resume, error
propagation — has to survive being chained, and none of it gets exercised until
an agent sits on both sides of the protocol.

```
caller ──A2A──► ops_concierge :8000 ──A2A──► deployment_agent :8001
                server + client              server
```

**Specialist — `servers/remote_agent_server.py`, port 8001.**
With that flag ADK scans `agents_dir` and, for every directory containing an
`agent.json`, attaches two routes:

```
POST  /a2a/deployment_agent                              JSON-RPC endpoint
GET   /a2a/deployment_agent/.well-known/agent-card.json  Agent Card
```

The prefix is the directory name. Everything else the wrapper normally provides
— `/list-apps`, `/run_sse`, session routes, the Dev UI — is still there, on the
same app. That is the practical reason to prefer the wrapper over `to_a2a()`
here: one process serves the protocol *and* a debugger for the agent behind it.

Under the hood ADK builds an `A2aAgentExecutor` per agent, wraps it in the
a2a-sdk's `DefaultRequestHandler` with a task store, and mounts the SDK's
JSON-RPC routes at that prefix.

**Front door — `servers/orchestrator_server.py`, port 8000.**
Same wrapper, same flag, its own `agent.json`, so it is reachable at
`/a2a/ops_concierge` by any A2A client. It is *also* a client: the outbound hop
lives inside the agent, in `RemoteA2aAgent`. It holds no domain tools at all —
its entire job is routing and relaying.

The `/dev-ui` and `/run_sse` surfaces sit on the same app. A browser drives the
agent over HTTP; another agent drives the same agent over A2A; both reach the
same `Runner` and the same session store.

---

## 2. Discovery

`RemoteA2aAgent` resolves its card lazily, on first use, then validates it:

- every URL the card offers must be `https`, **or** `http` on a loopback host;
- every URL must share an origin with the location the card was fetched from.

Both rules are in `RemoteA2aAgent._validate_card_rpc_targets`. They are why
`remote_agents/deployment_agent/agent.json` says
`http://127.0.0.1:8001/a2a/deployment_agent` and why moving this PoC onto a LAN
address means terminating TLS. `tests/test_agent_card.py` pins the invariant so
a card edit cannot silently break the client.

In a2a-sdk 1.x an `AgentCard` is a protobuf message and the RPC target lives in
`supported_interfaces[]`, not a top-level `url`. The 0.3-shaped JSON in
`agent.json` is accepted because the SDK's `parse_agent_card` migrates it.

---

## 3. One request, end to end

```
browser → POST /run_sse (ops_concierge)
  ops_concierge     FunctionCall  transfer_to_agent(agent_name="deployment_agent")
  ops_concierge     FunctionResp  transfer_to_agent
  ── control passes to RemoteA2aAgent ──
                    POST /a2a/deployment_agent  message/stream
    ← Task          status.state = submitted        (task + context id minted)
    ← StatusUpdate  status.state = working
    ← StatusUpdate  working  DataPart function_call  check_release_readiness
    ← StatusUpdate  working  DataPart function_resp  ready=true, risk=high,
                                                     requires_human_approval=true
    ← StatusUpdate  working  DataPart function_call  run_compliance_scan
                             ... task stays WORKING for the whole scan ...
    ← StatusUpdate  working  DataPart function_resp  passed=true
    ← StatusUpdate  working  DataPart function_call  request_change_approval
                             metadata.adk_is_long_running = true
    ← StatusUpdate  working  DataPart function_resp  status=pending_human_approval
    ← StatusUpdate  working  text "Waiting on human approval for CHG-…"
    ← StatusUpdate  status.state = input-required    ← the task parks here
                             DataPart function_call  request_change_approval
                             metadata.adk_is_long_running = true
```

Every ADK event on the remote is converted to an A2A event and streamed. Note
what is *not* hidden: tool calls and tool results cross the boundary as
`DataPart`s with ADK-namespaced metadata (`adk_type: function_call` /
`function_response`), so the calling agent sees the remote's reasoning trace,
not just its final sentence.

### Why the task ends in `input-required`

`google/adk/a2a/executor/a2a_agent_executor_impl.py` runs the ADK agent and
feeds every event through `LongRunningFunctions.process_event`, which pulls out
any function call whose id is in `event.long_running_tool_ids` and remembers it.
When the run finishes, the executor picks the terminal event:

```python
if error_event:                                          final = error_event
elif long_running_functions.has_long_running_function_calls():
                                                         final = <input-required>
else:                                                    final = <completed>
```

So a long-running tool that has not been answered is what makes the task
non-terminal. `LongRunningFunctions._mark_long_running_function_call` also
chooses between `input-required` and `auth-required`: the latter only for ADK's
built-in end-user-credential request. Everything else is `input-required`.

There is no separate "HITL protocol". **A2A HITL is a long-running function call
that has not been answered yet.**

---

## 4. Resuming

The pending call reaches the orchestrator's session as a genuine ADK
`FunctionCall` with its id in `longRunningToolIds`. Answering it means posting a
`functionResponse` part with the same id:

```jsonc
// POST /run_sse on the orchestrator
{"newMessage": {"role": "user", "parts": [{"functionResponse": {
    "id": "fc-9490e820eabb",
    "name": "request_change_approval",
    "response": {"ticket_id": "CHG-95075E85", "approved": true}
}}]}}
```

`RemoteA2aAgent._create_a2a_request_for_user_function_response` sees that the
last session event is a user function response, finds the matching call, and —
crucially — reads `a2a:task_id` / `a2a:context_id` off that call's
`custom_metadata` and stamps them on the outgoing A2A message. That is the whole
mechanism by which a follow-up turn lands on the *same* remote task instead of
starting a new one.

On the server side the executor sees `context.current_task` already exists and
runs `handle_user_input`, which requires the incoming message to carry a
function-response DataPart. The remote's ADK runner then resolves the paused
long-running call and the agent continues from exactly where it stopped.

### Text does not resume a gate

Replying to a paused task with ordinary text is not rejected — it is worse than
that. The agent is simply run again with the text as input, produces no new
long-running call, and the task therefore reaches `completed`. The original gate
is now unanswerable, and the correct function response afterwards is refused
with *"Task … is already completed"*.

`make wrong-resume` demonstrates it;
`test_a_paused_task_answered_with_text_completes_unanswered` pins it. This is
the single most likely way to wire a HITL A2A integration wrongly, because it
looks like it works — a message goes in, the agent replies, the task turns
green — while the approval was never recorded.

---

## 5. Chaining: what crosses a hop and what does not

This is the part a single client/server pair cannot show, and it is the reason
the concierge is an A2A server too.

Run `python scripts/a2a_chain_probe.py run` and the caller sees:

```
turn 1  states           submitted → working → input-required
        this hop's task  88daa805-…
        downstream task  7d7c4db4-…        ← a different task, one hop further in
        ⏸ pending call   request_change_approval (fc-1394…)
```

### Each hop owns its own task

Nothing in A2A shares a task across a hop. The caller's request to
`ops_concierge` creates task A on port 8000; the concierge's `RemoteA2aAgent`
creates task B on port 8001. Two ids, two task stores, two independent
lifecycles. They are correlated only because ADK stamps `a2a:task_id` and
`a2a:context_id` onto the event metadata of the agent that made the downstream
call — which is how the probe can print both, and how a follow-up turn finds
task B again.

That is a property, not an accident. Task B can fail, be cancelled, or be
retried without task A knowing, and an operator on port 8001 sees a task whose
history is exactly what that agent was asked to do — not a slice of somebody
else's conversation.

### A pause mirrors outward

The concierge's own task cannot complete while its downstream task is parked,
and the reason is the same rule that parked the downstream one. When
`RemoteA2aAgent` receives task B in `input-required`, it converts the pending
long-running call back into a real ADK `FunctionCall` with its id in
`long_running_tool_ids`. That event flows through the concierge's *own*
`A2aAgentExecutor`, whose `LongRunningFunctions.process_event` sees an
unanswered long-running call and therefore ends task A in `input-required` too,
carrying the same pending call outward.

The same rule, applied once per hop. Add a third agent and the pause propagates
three hops out for free.

### A resume forwards inward

The caller answers task A with a function-response DataPart. The concierge's
runner routes it to `RemoteA2aAgent` (see §6 — this is where the
`TransferableRemoteA2aAgent` fix earns its keep), which stamps task B's id on a
new A2A message and forwards it. Both tasks move to `working`.

`test_the_same_flow_costs_the_caller_the_same_turns_either_way` in
`tests/test_a2a_chain.py` pins the consequence: entering at the front door and
entering at the specialist take the caller through the same pauses in the same
order. **An A2A hop is transparent to whoever is driving.** That is the property
that makes composing agents worth doing, and the one most worth regression
testing.

### Handles are portable, connections are not

`start_deployment` mints a job id and a `poll_url` two hops in. Both travel
outward in the tool result, so the caller — which never spoke to
`deployment_agent` — can poll that URL directly and hand the terminal result
back through the front door. `test_caller_completes_the_whole_chain_without_
addressing_hop_two` asserts exactly that.

The general rule: anything a downstream agent wants an eventual caller to act on
must be *data in a tool result*, not state held in a connection. A streaming
connection belongs to one hop and dies with it.

---

## 6. Long-running work versus slow work

The PoC deliberately contains both, because they look different on the wire and
people conflate them.

**Slow but synchronous — `run_compliance_scan`.** An ordinary async tool that
awaits for `COMPLIANCE_SCAN_SECONDS`. The task stays `working`, the caller's
stream stays open, and the whole thing is one request. Simple, and fine until
the work outlasts a load balancer's idle timeout.

**Genuinely long-running — `start_deployment`.** A `LongRunningFunctionTool`
that registers a job in `common/jobs.py`, returns a handle immediately, and
lets the task park in `input-required`. The work continues in the background,
outside any agent turn. Something else — `scripts/demo_client.py` here, a queue
worker in reality — polls `/ops/jobs/{id}` and posts the terminal result back as
the function response.

That `/ops` surface is not part of A2A. It is a plain FastAPI route added to the
app `get_fast_api_app` returned, and it exists so the background job is
observable from outside the conversation that started it. Without it, "the job
is still running" would be an assertion nobody could check.

The two are complementary: the same agent can hold a stream open for a scan and
release the connection for a deployment, and the caller can tell the difference
purely from the task state.

---

## 7. Two sharp edges

Both cost real debugging time, so they are documented rather than silently
patched.

### Resumability is not optional

The orchestrator exports an `App` with
`resumability_config=ResumabilityConfig(is_resumable=True)` rather than a bare
`root_agent`. ADK's agent loader checks for a module-level `app` before it looks
for `root_agent`, which is how that config gets applied.

Without it, ADK does not pause an invocation on an unresolved long-running call
and does not keep the paused branch addressable, so the pending approval is
never offered back as something the operator can answer.

### `RemoteA2aAgent` must look transferable

This one is subtle and its failure mode is silence: the resume request returns
HTTP 200 with an empty event stream, and the remote task waits forever.

When a function response arrives, `Runner._find_agent_to_run` decides who gets
it:

1. Route it to the agent that issued the matching call. On the node-runtime path
   taken by a root `LlmAgent`, this check runs against the session *before* the
   incoming message is appended — so the last event is the pending call, not the
   response, and the rule does not fire.
2. Otherwise scan back for the last agent that spoke, accepting it only if
   `_is_transferable_across_agent_tree` approves. That helper rejects any agent
   without a `disallow_transfer_to_parent` attribute. `RemoteA2aAgent` extends
   `BaseAgent`, not `LlmAgent`, so it has no such attribute and is skipped.
3. Fall back to the root agent — which is handed an approval decision for a call
   it never made.

`TransferableRemoteA2aAgent` in `agents/ops_concierge/agent.py` declares the two
transfer flags an `LlmAgent` would carry, which makes step 2 accept the remote
agent and deliver the response to it.

ADK's other supported answer is `mode="task"` on both ends: the remote signals
completion with the `finish_task` tool and a parent coordinator owns the
delegation. That contract is heavier — the remote must be a task-mode ADK agent
and the client must mirror its output schema — and it does not apply to
third-party A2A servers, which are exactly the case A2A exists for. This PoC
stays on plain `transfer_to_agent` delegation for that reason.

---

## 8. Task state reference

| State (0.3 / 1.x) | When ADK emits it |
|---|---|
| `submitted` / `TASK_STATE_SUBMITTED` | New task accepted, before the agent runs. |
| `working` / `TASK_STATE_WORKING` | Agent running; every ADK event streams under this. |
| `input-required` / `TASK_STATE_INPUT_REQUIRED` | An unanswered long-running function call. |
| `auth-required` / `TASK_STATE_AUTH_REQUIRED` | Same, for ADK's end-user-credential request. |
| `completed` / `TASK_STATE_COMPLETED` | Agent finished with nothing pending. |
| `failed` / `TASK_STATE_FAILED` | The run raised, or an ADK event carried an error. |
| `canceled` / `TASK_STATE_CANCELED` | `tasks/cancel`. |

Priority when several updates land in one run is set by
`TaskResultAggregator`: `failed` > `auth-required` > `input-required` >
`working`.

---

## 9. Extending it

- **Add a third agent.** Give it a directory with an `agent.json` and
  `get_fast_api_app(a2a=True)` exposes it automatically — the scan mounts every
  directory under `agents_dir` that carries a card. Point a second
  `TransferableRemoteA2aAgent` at it from whichever agent should delegate to it.
  Nothing about the pause-and-resume mechanics changes; §5 applies once per hop.
  Two things do get harder past a couple of agents: **discovery**, where hard-
  coded URLs in `.env` should become a registry that serves Agent Cards so an
  agent can move or scale without its callers being edited; and **cycles**,
  which this PoC has none of and no protection against — A2A does not stop
  agent A delegating to B delegating back to A, so a network that is a graph
  rather than a line needs a hop budget or a call-path check.
- **Authenticate the hop.** Client side, pass
  `config=A2aRemoteAgentConfig(request_interceptors=[...])` to attach a
  per-invocation token. Server side, pass an `A2aAgentExecutorConfig` carrying
  `execute_interceptors` and read the verified identity in `before_agent` —
  inside ADK's pipeline, so it covers the streaming path that ASGI middleware
  misses.
- **Survive a restart.** Pass `session_service_uri` and `task_store_uri` to
  `get_fast_api_app`, and move `common/jobs.py` behind a real queue.
- **Swap the UI.** The orchestrator is a plain FastAPI app; `/run_sse` is an SSE
  endpoint any frontend can drive. The HITL contract for a custom UI is exactly
  what `scripts/demo_client.py` does: read `longRunningToolIds`, render the
  pending call, post back a `functionResponse` with the same id.
