# Lab 70 — Agent Router: governing LLM egress

Labs 40–60 covered traffic *between* agents and *into* the cluster. This one
covers the direction nobody instruments and everybody pays for: the agents'
outbound calls to Gemini.

**Naming.** Agent Router is the project formerly called **Envoy AI Gateway**,
renamed when it joined the Agentic AI Foundation. The CRDs, the API group
(`aigateway.envoyproxy.io`), the Helm charts, the images, the `aigw` CLI and the
`envoy-ai-gateway-system` namespace were all left unchanged, so older docs still
apply verbatim. It is an **egress** gateway for model APIs — it does not do A2A
ingress; that was lab 60.

## Turn the real model on

Every lab so far ran `POC_FAKE_LLM=1`. Now the LLM traffic is the subject, so:

```bash
export KUBECONFIG=$PWD/../10-cluster/kubeconfig

kubectl -n agents create secret generic gemini \
  --from-literal=GOOGLE_API_KEY="$YOUR_KEY"

helm upgrade ops-concierge ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-concierge.yaml \
  --set env.POC_FAKE_LLM=0 --set apiKeySecret.name=gemini
helm upgrade deployment-agent ../../charts/adk-agent -n agents \
  -f ../../charts/adk-agent/values-specialist.yaml \
  --set env.POC_FAKE_LLM=0 --set apiKeySecret.name=gemini
```

Run a negotiation and it now costs money. That is the point of the lab.

## Install

```bash
source ../../versions.env

helm upgrade --install aieg \
  oci://docker.io/envoyproxy/ai-gateway-helm \
  --version "${AI_GATEWAY_VERSION#v}" \
  -n envoy-ai-gateway-system --create-namespace --wait
```

> **Unverified**, like lab 60. Agent Router builds on Envoy Gateway, so lab 50
> must be installed first. Check the current chart reference and any version
> skew against <https://aigateway.envoyproxy.io/docs/> and fix this file if it
> has moved.

## What it buys

The agents currently each hold an API key and call Gemini directly. Every
problem with that is a platform problem:

| Without | With Agent Router |
|---|---|
| Each agent holds a key | Key lives in the gateway; agents hold nothing |
| No idea which agent spends what | Token accounting per caller |
| One agent can exhaust the quota | Per-agent rate and token limits |
| Provider outage = total outage | Failover to a second provider |
| Changing model means redeploying agents | Route change, no redeploy |
| Prompts and responses unlogged | Observable at the platform layer |

The last row is worth sitting with. Once LLM calls go through a gateway, the
platform can see them — which is what you want for cost and debugging, and
exactly what your security team will have opinions about. Decide what you log
before you turn it on, not after.

## The shape

```
  agent pod                Agent Router                  provider
  ─────────                ────────────                  ────────
  GOOGLE_API_KEY=dummy      AIGatewayRoute        ┌──► Gemini
  base URL points at  ──►   + BackendSecurity ────┤
  the gateway               Policy (real key)     └──► fallback
```

`AIGatewayRoute` routes by model name; `AIServiceBackend` defines a provider;
`BackendSecurityPolicy` attaches the credential. The agents are pointed at the
gateway's OpenAI-compatible endpoint and given a dummy key — they stop being
credential holders entirely.

See `aigatewayroute.yaml` for a worked route with a Gemini primary and a
fallback, and the notes there on pointing ADK at a non-default base URL.

## Where this sits

This is the fourth boundary in the lab, and the one people forget:

| Boundary | Tool | Lab |
|---|---|---|
| agent ↔ agent, in-cluster | Istio ambient | 40 |
| outside → cluster, HTTP | Envoy Gateway | 50 |
| outside → cluster, A2A | agentgateway | 60 |
| **cluster → model provider** | **Agent Router** | **70** |

Three of those govern traffic you own. The fourth governs a bill.

→ [Lab 90: real GPUs](../90-cloud-gpu/) *(optional)*
