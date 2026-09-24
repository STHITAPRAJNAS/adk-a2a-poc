# A2A conformance & concepts — where this project sits vs the spec

Measured against the A2A spec (`a2aproject/A2A`), which is now at **1.0** (latest
patch 1.0.1, 2026‑05‑26; 1.0.0 was 2026‑03‑12). This doc records what the sample
adheres to, what it deliberately delegates, and it disambiguates four things that
confuse everyone coming from the raw `a2a-samples`:

1. Why `a2a-samples` writes a big `AgentExecutor` and whether you need one with ADK
2. How ADK decides **Message vs Task**
3. How a client "invokes a skill" (spoiler: it doesn't, directly)
4. What changed 0.3 → 1.0 and what we fixed

---

## 1. Conformance summary

| Spec topic | Requirement | This project | Verdict |
|---|---|---|---|
| Actors | client / opaque server | `ops_concierge` (client) → `deployment_agent` (server) | ✅ |
| Agent Card | identity, url, capabilities, skills | both `agent.json`; now `protocolVersion: "1.0"` | ✅ |
| Transport | HTTP + JSON‑RPC 2.0 (gRPC/REST optional) | JSON‑RPC only | ✅ (one binding is allowed) |
| Messages & Parts | role, messageId, Parts | text Parts + DataParts | ✅ |
| Task lifecycle | submitted→working→input‑required→terminal | exactly this | ✅ |
| Task immutability | terminal task can't restart | proven by `a2a_probe.py wrong-resume` | ✅ |
| contextId | group tasks/messages | carried on every frame | ✅ |
| Streaming (SSE) | `capabilities.streaming`, close on terminal/interrupted | `message/stream`, streaming: true | ✅ |
| Opaque execution | internals hidden | agents are black boxes | ✅ |
| Discovery | `/.well-known/agent-card.json` | served per‑agent at `/a2a/<agent>/.well-known/…` | ⚠️ card `url` is authoritative; not at domain root |
| **Security** | server authenticates every request; card declares `securitySchemes` | **no in‑app auth, no `securitySchemes`** — done at mesh / gateway / OPA | ⚠️ deliberate delegation (see §6) |
| Push notifications | optional webhook | not implemented; `pushNotifications: false` | ➖ honestly not claimed |
| Resubscription / tasks/list / extended card | optional ops | not implemented; not claimed | ➖ |

The core protocol is fully exercised. The one real divergence is security, and it
is a conscious architectural choice, not a bug — see §6.

---

## 2. `AgentExecutor`: why the raw samples write one, and why we don't

If you read `a2aproject/a2a-samples`, every server hand‑writes an **`AgentExecutor`**.
That's not an A2A requirement — it's what the **low‑level `a2a-sdk`** makes you
implement. The sdk gives you the HTTP/JSON‑RPC server, the task store and the SSE
plumbing, but it does **not** know how to run *your* agent. So you implement:

```python
class MyAgentExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue):
        # context.message / context.task_id / context.context_id come from the wire
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)
        updater.submit(); updater.start_work()          # submitted -> working
        result = await my_model_or_logic(context.get_user_input())
        updater.add_artifact([Part(root=TextPart(text=result))])
        updater.complete()                              # -> completed
    async def cancel(self, context, event_queue): ...
```

That block — mapping the request to your logic and emitting the right task‑state
events — is the "lots of custom coding" you noticed. It's the bridge between the
protocol and your agent.

**With ADK you do not write it.** ADK's A2A extension *generates* an
`AgentExecutor` that bridges the ADK `Runner` (your `LlmAgent`, its tools, its
session/state) to A2A automatically. Two entry points:

- `get_fast_api_app(agents_dir=..., a2a=True)` — what this project uses
  (`servers/remote_agent_server.py`). For each dir with an `agent.json`, ADK
  mounts the JSON‑RPC endpoint **and** the card, wiring an ADK‑backed executor
  behind it. No executor code in our repo — grep it: there is none.
- `to_a2a(agent)` — wraps a single agent into an A2A ASGI app (same idea, one
  agent).

So: **the executor still exists at runtime — ADK writes it for you.** The tradeoff
is control. Hand‑writing it (raw sdk) gives you total control of state events and
artifacts; letting ADK generate it gives you the ADK event model mapped onto A2A
(including the long‑running‑call → `input-required` behavior this PoC relies on)
for free. This project wants the ADK behavior, so it uses the wrapper.

---

## 3. Message vs Task — who decides, and how ADK decides

The spec (Life of a Task) says an agent answers a message with **either**:
- a **Message** — a stateless one‑shot reply (no lifecycle), or
- a **Task** — a stateful unit of work with `submitted→working→…→terminal`.

The agent chooses. In **ADK via `get_fast_api_app(a2a=True)` the choice is made
for you: ADK is a task‑generating server.** Every `message/stream` we send comes
back as a **Task** (you saw `submitted → working → input-required` in every probe,
even for a request that ends immediately). ADK does not emit bare `Message`
responses for these invocations — it models the turn as a task so streaming,
state and the HITL pause all have somewhere to live.

Two consequences that explain behavior you already hit:
- **Resume is task‑scoped.** Because it's a Task, a paused invocation is addressed
  by `taskId`, and you resume by sending on that same `taskId` (with the
  function‑response DataPart). A `Message`‑only agent would have nothing to resume.
- **contextId groups turns.** Multiple tasks in one conversation share a
  `contextId`; ADK uses it as the session/LLM‑context key.

(If you *wanted* lightweight Message replies, that's the raw‑sdk / different‑config
path; it isn't what this lab demonstrates.)

---

## 4. "Per‑skill invocation" — the myth to unlearn

The question "how does the client invoke skill X?" has a surprising answer:
**it can't, and it doesn't need to.** Look at the A2A `Message` object — its fields
are `role`, `parts`, `messageId`, `contextId`, `taskId`, `referenceTaskIds`,
`metadata`, `extensions`. **There is no `skillId`.** There is no `invokeSkill`
RPC either — the only message‑sending methods are `message/send` and
`message/stream`.

So skills in the Agent Card are **discovery metadata**, not addressable endpoints:

- The client reads the card's `skills[]` to decide *"is this the right agent for
  my goal?"* and to show a human/router what the agent can do.
- The client then sends a **natural‑language Message** describing what it wants.
- The **agent** (its LLM/logic) maps that message to one of its internal
  skills/capabilities. That mapping is the agent's job, invisible on the wire.

In this project that's literally what happens: `deployment_agent` advertises four
skills (`release_readiness`, `compliance_scan`, `human_change_approval`,
`deployment_execution`), but the client just sends *"deploy checkout-api 2.14.0 to
production"*. The agent's LLM decides to call `check_release_readiness`, then
`run_compliance_scan`, etc. The skills are the *menu*; the message is the *order*;
the agent is the *kitchen*. There's no per‑dish API.

> If you truly need addressable, typed operations, that's what **MCP tools** are
> for (MCP has named tools with schemas). A2A is intentionally
> message‑in/task‑out at the agent boundary. See the spec's "A2A and MCP" topic.
> Our OPA tool‑guard (lab 55) polices the *agent's internal tool calls*, which is a
> different layer from A2A skills — worth not conflating.

---

## 5. What changed 0.3 → 1.0, and what we fixed

The cards previously declared `0.3.0`. 1.0 breaking changes relevant to us:

| 1.0 change | Was | Now (fixed) |
|---|---|---|
| Version is Major.Minor, no patch | `protocolVersion: "0.3.0"` | `"1.0"` |
| `stateTransitionHistory` capability removed | in `capabilities` | removed |
| `supportsAuthenticatedExtendedCard` → `capabilities.extendedAgentCard` | top‑level `false` | removed (defaults false; omit) |
| `A2A-Version` header (empty ⇒ 0.3) | client doesn't send | ADK/RemoteA2aAgent concern; unset ⇒ 0.3 semantics |
| `final` removed from `TaskStatusUpdateEvent` | probe reads `.final` | harmless (reads None) |
| `tasks/list`, PKCE/device‑code OAuth, push‑config rename | not used | not claimed |
| "canceled" US spelling, UUID ids | already handled | ✅ |

Fixed here: both `agent.json` now say `protocolVersion: "1.0"` and drop the two
removed fields. Re‑verify with `scripts/verify-20-agents.sh` (card still served)
after a rebuild.

Note the version‑consistency point: the image pins `a2a-sdk==1.1.2` (a 1.x SDK),
so advertising `1.0` in the card is the *consistent* choice; the old `0.3.0` was a
leftover.

---

## 6. The security divergence (the honest gap)

The spec's model: each server authenticates every request; the card advertises how
via `securitySchemes`/`security`. This project authenticates **nothing inside the
agent** — identity and policy live in the platform:

- **east‑west:** ztunnel mTLS + `AuthorizationPolicy` (lab 40)
- **north‑south:** the gateway + OPA `x-change-ticket` (labs 50/55)

That's a valid, increasingly common "auth at the edge / mesh" pattern, but strictly
it means (a) the cards *should* still declare `securitySchemes` so external clients
know what the edge expects, and (b) an agent reached directly (bypassing the mesh)
has no auth of its own. Closing (a) is the highest‑value next spec‑alignment step:
add a `securitySchemes` block describing the edge auth to both cards.
