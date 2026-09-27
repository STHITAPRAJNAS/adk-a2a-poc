# A2A Proving Ground

An interactive website for learning the **Agent2Agent (A2A) protocol, specification 1.0**, by
driving it. Sixteen lessons, each with the spec's rules in plain language, an animated lab you
operate, a **wire inspector** that shows the exact HTTP start line, headers and JSON body of every
exchange, and a short quiz.

Everything is taught from the primary sources in
[`a2aproject/A2A`](https://github.com/a2aproject/A2A): `docs/specification.md` and
`specification/a2a.proto` (1.0.x), plus the `docs/topics/*` guides. Section numbers are cited on
every lesson so you can check the claim.

## Run it on your laptop (localhost)

It's a static site: no build step, no npm install, no backend. You only need a tiny local web
server, and Python 3 (preinstalled on macOS and most Linux) is enough. Everything below serves
on **http://localhost:8765** and is reachable only from your own machine.

### One command

From the repo root:

| Where | Command |
|---|---|
| macOS / Linux | `./a2a-proving-ground/serve.sh` |
| Windows (WSL / Ubuntu shell) | `./a2a-proving-ground/serve.sh`, then open http://localhost:8765 in your Windows browser |
| Windows (PowerShell) | `.\a2a-proving-ground\serve.ps1` |

The script starts the server and opens your browser. Options:

```bash
./a2a-proving-ground/serve.sh 9000        # different port
NO_OPEN=1 ./a2a-proving-ground/serve.sh   # don't open a browser
```
```powershell
.\a2a-proving-ground\serve.ps1 -Port 9000 -NoOpen
# if scripts are blocked:
powershell -ExecutionPolicy Bypass -File .\a2a-proving-ground\serve.ps1
```

Stop the server with **Ctrl+C**.

### Or by hand

```bash
cd a2a-proving-ground

python3 -m http.server 8765 --bind 127.0.0.1        # macOS / Linux / WSL
py -m http.server 8765 --bind 127.0.0.1             # Windows PowerShell

npx --yes serve -l 8765 .                           # if you prefer Node
docker run --rm -p 8765:80 -v "$PWD":/usr/share/nginx/html:ro nginx:alpine   # or Docker
```

Then browse **http://localhost:8765**.

### Why a server instead of double-clicking `index.html`?

Opening the file directly (`file://…`) works for almost everything. Two labs need the browser's
WebCrypto API, which only runs in a secure context (`https://` or `http://localhost`): real ES256
card signing in *Trusting a card*, and the PKCE hash in *Authentication*. Serving on localhost
makes both work.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Address already in use` | Another app has the port. Use `./serve.sh 9000` (or `-Port 9000`). |
| WSL: Windows browser can't reach it | `serve.sh` binds `0.0.0.0` inside WSL so localhost forwarding works. If it still fails, run `wsl --shutdown` in PowerShell and try again, or use `serve.ps1` from Windows. |
| Fonts look plain | The page uses Google Fonts. Offline, it falls back to system fonts; everything else works. |
| Want to view it on your phone | `BIND=0.0.0.0 ./serve.sh`, then open `http://<laptop-ip>:8765`. Anyone on the same Wi-Fi can reach it while it runs, and the two WebCrypto labs won't work there because it isn't localhost or HTTPS. |
| Start the course over | *Final checkpoint* → **Reset my progress**. Progress is kept only in your browser's `localStorage`. |

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
serve.sh / serve.ps1       one-command localhost server (macOS/Linux/WSL, Windows)
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
