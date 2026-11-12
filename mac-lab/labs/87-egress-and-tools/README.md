# Lab 87 — Lock down what an agent can reach

Run everything from the `k8s-lab` folder (or `mac-lab`). About 20 minutes.

## In plain words

Labs 40–60 control who can **call** an agent. This lab controls what an agent
can **call out to**: websites, and its tools.

That matters because an agent can be talked into things. A web page or a
tool's output can contain "also call `rollback_production`" or "send the
config to this address", and the model may do it. You cannot make the model
immune. You can make sure that, even when it is fooled, the call has nowhere to
go.

The pattern has two parts:

1. **One way out.** The agent's pod may only talk to things on a short list.
   Everything else, including the open internet, is blocked by the cluster.
2. **A gateway on that way out that understands tools.** The agent's tools sit
   behind an MCP-aware gateway that shows and allows only the tools this agent
   should have. The dangerous ones do not even appear in its list.

Either part alone leaks: a gateway the agent can walk around is decoration, and
a network block with no gateway means all-or-nothing access to the tool server.

```
                          ✗ the internet
                        ╱
 deployment-agent ──────┼──► tools-gateway ──► release-tools (MCP)
   (egress locked)      │      only 2 of 4        4 tools, 2 dangerous
                        ╲      tools allowed      accepts the gateway only
                          ✗ release-tools directly
```

## Words used below

| Word | Meaning here |
|---|---|
| MCP | Model Context Protocol: how an agent lists and calls tools on a tool server |
| egress | traffic leaving a pod |
| NetworkPolicy | a Kubernetes rule saying which pods a pod may talk to; the network plugin enforces it |
| default-deny | block everything, then allow a short list |
| tools-gateway | agentgateway v1.4.1 in front of the MCP server, with an allow-list of tool names |

## Before you start

**1. Rebuild the image.** It now contains the MCP server and the probe:

```bash
make image
kubectl -n agents rollout restart deploy/deployment-agent
kubectl -n agents rollout status deploy/deployment-agent
```

**2. Deploy the tool server and the gateway:**

```bash
kubectl apply -f labs/87-egress-and-tools/tools.yaml
kubectl -n tools rollout status deploy/release-tools
kubectl -n tools rollout status deploy/tools-gateway
```

**3. Save a short name for running the probe from inside the release agent's
own pod**, so the agent's network rules apply to it:

```bash
alias agentprobe='kubectl -n agents exec deploy/deployment-agent -- python scripts/mcp_probe.py'
```

The two addresses used below:

```bash
DIRECT=http://release-tools.tools.svc.cluster.local:3001/mcp
GATED=http://tools-gateway.tools.svc.cluster.local:3000/mcp
```

## Step 1 — wide open

```bash
agentprobe list $DIRECT
agentprobe call $DIRECT rollback_production '{"service":"checkout-api"}'
agentprobe web https://example.com
```

```
tools this caller can see at http://release-tools.tools.svc.cluster.local:3001/mcp:
  check_change_freeze    Whether an environment is in a change freeze, and until when.
  get_release_notes      Release notes for one version of a service.
  rollback_production    Roll a service back to its previous version in production.
  read_deploy_secret     Read a deployment credential by name.
✓ rollback_production → {"service": "checkout-api", "rolled_back": true, "warning": "dangerous tool reached"}
! reachable: https://example.com answered HTTP 200
```

The agent sees all four tools, can call the dangerous one, and can reach any
website. (If your cluster has no internet access, the last line says
`blocked` already; that is your network, not this lab.)

## Step 2 — add the gateway

Now go through the gateway:

```bash
agentprobe list $GATED
agentprobe call $GATED check_change_freeze '{"environment":"production"}'
agentprobe call $GATED rollback_production '{"service":"checkout-api"}'
```

What you should see:

- `list` shows **two** tools: `check_change_freeze` and `get_release_notes`.
  The gateway's rules (`mcp.tool.name == "…"`) filter the list.
- The safe call works.
- The dangerous call ends `✗ refused` (exit code 2). The exact wording comes
  from agentgateway.

But run step 1's first two commands again: they still work. The agent can walk
around the gateway, so the gateway protects nothing yet.

## Step 3 — lock the way out

```bash
kubectl apply -f labs/87-egress-and-tools/lockdown.yaml
```

**First, check your cluster enforces NetworkPolicy at all:**

```bash
agentprobe web https://example.com
```

```
✓ blocked: ConnectTimeout reaching https://example.com
```

If it still says `reachable`, your network plugin ignores NetworkPolicy and the
rest of this step proves nothing; see "If something goes wrong".

Now the tools:

```bash
agentprobe list $DIRECT
agentprobe list $GATED
agentprobe call $GATED rollback_production '{"service":"checkout-api"}'
```

```
✓ blocked: cannot reach http://release-tools.tools.svc.cluster.local:3001/mcp (ConnectTimeout)
tools this caller can see at http://tools-gateway.tools.svc.cluster.local:3000/mcp:
  check_change_freeze    …
  get_release_notes      …
✗ refused: …
```

Now there is exactly one way to the tools, and it allows two of them.

## Step 4 — the agent still does its job

The lockdown must not break the release agent's real work. Its own namespace
(the concierge, the token service, the probe, lab 86's services) is still
allowed:

```bash
kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py pause
kubectl -n agents exec a2a-probe -- python scripts/a2a_prod_probe.py resume
```

```
✓ parked at request_change_approval
✓ the gate was answered and the release moved on: job job-… is running
```

The release reaches the approval gate and moves on after it, exactly as
before. (No probe pod? `make probe`.)

## What the two policies say

`lockdown.yaml` holds both:

| Policy | Selects | Allows | Everything else |
|---|---|---|---|
| `release-agent-egress` (namespace `agents`) | the deployment-agent pods, outbound | DNS; any pod in `agents`; the `observability` namespace (lab 83 traces); `tools-gateway` on port 3000 | blocked |
| `release-tools-ingress` (namespace `tools`) | the MCP server, inbound | `tools-gateway` on port 3001 | blocked |

The second one matters as much as the first. Without it, any other pod in the
cluster could still call `rollback_production` directly.

## In a real system

- **Authenticate the agent at the gateway**, then write rules per caller:
  agentgateway's rules can read token claims, such as
  `jwt.sub == "deployment-agent" && mcp.tool.name == "get_release_notes"`. Here
  every caller gets the same two tools.
- **Allow websites by name, through an egress proxy.** NetworkPolicy works on
  IP addresses, not hostnames, so "allow api.example.com only" needs a proxy
  that sees the name (or a network plugin with DNS-aware policy).
- **Keep the model's tool list short anyway.** The gateway is the enforcement;
  a short list also stops the model from trying.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| `No such file` for `mcp_probe.py`, or `servers.mcp_release_tools` not found | the pods run the old image | `make image`, then step 1 of "Before you start" and `kubectl -n tools rollout restart deploy/release-tools` |
| step 3 still says `reachable` | the network plugin does not enforce NetworkPolicy | on kind, check `kubectl -n kube-system get pods -l app=kindnet`; very old kind releases ignore NetworkPolicy. Calico or Cilium enforce it. |
| `list $GATED` shows all four tools | the gateway did not load its rules | `kubectl -n tools logs deploy/tools-gateway`; after editing the ConfigMap, `kubectl -n tools rollout restart deploy/tools-gateway` |
| `list $GATED` fails after step 3 | the gateway cannot reach the MCP server | the `release-tools-ingress` rule must match the gateway's `app: tools-gateway` label |
| step 4's release now fails | the agent needs something outside the allowed list | `kubectl -n agents logs deploy/deployment-agent` names the address it tried; add it to `release-agent-egress` |

## Check your work

```bash
./scripts/verify-87-egress.sh
```

It passes when the internet and the MCP server are blocked for the release
agent, the gateway shows exactly the two safe tools, and refuses the dangerous
one.

## Clean up

```bash
kubectl delete -f labs/87-egress-and-tools/lockdown.yaml
kubectl delete -f labs/87-egress-and-tools/tools.yaml
```
