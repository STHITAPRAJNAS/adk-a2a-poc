# The agent image

One image, both agents. `servers.orchestrator_server` and
`servers.remote_agent_server` are two entrypoints into the same code, so they
ship as one artifact and the Helm chart picks the command.

## Build

```bash
./build.sh                 # build + kind load   (simplest)
./build.sh --registry      # build + push to localhost:5001 (faster rebuilds)
```

The build context is the **repository root**, not this directory — the agent
packages live up there and Docker cannot read above its context.

## `kind load` or a registry?

| | `kind load` | Local registry |
|---|---|---|
| Setup | None | `make registry-up` |
| First build | Same | Same |
| Rebuild | Re-loads the whole image into every node | Pushes changed layers only |
| Feels like production | No | Yes — nodes pull, imagePullPolicy matters |
| `imagePullPolicy` | Must be `IfNotPresent`/`Never` | `Always` works |

Start with `kind load`. Switch when the wait annoys you — which it will, around
the third time you change a line of Python.

## Architecture

On a Windows/WSL2 machine everything is `linux/amd64` and the default is right.
The flag exists because the same image may need rebuilding for an arm64 cluster
(Graviton node groups on EKS are arm64, and cheaper):

```bash
./build.sh --platform arm64
docker image inspect adk-a2a-agent:dev --format '{{.Architecture}}'
```

A mismatch shows up as `exec format error` in a crash loop — which reads like a
corrupt binary rather than a platform problem, so check this first when a pod
will not start.

## The scripted model

The chart sets `POC_FAKE_LLM=1` by default, so the agents run on the
deterministic scripted model from the root repository rather than calling Gemini.

For a platform lab this is the right default and not merely a convenience: it
removes the model as a variable. When an A2A call fails between two pods you
want to be debugging the network, not wondering whether the LLM decided to
phrase something differently this time. Lab 70 turns it off deliberately,
because by then the point *is* the LLM traffic.
