# MCP Proving Ground

An interactive website for learning the **Model Context Protocol (MCP), revision 2026-07-28**, by
driving it. Twenty-six lessons in seven tracks, each with the spec's rules in plain language, an
animated lab you operate, a **wire inspector** that shows the exact HTTP start line, headers and
JSON-RPC body of every message, and a short quiz.

Every lesson opens with an **In plain words** summary (an everyday explanation and the words it
uses) and a **Try this in the lab** list next to the lab, from `js/explain.js`.

It is the companion to [`../a2a-proving-ground/`](../a2a-proving-ground/): A2A is agent ↔ agent,
MCP is agent ↔ tools and data. The *MCP vs A2A* lesson puts them side by side.

Everything is taught from the specification in
[`modelcontextprotocol/modelcontextprotocol`](https://github.com/modelcontextprotocol/modelcontextprotocol)
(`docs/specification/2026-07-28/**` and `schema/2026-07-28/schema.ts`). Each lesson names the spec
pages it draws on.

## Run it on your laptop (localhost)

A static site: no build step, no npm install, no backend. It serves on **http://localhost:8766**
(one port up from the A2A site, so both can run at once) and is reachable only from your machine.

| Where | Command (from the repo root) |
|---|---|
| macOS / Linux | `./mcp-proving-ground/serve.sh` |
| Windows (WSL / Ubuntu shell) | `./mcp-proving-ground/serve.sh`, then open http://localhost:8766 in your Windows browser |
| Windows (PowerShell) | `.\mcp-proving-ground\serve.ps1` |

```bash
./mcp-proving-ground/serve.sh 9000
NO_OPEN=1 ./mcp-proving-ground/serve.sh
```

Stop it with **Ctrl+C**. Or by hand:

```bash
cd mcp-proving-ground
python3 -m http.server 8766 --bind 127.0.0.1
```

Opening `index.html` directly (`file://`) also works: no lab here needs a secure context.
Progress is kept only in your browser's `localStorage`.

## What's inside

| Track | Lesson | You play with |
|---|---|---|
| Foundations | One host, many clients, one server each | Follow a request through host → client → server; compare what each server saw (one saw nothing); sort host vs server duties |
| | Tools, resources, prompts | Three buttons, three initiators (model, app, user); a design sorter |
| | Every request stands alone | Build `_meta` field by field (-32602 when a required one is missing); three replicas behind a load balancer in the legacy era (initialize, `Mcp-Session-Id`, sticky routing, a killed replica) vs 2026-07-28 |
| | server/discover and versions | Pick the versions each side speaks; inline send with -32022 recovery vs discover-first; fallback to `initialize` for legacy servers |
| Server features | Tools | A `tools/call` console: protocol errors vs `isError` results, `structuredContent` + `outputSchema`; a model that fixes its own mistake (or can't) |
| | Annotations and approval | A host approval policy over trusted/untrusted servers, including a tool whose `readOnlyHint` lies; the approval card |
| | Handles | A release plan built across three replicas from a shared store; another user's handle; expiry |
| | Resources | List, templates, `completion/complete` as you type, read, -32602 for a missing resource |
| | Prompts | A slash-command box: `prompts/list`, completion for arguments, `prompts/get` with an embedded resource |
| | Caching and pages | A gateway cache leaking an admin's tool list with `cacheScope: public`; paging with an opaque cursor |
| Asking the client | Multi Round-Trip Requests | A rollback that needs confirmation: `input_required`, the retry on another replica, and four ways a client gets it wrong (edited, replayed, re-targeted, expired `requestState`); -32021 |
| | Elicitation | A form renderer driven by `requestedSchema` (accept / decline / cancel, a server asking for a secret); URL mode with a domain-highlighted consent card and a forwarded-link phishing attempt |
| | Deprecated: sampling, roots, logging | Each one through MRTR today; the legacy server-to-client request it replaced |
| Transports & long work | Streamable HTTP | A gateway routing on `Mcp-Name` / `Mcp-Param-Region` and the server catching header/body mismatches (-32020); base64 header values; 202 vs JSON vs SSE vs 404 |
| | stdio | stdin / stdout / stderr panes; a banner on stdout breaking the client; cancel and shutdown |
| | Progress and cancellation | A slow scan with progress; stop; a dropped stream re-issued with a new id and an idempotency key; timeouts with and without a hard maximum |
| | Tasks extension | `io.modelcontextprotocol/tasks`: a 40-minute scan handed back as a task (`resultType: "task"`), polled with `tasks/get`, paused for a waiver answered with `tasks/update`, cancelled cooperatively with `tasks/cancel`, a client restart that loses nothing, -32021 without the capability; a status sorter |
| | Subscriptions | `subscriptions/listen`, the acknowledgement, `subscriptionId`, invalidating a cached tool list; client and server endings |
| Security | Signing in to a remote server | The OAuth flow step by step (401, Protected Resource Metadata, AS metadata, Client ID Metadata Document, PKCE, `resource`, `iss`) and five faults it catches |
| | Scopes and passthrough | `insufficient_scope` step-up with and without the scope union; token passthrough vs the server's own upstream token |
| | Threats | Tool poisoning, rug pull, injection through results, name collision, DNS rebinding: each with and without its defence; a pinned-hash rug-pull detector |
| MCP in production | MCP vs A2A | One release using both protocols (this repo's two agents plus MCP servers); a sorter |
| | Gateways | Merged and namespaced tools, a per-tool policy, an audit log, round-robin across replicas, a shadowing server |
| | Testing | A working **conformance checker**: paste a recorded exchange and it checks ids, `_meta`, headers, `resultType`, cache hints, tool names, MRTR rules |
| Mastery | The full run | Sign-in to rollback with confirmation, progress and a dropped stream, on 1 or 3 replicas, in 2026-07-28 or legacy mode |
| | Final exam | Twenty-one questions, an error-code table, and what 2026-07-28 removed |

Colour means the same thing everywhere: **cobalt** host / MCP client, **spruce** MCP server,
**amber** gateway or proxy, **plum** authorization server, **teal** model or upstream API, **red**
attacker.

## Accuracy notes

- Wire examples follow 2026-07-28: `_meta` keys `io.modelcontextprotocol/protocolVersion`,
  `…/clientCapabilities`, `…/clientInfo`, `…/serverInfo`; `resultType` on every result; `ttlMs`
  and `cacheScope` on discovery, list and read results; `MCP-Protocol-Version`, `Mcp-Method`,
  `Mcp-Name` and `Mcp-Param-*` headers; error codes -32020, -32021, -32022.
- Legacy-era behaviour (handshake, sessions, server-to-client requests on SSE) appears only where a
  lab offers the switch, and is labelled.
- The MCP spec defines no error code for a rejected `requestState`; the labs use -32602.
- Tokens, `requestState` values and signatures are placeholders or simulated for teaching. The
  `release-tools` server and its tools are invented for the labs, modelled on this repo's
  release agent.
- Tasks follow the final tasks extension (SEP-2663, specified in `modelcontextprotocol/ext-tasks`), not the experimental, incompatible 2025-11-25 design; the lesson lists the differences.
- Sampling, roots and logging are shown because existing servers use them; they are deprecated.

## How it's built

Same engine as the A2A site; plain HTML, CSS and classic `<script>` files:

```
index.html                 shell: top bar, syllabus rail, main area
serve.sh / serve.ps1       one-command localhost server
css/proving-ground.css     shared with ../a2a-proving-ground (one addition at the end)
js/core.js                 router, progress, PG.stage, PG.wire, PG.quiz (shared engine)
js/spec.js                 MCP facts: _meta keys, error codes, methods, the release-tools server
js/kit.js                  small helpers: sorter, step list, argument validator
js/lessons/01-…07-*.js     one file per track; each lesson is PG.lesson({ … })
js/explain.js              the plain-words layer for every lesson
js/home.js                 overview page with the looping hero exchange
```
