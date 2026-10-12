# agui/prodlike — ag-ui#2603 in a production-shaped setup

`agui/` proves [ag-ui#2603](https://github.com/ag-ui-protocol/ag-ui/issues/2603)
with a small page and a script that send each run to a chosen pod. This
folder proves it the way it happens in production: nobody picks a pod.

```
 browser ── CopilotKit 1.78 (React) ──► support-desk-web ×2      Next.js + CopilotRuntime
                                              │  HttpAgent: POST /agui, whole history every run
                                              ▼
                                         adk-lb                  nginx, L7 round robin, no affinity
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                  support-desk-…        support-desk-…        support-desk-…   Deployment ×3, ADK + ag-ui-adk
                         └────────────────────┼────────────────────┘
                                              ▼
                                        agui-postgres            ADK sessions + the incidents table
                                              ▲
                                  virtual-users Job              40 CopilotKit-shaped users, optional chaos
```

| Piece | What makes it realistic |
|---|---|
| `web/` | A real CopilotKit app: `<CopilotKit runtimeUrl agent threadId>`, the stock `<CopilotChat>`, and shared state with the agent through `useCoAgent`. The runtime is the documented ADK wiring: `CopilotRuntime` + `HttpAgent` pointed at the load balancer. Two replicas. |
| `k8s/adk-lb*` | An L7 load balancer like an ALB or an ingress: per-request round robin over the ready pods, skips a pod that refuses connections, never re-sends a POST that already reached a pod. |
| `k8s/support-desk.yaml` | A plain 3-replica Deployment with rolling updates, a PodDisruptionBudget and spread across nodes. Same `agui-server` image as `agui/`; only `ag-ui-adk` differs between 0.8.0 and 0.9.0. |
| `agent/support_desk.py` | An on-call assistant whose tool has a **side effect**: `open_incident` writes a row to Postgres and "pages on-call" (3 s). Model calls take 1 s. Every answer is stamped with the pod that wrote it. |
| `loadtest/virtual_users.py` | Users that send byte-for-byte what CopilotKit sends (shapes captured from CopilotKit 1.78), including what CopilotKit does when a stream breaks. `soak.sh --chaos` force-kills a random pod every 8 s, as a node failure or an OOM kill would. |

## What it shows

Measured with this folder's code: three replicas behind the same nginx config,
one Postgres, 30 virtual users × 6 messages, run once on each version. The numbers
vary from run to run; zero against non-zero does not.

| | calm 0.8.0 | calm 0.9.0 | chaos 0.8.0 | chaos 0.9.0 |
|---|---:|---:|---:|---:|
| AG-UI runs | 254 | 254 | 298 | 280 |
| re-runs with nothing new (environment switch) | 74 | 74 | 71 | 68 |
| runs that changed pod within a conversation | 150 | 151 | 169 | 154 |
| **answers to re-runs with nothing new** | **21** | 0 | **18** | 0 |
| **user turns stored twice in the shared session** | **21** | 0 | **22** | 0 |
| **conversations with duplicated work** | **14 / 30** | 0 | **18 / 30** | 0 |
| incidents opened again (on-call paged twice) | 0 | 0 | 0 | 0 |
| user messages that never got a reply | 0 | 0 | 4 | **9** |

And one scenario per row, each run sent to a chosen pod
(`scripts/matrix.sh`, 3 pods):

| scenario | 0.8.0 dup / incidents | 0.9.0 dup / incidents |
|---|---|---|
| A text turn, then a re-run with nothing new on another pod | **1** / 0 | 0 / 0 |
| B incident turn, then a re-run with nothing new on another pod | 0 / 1 | 0 / 1 |
| C text turn, re-run on the pod that answered (sticky routing) | 0 / 0 | 0 / 0 |
| D stream breaks mid-incident, client keeps the tool call (CopilotKit), retry elsewhere | 0 / 1 | 0 / 1 |
| E stream breaks mid-incident, client keeps only the user message, retry elsewhere | **1** / **2** | 0 / 1 |
| F a new message on a third pod | 0 / 0 | 0 / 0 |

Three things follow from it, and the third matters before you upgrade.

**1. With CopilotKit, the trigger is a re-run with nothing new.** A
CopilotKit page that shares state with the agent re-runs it when the user
changes something (`setState` then `useCoAgent().run()`). That run carries the
whole conversation and no new message. On 0.8.0 the pod that receives it checks
its *own memory* for "which messages have I processed"; if a different pod
answered the last question, this pod has never seen it, treats it as new, and
answers it again. The duplicate shows up in the chat, and it is written to the
shared session, where the model will read it on every later turn. With three
replicas and no affinity, roughly half the conversations hit it.

**2. It did not repeat tool calls here, and the reason is CopilotKit.** When
the last turn called a tool, CopilotKit's history holds the tool call and its
result. 0.8.0 keeps its "pending tool calls" list in the *shared* session, so
every pod recognises that turn as history and skips it. Even when a pod dies
in the middle of `open_incident`, CopilotKit gives the orphaned tool call a
synthetic result (`{"status":"error","reason":"missing_terminal_event"}`)
before the user presses Retry, so the retry is history too. Zero repeated
incidents in every run. A client that drops the half-finished turn and retries
with only the user message *does* page on-call twice on 0.8.0 (scenario E in
the matrix below: two incidents on 0.8.0, one on 0.9.0).

**3. 0.9.0 trades duplicates for at-most-once.** 0.9.0 writes "message
processed" into the shared session when the turn *starts*. If the pod then
dies (before or after the tool ran), a Retry of the same message is
recognised as processed, and the user gets no reply at all: 9 such messages
under chaos against 4 on 0.8.0. The incident was opened, but nobody told the
user. After upgrading, make the front end handle a broken run by re-reading
the thread or by sending the message again as a **new** message (a new id),
not by re-running the same one.

**Why sticky sessions hide all of this:** if the load balancer pins a thread
to one pod, that pod's memory is always complete. It stops working the moment
that pod restarts or the deployment scales, which is also when it bites
hardest.

## Run it on the cluster

From the repo root on the Mac, with the lab cluster from `mac-lab/` running
(Phase 2 is enough; see `agui/README.md` step 1 to bring it back after a
restart). Nothing here needs an API key.

### 1. Build and deploy, starting on 0.8.0

```bash
./agui/prodlike/scripts/build.sh
./agui/prodlike/scripts/deploy.sh
```

`build.sh` builds `agui-server:0.8.0`, `agui-server:0.9.0` (the same images
`agui/` uses) and `support-desk-web:dev`, and loads them into kind. The first
build takes a few minutes. `deploy.sh` reuses `agui/`'s Postgres and prints
three `support-desk` pods on `agui-server:0.8.0`, `adk-lb`, and two web pods.

### 2. Use the CopilotKit app

```bash
kubectl -n agents port-forward svc/support-desk-web 3000:80
```

Open http://localhost:3000. In a second terminal, watch the load balancer
send every run to whichever pod is next:

```bash
kubectl -n agents logs deploy/adk-lb -f
```

**The duplicate.** In the chat: send `hello`, then `thanks, that's all for
now`. Then change **Environment** to `staging`. CopilotKit re-runs the agent
with the conversation and nothing new; when that run lands on a pod that did
not answer "thanks…", the chat shows a second answer to it (the answers name
their pod), and the right-hand panel turns red: the question is stored twice
in Postgres. Flip the environment back and forth a few times if the first one
lands on the same pod.

**A pod dying mid-turn.** In the second terminal:

```bash
./agui/prodlike/scripts/kill-busy-pod.sh
```

Then send `checkout-api is down, open an incident`. The script force-kills the
pod while it is paging on-call; CopilotKit shows "terminated". Press **Retry
last run**. The panel lists one incident: CopilotKit's synthetic tool result
kept 0.8.0 from opening it again. Kubernetes has already started a
replacement pod.

### 3. Load test, calm and with chaos

```bash
./agui/prodlike/scripts/soak.sh
./agui/prodlike/scripts/soak.sh --chaos
```

Each run starts a Job of 40 virtual users inside the cluster against
`adk-lb`, prints the table above for this version, and saves it to
`agui/prodlike/reports/0.8.0.json` and `0.8.0-chaos.json`. With `--chaos` a
random `support-desk` pod is force-deleted every 8 seconds while it runs.
`USERS=60 TURNS=8` before the command makes it bigger.

And the deterministic matrix, one scenario per row:

```bash
./agui/prodlike/scripts/matrix.sh
```

### 4. Upgrade to 0.9.0 and run the same again

```bash
./agui/prodlike/scripts/use-version.sh 0.9.0
./agui/prodlike/scripts/soak.sh
./agui/prodlike/scripts/soak.sh --chaos
./agui/prodlike/scripts/matrix.sh
python3 agui/prodlike/loadtest/virtual_users.py --compare agui/prodlike/reports/0.8.0.json agui/prodlike/reports/0.9.0.json agui/prodlike/reports/0.8.0-chaos.json agui/prodlike/reports/0.9.0-chaos.json
```

`use-version.sh` is an ordinary rolling update. In the browser, press **New
conversation** and repeat step 2: the environment switch no longer produces an
answer and the panel stays green (it also shows the ledger entries 0.9.0 keeps
in the shared session). The crash-and-retry now gets no reply at all, which
is finding 3.

Back to the bug: `./agui/prodlike/scripts/use-version.sh 0.8.0`.

### Optional: a real model

The pods run a scripted model (`POC_FAKE_LLM=1`) that answers deterministically
and names its pod. To run on Gemini, put your key in a Secret and switch the
Deployment over:

```bash
kubectl -n agents create secret generic support-desk-model --from-literal=GOOGLE_API_KEY=your-key-here
kubectl -n agents set env deploy/support-desk POC_FAKE_LLM- SUPPORT_DESK_THINK_SECONDS- --from=secret/support-desk-model
```

The audit panel still says which pod wrote each answer (it reads the
`served_by` stamp on each session event, not the text).

## Files

| Path | What it is |
|---|---|
| `agent/support_desk.py` | The ADK app: `check_service_status`, `open_incident` (writes `support_desk_incidents`), the scripted model, the `served_by` stamp, `GET /debug/incidents` |
| `web/` | The CopilotKit app: `app/page.tsx` (chat, environment selector, Retry, audit panel), `app/api/copilotkit/route.ts` (the runtime), `app/api/audit/route.ts`, `Dockerfile` |
| `k8s/` | `support-desk.yaml`, `adk-lb.yaml` + `adk-lb.conf.template`, `web.yaml`, `virtual-users-job.yaml` |
| `loadtest/virtual_users.py` | The virtual users and the report (`--compare` needs only python3) |
| `loadtest/client_matrix.py` | Scenarios A–F, each run sent to a chosen pod |
| `scripts/` | `build.sh`, `deploy.sh`, `use-version.sh`, `soak.sh`, `matrix.sh`, `kill-busy-pod.sh` |

The AG-UI server itself is `agui/server/app.py`, the same as `agui/`; it
serves the support desk because `AGUI_APP` says so.

## Clean up

```bash
kubectl delete -f agui/prodlike/k8s/web.yaml -f agui/prodlike/k8s/adk-lb.yaml -f agui/prodlike/k8s/support-desk.yaml
kubectl -n agents delete configmap adk-lb-conf
kubectl -n agents delete job virtual-users --ignore-not-found
```

Postgres and its Secret belong to `agui/`; its README removes them.
