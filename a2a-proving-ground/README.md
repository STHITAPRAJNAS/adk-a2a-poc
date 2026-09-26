# A2A Proving Ground

An interactive website for learning the **Agent2Agent (A2A) protocol, specification 1.0**, by
driving it. Sixteen lessons, each with the spec's rules in plain language, an animated lab you
operate, a **wire inspector** that shows the exact HTTP start line, headers and JSON body of every
exchange, and a short quiz.

Everything is taught from the primary sources in
[`a2aproject/A2A`](https://github.com/a2aproject/A2A): `docs/specification.md` and
`specification/a2a.proto` (1.0.x), plus the `docs/topics/*` guides. Section numbers are cited on
every lesson so you can check the claim.

## Run it

No build step, no dependencies.

```bash
# simplest: open the file
open a2a-proving-ground/index.html          # macOS
xdg-open a2a-proving-ground/index.html      # Linux

# recommended: serve it, so the signature lab can use WebCrypto (needs a secure context)
cd a2a-proving-ground && python3 -m http.server 8765
# then browse http://localhost:8765
```

Progress (visited / passed lessons) is kept in your browser's `localStorage` only.

## What's inside

| Track | Lesson | You play with |
|---|---|---|
| Foundations | Actors and the three layers | Opacity toggle; data model / operations / bindings explorer; the two-hop chain from this repo |
| | The Agent Card | **Live 1.0 linter** (errors, warnings, spec refs), visual card, **0.3 → 1.0 migrator** loaded with this repo's old card |
| Discovery & trust | Finding an agent | Well-known URI vs registry vs direct config; `supportedInterfaces` selection rule; ETag / `If-None-Match` / 304 caching |
| | Trusting a card | **Real ES256 signing in the browser** with JCS canonicalization; tamper, reformat, and attacker re-sign tests; `GetExtendedAgentCard` (-32004 / -32007 / 401) |
| Conversation | Skills are a menu, not an API | Plain-words requests routed to skills inside the agent; why there is no `skillId` |
| | Messages, Parts and Artifacts | Part builder (text / data / url / raw, file upload), `ContentTypeNotSupportedError`; Message-vs-Artifact sorter; chunked `artifactUpdate` |
| | The life of a task | Clickable state machine with all eight states, terminal immutability errors, refinement via `referenceTaskIds`; message-only vs task-generating vs hybrid agents |
| | Polling, streaming, push | A race of all three on one job: wasted polls, a dropped stream re-attached with `SubscribeToTask`, an authenticated webhook |
| Security | Authentication | Seven schemes animated end to end (API key, Bearer, OAuth2 client credentials, authorization code + **real PKCE**, device code, OIDC, mTLS); 401 vs 403 tester; token-in-payload anti-pattern |
| | Authorization and in-task auth | Tenant scoping (`ListTasks`, TaskNotFound instead of 403); scope-gated skills; a chained `AUTH_REQUIRED` flow; webhook SSRF guard |
| Infrastructure | One protocol, three bindings | Any operation rendered for JSON-RPC, gRPC and HTTP+JSON; `A2A-Version` negotiation and `VersionNotSupportedError`; error decoder |
| | Proxies and gateways | L4 mesh vs HTTP proxy vs A2A-aware gateway: what each sees, logs and can enforce; idle timeouts and buffering vs SSE; replicas and the task store; rewriting the card URL |
| | Extensions | Declare / activate (`A2A-Extensions`) / metadata by URI; `ExtensionSupportRequiredError`; version mismatch |
| | A2A and MCP | Sorting game and a layered animation |
| Mastery | The proving ground | A full production deploy end to end with **eight injectable faults**, two of which a good client self-heals |
| | Final checkpoint | Twelve questions across every track, progress table, cheat sheet |

Colour means the same thing everywhere: **cobalt** client agent, **spruce** remote agent,
**amber** gateway / proxy, **plum** authorization server, **teal** registry or store. Task states
have their own palette.

## Accuracy notes

- Wire examples use 1.0 ProtoJSON shapes: PascalCase JSON-RPC methods (`SendMessage`), enum names
  (`TASK_STATE_WORKING`, `ROLE_USER`), flattened Parts (`{"text": …}`), `supportedInterfaces`,
  `securitySchemes` wrapped by type, and `securityRequirements`.
- One discrepancy in the sources is surfaced rather than hidden: `SubscribeToTask`'s HTTP+JSON
  mapping is `GET /tasks/{id}:subscribe` in `a2a.proto`'s annotation but `POST` in the spec's §5.3
  table.
- Tokens, signatures in the wire logs and the "agent reasoning" in the skills lab are simulated for
  teaching. The card-signing lab and the PKCE hash use real cryptography (WebCrypto).

## How it's built

Plain HTML, CSS and classic `<script>` files, so it also works from `file://`:

```
index.html                 shell: top bar, syllabus rail, main area
css/proving-ground.css     tokens (light + dark), layout, components
js/core.js                 router, progress, PG.stage (animated actors),
                           PG.wire (wire inspector), PG.quiz
js/spec.js                 methods, errors, states, sample cards, schemes (single source of facts)
js/lessons/01-…06-*.js     one file per track; each lesson is PG.lesson({ … })
js/home.js                 overview page with the looping hero exchange
```

To add a lesson, call `PG.lesson({ id, track, title, thesis, refs, brief, lab(bench, api), quiz })`
in the relevant track file. `lab` receives the right-hand column and an `api.alive()` guard that
turns false when the reader navigates away, so animations stop cleanly.
