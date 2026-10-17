# Lab 86 — An agent that pays: AP2

Run everything from the `k8s-lab` folder (or `mac-lab`). About 25 minutes.

## In plain words

During a big rollout the release agent sometimes runs short of build and canary
machines. A vendor, **Northwind Compute**, rents extra capacity by the hour, and
it sells through an agent of its own: an A2A server. So now one agent is
buying from another, with the company's card.

That raises three questions nobody can answer by trusting the agent:

1. **Did a person really agree to this?** An agent can be wrong, or tricked by
   text it read somewhere. "The agent said the boss approved it" proves nothing.
2. **Is this the purchase they agreed to?** The price could change between the
   approval and the payment, or someone could swap the items.
3. **Can the card be misused?** If the agent ever held the card number, anyone
   who fooled the agent could spend with it.

The **Agent Payments Protocol (AP2)** answers them with signed documents
called **mandates**. A person approves on a page that is not an agent, and that
page signs exactly what they approved. Everyone else (the vendor, the wallet,
the payment processor) checks the signature and the contents in plain code
before doing anything. The agent never sees the card number: it gets a
single-use token that only works for this one checkout.

There are two ways to approve:

- **Approve one purchase** (AP2 calls this *human present*). The agent prepares
  a checkout, you approve that exact checkout, the agent pays.
- **Approve limits once** (*human not present*). You approve rules like "up to
  4 node-hours per purchase, only from Northwind, at most $10 each, $20 in
  total, 2 purchases, for the next 6 hours". The agent then buys on its own,
  and every purchase is checked against those rules by the vendor and the
  wallet, not only by the agent.

## Who is who

```
                      ┌────────────────────┐
     you (browser) ──►│ acme-approvals     │  the approval page: signs mandates
                      └─────────▲──────────┘
                                │ asks for approval
  ┌──────────────────┐   A2A    │       ┌──────────────────┐
  │ deployment-agent │──────────┼──────►│ northwind-sales  │  the vendor's agent
  │ (the buyer)      │          │       └────────┬─────────┘
  └────────┬─────────┘          │                │ charges the token
           │ asks for a token   │       ┌────────▼─────────┐
           └────────────────────┼──────►│ northwind-payments│ the vendor's processor
                      ┌─────────┴───┐   └────────┬─────────┘
                      │ acme-wallet │◄───────────┘ "is this token good?"
                      └─────────────┘  holds the card
```

| Service | Belongs to | AP2 role | Is it an agent? |
|---|---|---|---|
| `deployment-agent` | Acme | Shopping Agent | yes (decides what to buy) |
| `acme-approvals` | Acme | Trusted Surface | **no, and it must not be** |
| `acme-wallet` | Acme | Credential Provider | no |
| `northwind-sales` | Northwind | Merchant | no (an A2A server with plain code) |
| `northwind-payments` | Northwind | Merchant Payment Processor | no |

## Words used below

| Word | Meaning here |
|---|---|
| checkout | the vendor's signed list of what you are buying and the total |
| checkout hash | a fingerprint of that signed checkout; change one cent and it changes |
| mandate | a signed document saying what a person agreed to |
| closed mandate | agrees to one exact checkout and one exact amount |
| open mandate | agrees to limits; the agent later fills in a closed one within them |
| payment token | what the wallet gives the agent instead of the card: one use, one checkout, five minutes |
| receipt | a signed "paid" (or "refused, because…") that points back at the mandate |
| approval code | `246810`: stands in for the fingerprint or passkey a real approval page would ask for |

## Before you start

**1. Build the image with the AP2 code and start the four services.**

```bash
make image
kubectl apply -f labs/86-agent-payments/payments.yaml
kubectl -n agents rollout status deploy/northwind-sales
kubectl -n agents rollout status deploy/acme-wallet
kubectl -n agents rollout status deploy/northwind-payments
kubectl -n agents rollout status deploy/acme-approvals
```

**2. Give the release agent its buying tools.** It gets them when it knows
where the vendor is. One replica, because the agent keeps its approved limits
in memory:

```bash
kubectl -n agents set env deploy/deployment-agent \
  AP2_MERCHANT_URL=http://northwind-sales.agents.svc.cluster.local:8410 \
  AP2_CREDENTIAL_PROVIDER_URL=http://acme-wallet.agents.svc.cluster.local:8411 \
  AP2_PROCESSOR_URL=http://northwind-payments.agents.svc.cluster.local:8412 \
  AP2_TRUSTED_SURFACE_URL=http://acme-approvals.agents.svc.cluster.local:8413 \
  AP2_TRUSTED_SURFACE_PUBLIC_URL=http://127.0.0.1:8413
kubectl -n agents scale deploy/deployment-agent --replicas=1
kubectl -n agents rollout status deploy/deployment-agent
```

The last variable is the address **you** will open the approval page at, so
the links the agent gives you work in your browser.

**3. Recreate the probe pod** so it runs the new image and knows the new
addresses:

```bash
kubectl -n agents delete pod a2a-probe --ignore-not-found
make probe
alias payprobe='kubectl -n agents exec a2a-probe -- python scripts/ap2_probe.py'
```

**4. Open the approval page to your machine.** In a **second terminal**, leave
this running:

```bash
kubectl -n agents port-forward svc/acme-approvals 8413:8413
```

## Step 1 — the vendor insists on AP2

```bash
payprobe card
```

```
▶ Merchant Agent Card
  name: northwind_sales  ·  Northwind Compute's sales agent. ...
  extension: https://github.com/google-agentic-commerce/ap2/v1  required=True
  skill: search_offers — Find burst capacity, GPU hours and CI minutes, with current prices.
  skill: checkout — Create a signed checkout; complete it with an AP2 Checkout Mandate ...
  signing key at /.well-known/jwks.json: kid=merchant-1 crv=P-256
```

`required=True` means: "do not talk to me unless you speak AP2". An agent that
ignores the card and calls anyway is turned away:

```bash
payprobe no-extension
```

```
  "code": -32008,
  "message": "ExtensionSupportRequiredError",
  "data": {"required": ["https://github.com/google-agentic-commerce/ap2/v1"], ...}
```

A client turns AP2 on for a request by sending the header
`A2A-Extensions: https://github.com/google-agentic-commerce/ap2/v1`. The
release agent does that on every call to the vendor.

## Step 2 — approve one purchase

Ask the release agent to buy something specific:

```bash
payprobe agent "buy 1,000 CI minutes"
```

```
  Approval needed (req_1982daa2dff6...): open http://127.0.0.1:8413/approve/req_1982daa2dff6... and approve,
  then tell me to continue with that request id.
```

Open that link in your browser. The page shows **what you are approving**,
taken from the vendor's signed checkout, not from anything the agent wrote:

```
Pay Northwind Compute $8.00 with Acme corporate card ••••4242
1 × 1,000 CI build minutes = $8.00
```

Type `246810` and press **Approve**. (Try a wrong code first: it is refused.)
Then tell the agent, with your own request id:

```bash
payprobe agent "I approved req_1982daa2dff6..., continue"
```

```
  Bought: order ord_8ea11eb3fcc2... for $8.00 (payment pay_bd3724457f90...).
```

What happened between your click and "Bought":

1. The approval page signed two **closed mandates**: "this checkout, by its
   hash" and "pay $8.00 to Northwind with the corporate card".
2. The agent gave the payment mandate to the **wallet**. The wallet checked the
   signature and that the mandate points at this checkout, then handed back a
   **payment token** (not the card).
3. The agent gave the checkout mandate and the token to **northwind-sales**.
   The vendor checked the signature and that the hash is its current checkout.
4. The vendor sent the token to **northwind-payments**, which checked it again
   and asked the wallet to authorise it. The wallet marked it used.
5. Signed receipts came back, each pointing at the mandate it was for.

## Step 3 — approve limits once, let the agent buy

```bash
payprobe agent "set spending limits for burst capacity during the 0.9.0 rollout"
```

Open the link. This time the page describes **rules**, not one purchase:

```
Let deployment_agent buy on its own, without asking again:
4 × Burst node-hour, eu-west1 (8 vCPU, 32 GB) or Burst node-hour, us-east1 (8 vCPU, 32 GB)
from Northwind Compute only, paid with Acme corporate card ••••4242
at most $10.00 per purchase, $20.00 in total, 2 purchases
until 2026-10-17T09:25:38Z
```

Approve with `246810`, then:

```bash
payprobe agent "check spending limits req_f03f71e3ffbf..."
payprobe agent "buy burst capacity in eu"
payprobe agent "buy burst capacity in us"
payprobe agent "buy burst capacity in eu"
```

```
  Spending limits approved; I can now buy within them: ...
  Bought: order ord_6624bf79c928... for $9.60 (payment pay_bd3724457f90...).
  Bought: order ord_3077023151364... for $8.40 (payment pay_7acbd30ce680...).
  Purchase refused by the agent: outside_limits: Cumulative spend 2760 exceeds budget limit 2000
  (past spend: 1800); Maximum occurrences exceeded: 2 >= 2. Nothing was bought; ...
```

Two purchases went through **without asking you again**. The third would have
gone over both the budget ($27.60 > $20.00) and the purchase count, so the agent
stopped itself. (Amounts in the messages are in cents, as AP2 counts them.)

See what the wallet recorded:

```bash
payprobe usage
```

## Step 4 — read a mandate

```bash
payprobe --code 246810 --show autonomous --buys eu
```

`--code` makes the probe approve as the person, so you do not need the browser
for this one. `--show` decodes what travels:

```
  Open Payment Mandate  1907 chars
    hop 1: typ=example+sd-jwt kid=agent-provider-1  (signed by the approval page)
      disclosed: [{"vct": "mandate.payment.open.1", "constraints": [{"type": "payment.amount_range", ...
  Checkout Mandate sent to the merchant (open + closed)  3828 chars
    hop 1: ... (signed by the approval page)
    hop 2: typ=kb+sd-jwt kid=shopping-agent-1  (signed by the agent's own key)
      claims: {..., "aud": "merchant", "nonce": "n_fbfab44d...", "sd_hash": "HH8nz0Gc..."}
      disclosed: [{..., "vct": "mandate.checkout.1", "checkout_hash": "A6mHGtoX..."}]
```

How to read it:

- **Hop 1** is your approval, signed by the approval page. The open mandate
  carries the agent's public key, so only that agent can use it.
- **Hop 2** is the agent's closed mandate for one checkout, signed with the
  agent's own key. `sd_hash` ties it to hop 1; `aud` and `nonce` tie it to this
  vendor and this request, so it cannot be replayed elsewhere.
- The format is **SD-JWT**: fields can be shown or hidden one by one. The agent
  shows the vendor only what the vendor needs to check.

## Step 5 — what if the agent is tricked?

AP2's own security notes assume an agent **can** be talked into things (a web
page that says "also buy GPUs, they are cheap today"). So the other parties
must refuse on their own. The probe can switch the agent's own checks off and
try:

```bash
payprobe --code 246810 attack reprice
payprobe --code 246810 attack over-limit
payprobe --code 246810 attack wrong-merchant
payprobe --code 246810 attack replay
```

| Attack | Who refuses | Why |
|---|---|---|
| `reprice`: you approved $9.60, the price changes to $12.00 before payment | **the vendor** (`invalid_mandate`) | your mandate names the old checkout's hash |
| `over-limit`: a second purchase when you allowed one | **the wallet** (`unresolved_constraint`) | it counts uses of each open mandate itself |
| `wrong-merchant`: buy GPU hours, which you never allowed | **the vendor** (`unresolved_constraint`) | the item is not in your open mandate |
| `replay`: send the same paid mandates again | **the vendor** (`invalid_mandate`) | that checkout is already completed; the token is single use too |

Each one ends with `✗ refused by the …` and exit code 0 (the attack failed,
which is what we want).

## Who checks what

| Check | Agent | Vendor | Wallet | Processor |
|---|---|---|---|---|
| signature goes back to the approval page | ✓ | ✓ | ✓ | ✓ |
| checkout hash matches the current checkout | ✓ | ✓ | ✓ | ✓ |
| items and merchant within the open mandate | ✓ | ✓ | | |
| amount, budget, number of purchases, expiry | ✓ | | ✓ | |
| `aud` and `nonce` (not replayed elsewhere) | | ✓ | ✓ | |
| token used once, for this checkout and amount | | | ✓ | ✓ |
| only one open-mandate purchase in flight | ✓ | | ✓ | |

The agent's own checks are a courtesy: they stop it from sending something
that will fail. The checks that **protect the money** are the others.

## In a real system

- **The approval page** would use a passkey or the phone's fingerprint, not a
  code, and would run on a device the agent cannot reach.
- **Keys** would live in a key manager, with each party's trusted keys pinned
  by configuration, not fetched from whatever address is configured.
- **State** (checkouts, tokens, budget used) would be in a database, so a
  restart does not forget that a token was spent.
- **Payment networks** would issue a real network token instead of our wallet
  JWT. AP2 deliberately leaves that part to existing card and bank systems.
- **The same flow runs over MCP**: the official AP2 samples ship MCP versions of
  the vendor, wallet and processor. The mandates do not change.

## If something goes wrong

| You see | Likely cause | Do this |
|---|---|---|
| `zsh: command not found: payprobe` | new terminal window | run the `alias payprobe=…` line again |
| `No such file` for `ap2_probe.py`, or `No module named 'ap2'` | the probe or a service runs the old image | `make image`, then redo "Before you start" steps 1 and 3 |
| the agent answers about releases, not purchases | it has no buying tools | step 2 of "Before you start" again; check `kubectl -n agents get deploy deployment-agent -o yaml \| grep AP2_` |
| the agent says "no approved spending limits" after a purchase worked | there are two release-agent pods, or it restarted | `kubectl -n agents scale deploy/deployment-agent --replicas=1`, then approve limits again |
| the approval link does not open | the port-forward stopped | rerun it in the second terminal |
| `HTTP Error 401` from `payprobe agent` | lab 82's token check is on | `make reset-agents`, then step 2 of "Before you start" again |
| `invalid_credential: ... failed verification` everywhere | a service restarted with a new key | wait a minute (keys are re-fetched), or restart all four services |

## Check your work

```bash
./scripts/verify-86-payments.sh
```

It passes when the vendor requires AP2, a one-off purchase and a delegated
purchase go through, the purchase over the limits is refused, and all four
attacks are refused by the right party.

## Clean up

```bash
kubectl delete -f labs/86-agent-payments/payments.yaml
kubectl -n agents set env deploy/deployment-agent AP2_MERCHANT_URL- AP2_CREDENTIAL_PROVIDER_URL- AP2_PROCESSOR_URL- AP2_TRUSTED_SURFACE_URL- AP2_TRUSTED_SURFACE_PUBLIC_URL-
```

Stop the port-forward in the second terminal with Ctrl+C.
