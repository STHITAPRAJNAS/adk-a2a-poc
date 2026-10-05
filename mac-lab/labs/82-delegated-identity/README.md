# Lab 82 — Whose request is this? Identity across a hop

Lab 40's mesh already proves **which workload** is calling: the specialist
knows the bytes came from the concierge's service account. It cannot know **on
whose behalf**. Alice and Bob both talk to the concierge; to the specialist,
every request looks like "the concierge". So either everyone the concierge
serves may deploy, or nobody may.

The fix is a credential that rides in the request and names both: the user,
and who is acting for them. Getting it right takes four tries in this lab.

```
                 user token                         exchanged token
 alice ──────►  sub alice                 STS       sub   alice
 (probe)        aud ops_concierge   ───► /token ──► aud   deployment_agent
                scope request deploy               scope release:request release:deploy
                        │                           act   {sub: ops_concierge}
                        ▼                                   │
                  ops-concierge ───────────A2A──────────────┴──► deployment-agent
                  (verifies aud=ops_concierge)                   (verifies aud=deployment_agent,
                                                                  reads sub + act + scope)
```

Run everything from the `k8s-lab` folder (or `mac-lab`), with the probe pod from
lab 80 (`make probe`) and the alias:

```bash
alias probe='kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py'
```

## Step 0 — a token service

The lab token service (`servers/sts_server.py`) issues user tokens (standing in
for your identity provider) and does RFC 8693 token exchange. It needs one
registered client, the concierge, with a secret. Generate one; it goes into two
Secrets and nowhere else:

```bash
S=$(openssl rand -hex 24)
kubectl -n agents create secret generic sts-clients --from-literal=clients="ops_concierge=$S"
kubectl -n agents create secret generic concierge-sts --from-literal=STS_CLIENT_SECRET="$S"
unset S
kubectl apply -f labs/82-delegated-identity/sts.yaml
kubectl -n agents rollout status deploy/sts
```

Log in as Alice and look at what a user token says:

```bash
probe --user alice login
```

```json
{ "iss": "http://sts.agents.svc.cluster.local:8010", "sub": "alice",
  "aud": "ops_concierge", "scope": "release:deploy release:request", … }
```

`aud` is the agent this token is **for**. Bob gets only `release:request`.

## Step 1 — require a token at both agents

```bash
STS=http://sts.agents.svc.cluster.local:8010
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent AGENT_AUTH=jwt STS_URL=$STS
kubectl -n agents set env deploy/ops-concierge STS_CLIENT_ID=ops_concierge --from=secret/concierge-sts
kubectl -n agents rollout status deploy/ops-concierge
kubectl -n agents rollout status deploy/deployment-agent
probe pause
```

```
   error  {"http_status": 401, "body": {"error": "invalid_request", "error_description":
           "a bearer token is required"}, "www_authenticate": "Bearer realm=\"ops_concierge\", …"}
```

The Agent Card is still public (`GET …/.well-known/agent-card.json`), because
a client has to be able to read it to learn *how* to authenticate. Only the
JSON-RPC endpoint is closed.

## Step 2 — Alice calls; the concierge sends nothing downstream

```bash
probe --user alice pause
```

```
   states  submitted → working → completed
✗ expected the task to park at the approval gate, got completed
  Completed with no answer: a downstream hop probably refused or failed.
```

```bash
kubectl -n agents logs deploy/deployment-agent | grep refused
kubectl -n agents logs deploy/ops-concierge | grep "A2A request failed"
```

```
[common.identity] A2A caller refused (invalid_request): a bearer token is required
A2A request failed: HTTP Error 401: Client error '401 Unauthorized' …
```

Alice was verified at the front door, but the concierge's own call to the
specialist carried no credential. Notice again how the failure reached Alice:
as a **completed task with no answer**, not an error (same lesson as lab 80's
stuck `working` task). A downstream refusal is swallowed at the hop.

## Step 3 — the shortcut: forward Alice's token

```bash
kubectl -n agents set env deploy/ops-concierge DOWNSTREAM_AUTH=passthrough
kubectl -n agents rollout status deploy/ops-concierge
probe --user alice pause
kubectl -n agents logs deploy/deployment-agent | grep refused | tail -1
```

```
A2A caller refused (invalid_token): token audience is 'ops_concierge', this agent is 'deployment_agent'
```

Rejected, correctly. Alice's token says `aud: ops_concierge`. A specialist
that accepted it would also accept it from **anyone** who got hold of it,
including any other agent Alice ever called. Audience is what stops a token
issued to one service being replayed at another. Prove the replay fails
directly:

```bash
probe --user alice --entry http://deployment-agent.agents.svc.cluster.local:8001/a2a/deployment_agent pause
```

## Step 4 — exchange it

```bash
kubectl -n agents set env deploy/ops-concierge DOWNSTREAM_AUTH=exchange
kubectl -n agents rollout status deploy/ops-concierge
probe --user alice pause
```

```
   requested by     alice via ops_concierge   ← from the verified token
✓ parked at request_change_approval
```

For each downstream call the concierge now asks the token service: "here is
the token Alice called me with, here is who I am (client secret), I want to
call `deployment_agent`". It gets back a token that is:

| claim | value | why |
|---|---|---|
| `sub` | `alice` | the user does not change across hops |
| `aud` | `deployment_agent` | valid only at the next hop |
| `scope` | at most Alice's ∩ what the concierge may delegate | scopes only shrink |
| `act` | `{"sub": "ops_concierge"}` | who is acting; nests on every further hop |
| `exp` | no later than Alice's token | a hop cannot extend a session |

The token service refuses the classic attacks, and the test suite proves each
one (`tests/test_production.py`): a wrong client secret (`invalid_client`), an
agent exchanging a token that was issued to *someone else* (`invalid_grant`, the
confused-deputy check), a target the agent may not call (`invalid_target`), and
asking for more than the user has (`invalid_scope`).

The approver now sees who really asked, through whom:

```bash
kubectl -n agents exec deploy/deployment-agent -- python scripts/a2a_prod_probe.py --specialist http://127.0.0.1:8001/a2a/deployment_agent tickets
```

```
CHG-9A2F01D7  pending   checkout-api 2.14.0  requested by alice via ops_concierge
```

## Step 5 — Bob may ask, not ship

```bash
probe --user bob pause
```

```
✗ DENIED at request_change_approval: bob via ops_concierge lacks the release:deploy scope required for request_change_approval
```

The decision was made **at the specialist**, about **Bob**, even though the
specialist never talked to Bob. That is the whole point. It happened before any
human was paged.

(ADK still parks the task on the refused call, because a long-running call is
marked pending before callbacks run. Lab 81's cancel cleans it up.)

Or check all of it at once:

```bash
./scripts/verify-82-identity.sh
```

## Where this fits with the mesh and OPA

| Layer | Proves | Lab |
|---|---|---|
| mesh mTLS + AuthorizationPolicy | this connection is from the concierge's workload | 40 |
| bearer token, `aud` | this request is meant for me | 82 |
| `sub` + `act` + `scope` | on behalf of Alice, via the concierge, allowed to deploy | 82 |
| OPA | any rule over all of the above | 55 |

Keep the mesh. A stolen exchanged token is still useless from a pod that is not
the concierge, because ztunnel will not let it connect. With lab 55's OPA guard
on, the policy input now also carries `principal: {subject, actors, scopes}`,
so Rego can say "only Alice deploys checkout-api on Fridays".

Production upgrades this lab leaves out: the concierge authenticating to the
token service with its **Kubernetes service-account token** instead of a client
secret (workload identity; RFC 7523 or SPIFFE), and sender-constrained tokens
(DPoP, or mTLS-bound per RFC 8705) so a token is useless off the connection it
was issued for.

## Undo

The north-south paths from labs 50–60 send no token, so they now get 401. Turn
auth back off:

```bash
kubectl -n agents set env deploy/ops-concierge deploy/deployment-agent AGENT_AUTH- DOWNSTREAM_AUTH-
```

Leave the token service running if you like; nothing calls it while auth is off.
