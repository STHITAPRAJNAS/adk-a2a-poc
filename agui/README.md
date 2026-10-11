# agui/ — the concierge behind an AG-UI front end, and ag-ui#2603 on a real cluster

This folder puts a browser front end in front of the repo's agents using the
**AG-UI** protocol, runs it on the lab cluster (`mac-lab` or `k8s-lab`) with
**two replicas**, and uses that to reproduce
[ag-ui-protocol/ag-ui#2603](https://github.com/ag-ui-protocol/ag-ui/issues/2603)
and then watch the fix from
[release/2026-10-10](https://github.com/ag-ui-protocol/ag-ui/releases/tag/release/2026-10-10)
(`ag_ui_adk` 0.9.0, PR #2932) make it go away.

```
 browser ──AG-UI──► agui-frontend (nginx) ──► agui-server-0 ┐
 (this folder's            /api/pod0, /api/pod1,             ├─► agui-postgres  (ONE shared session store)
  demo page)               /api → either                     │
                                               agui-server-1 ┘
                                                     │
                                                     └──A2A──► deployment-agent (release requests only)
```

## The issue in one paragraph

An AG-UI client keeps the conversation itself and sends the **whole history**
with every run. So the server has to work out which messages are new. Up to
`ag-ui-adk` 0.8.0 it did that with a list of "message ids I have processed",
kept **in each pod's memory**. With two pods sharing one session database, a
run served by the pod that did *not* answer some question treats that question
as new and answers it again: a duplicate user turn and a duplicate answer are
written into the shared session. 0.9.0 stores that list in the session itself
(`_ag_ui_processed_message:*` markers) and re-reads it on every run, so every
pod reaches the same verdict.

It bites when the re-sent history has **nothing new at the end**: a page that
reconnects after a refresh, a dropped connection, or a state sync. The exact
sequence (also the upstream regression test
`test_live_replica_that_missed_a_turn_does_not_answer_it_again`):

| run | served by | the page sends | 0.8.0 | 0.9.0 |
|---|---|---|---|---|
| 1 | pod 0 | `[Q1]` | answers Q1 | answers Q1 |
| 2 | pod 1 | `[Q1, A1, Q2]` | answers Q2 | answers Q2 |
| 3 | pod 0 | `[Q1, A1, Q2, A2]` (reconnect) | **answers Q2 again** — pod 0 never processed Q2 | nothing new, no answer |

Proven before it went in the repo: two server processes over one shared
database (SQLite and Postgres), 0.8.0 stores Q2 twice (9 session events),
0.9.0 stores it once (6 events); the demo page shows the same in Chromium.

## What's here

| Path | What it is |
|---|---|
| `server/app.py` | `ag_ui_adk.ADKAgent.from_app(ops_concierge)` on `POST /agui`, sessions in `AGUI_SESSION_DB`, plus `X-Served-By` (which pod) and `GET /debug/threads/{id}` (what the shared session holds, duplicates flagged) |
| `server/Dockerfile` | one Dockerfile, `--build-arg AG_UI_ADK_VERSION=0.8.0` or `0.9.0`: the only difference between the two images |
| `frontend/` | a small AG-UI chat page (vanilla JS) + nginx that proxies `/api/pod0`, `/api/pod1` (each pod by name) and `/api` (the load-balanced Service) |
| `k8s/` | Postgres, the 2-replica `agui-server` StatefulSet, the front end, and an optional mesh policy |
| `scripts/` | `build.sh`, `deploy.sh`, `use-version.sh`, `repro-in-cluster.sh`, and `repro.py` (the three-run sequence above) |

## Run it on the Mac (after a restart)

Everything below runs from the repo root on the Mac. You need the lab from
`mac-lab/` set up through Phase 2 (agents installed); nothing later is
required.

### 1. Bring the cluster back

Docker Desktop and the kind nodes stop when the Mac restarts. The lab's script
starts Docker Desktop, the nodes, and re-applies the kernel settings:

```bash
cd ~/Developer/local_learning/adk-a2a-poc
git pull origin claude/k8s-a2a-lab
cd mac-lab
export KUBECONFIG="$(pwd)/labs/10-cluster/kubeconfig"
./scripts/start-cluster.sh
kubectl get nodes
kubectl -n agents get pods
cd ..
```

Wait until both agents show `Running`/`1/1`. (On the Windows lab, the same with
`k8s-lab/` instead of `mac-lab/`.)

### 2. Build and load the images

```bash
./agui/scripts/build.sh
```

Three images: `agui-server:0.8.0` (the bug), `agui-server:0.9.0` (the fix),
`agui-frontend:dev`. The first build downloads the agent stack and takes a few
minutes; the second reuses almost all of it.

### 3. Deploy, starting on the broken version

```bash
./agui/scripts/deploy.sh
```

It generates the database password into a Secret, starts Postgres, then two
`agui-server` pods on `ag-ui-adk` 0.8.0 and the page, and prints which image
each pod runs.

### 4. See the bug from a script

```bash
./agui/scripts/repro-in-cluster.sh
```

```
run 1 → agui-server-0  (ag-ui-adk 0.8.0)
run 2 → agui-server-1
run 3 → agui-server-0
  sent     [Q1, A1, Q2, A2]  — a reconnect: the history, nothing new
  answer   'You asked: "Thanks. Is there anything else you can help with?" …'

what the shared session holds  (9 events)
  …
✗ DUPLICATE: 'Thanks. Is there anything else you can help with?' was stored 2 times.
```

### 5. See it in the browser

```bash
kubectl -n agents port-forward svc/agui-frontend 8090:80
```

Open http://localhost:8090, keep **Route each run to: pod 0, pod 1, pod 0, …**,
then:

1. **Send** ("What can you do?") — served by `agui-server-0`.
2. **Send** again (the box is pre-filled with a second question) — `agui-server-1`.
3. **Reconnect** — the page re-runs with its history and nothing new, on
   `agui-server-0`.

The right-hand panel reads the shared session after every run. On 0.8.0 it
turns red: the second question and its answer are stored twice, and the chat
shows a third answer nobody asked for.

Switch the route to **the load balancer** to see it happen the way it does in
production: runs land wherever kube-proxy sends them, so the duplicate appears
whenever a reconnect lands on the pod that didn't answer the last question.

### 6. Apply the fix and prove it

```bash
./agui/scripts/use-version.sh 0.9.0
./agui/scripts/repro-in-cluster.sh
```

```
run 3 → agui-server-0
  answer   '(no new answer)'
what the shared session holds  (6 events)
✓ each question stored once, though two pods served the thread
```

In the browser (re-run the `port-forward` if it dropped during the rollout),
press **New thread** and repeat Send, Send, Reconnect: the reconnect produces
no answer and the panel stays green.

To go back and forth: `./agui/scripts/use-version.sh 0.8.0`.

### Variation: one pod, restarted

The same bug without two replicas: a pod that restarts has an empty memory too.

```bash
kubectl -n agents scale statefulset/agui-server --replicas=1
```

On 0.8.0: Send twice in the page with route **always pod 0**, then
`kubectl -n agents delete pod agui-server-0`, wait for it to be Ready, and press
**Reconnect**. The restarted pod answers the last question again. On 0.9.0 it
doesn't. Scale back with `--replicas=2`.

## Things to know

- **No API key needed.** The pods run the concierge on the repo's scripted
  model (`POC_FAKE_LLM=1`), which quotes the question back so a duplicate is
  easy to spot.
- **Release requests work too**, delegated to `deployment-agent` over A2A with
  the peer card the concierge's Helm release already publishes. If you applied
  lab 40's authorization policies, `deploy.sh` also applies
  `k8s/mesh-allow.yaml` so the `agui-server` identity may call the specialist.
  If lab 82's token check is still on, release requests are refused (the AG-UI
  server sends no token); the #2603 repro never touches the specialist.
- **Why a StatefulSet?** Only so each pod has a stable DNS name the page and
  the script can target. The app is stateless; everything shared is in
  Postgres.
- **Why Postgres?** Two pods on different kind nodes can't share a SQLite file.
  The server also runs on SQLite for local testing:
  `AGUI_SESSION_DB=sqlite+aiosqlite:///…`.
- **The database is an `emptyDir`**: deleting the Postgres pod forgets every
  thread. Fine for this lab.

## Clean up

```bash
kubectl delete -f agui/k8s/frontend.yaml -f agui/k8s/agui-server.yaml -f agui/k8s/postgres.yaml
kubectl delete -f agui/k8s/mesh-allow.yaml --ignore-not-found
kubectl -n agents delete secret agui-db
```
