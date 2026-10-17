# payments/ — agent payments with AP2

The release agent buys burst capacity from **Northwind Compute**, a vendor that
sells through an A2A agent and requires the **Agent Payments Protocol (AP2)**.
Built on the official SDK (`ap2.sdk` from google-agentic-commerce/AP2, v0.2,
pinned to commit `e1ea56d`).

| AP2 role | Here | Module | Port |
|---|---|---|---|
| Shopping Agent | the release agent's wallet code | `shopper.py` (+ `remote_agents/deployment_agent/payments_tools.py`) | (in the agent) |
| Merchant | Northwind's sales agent, an A2A server with AP2 required | `merchant.py` | 8410 |
| Credential Provider | Acme's corporate-card wallet | `credential_provider.py` | 8411 |
| Merchant Payment Processor | Northwind's processor | `processor.py` | 8412 |
| Trusted Surface | Acme's approval page (not an agent) | `trusted_surface.py` | 8413 |

`mesh.py` runs all four in one process with an in-memory network, for tests.

## Run it

```bash
make install-payments
make run-payments
make ap2
```

`make ap2` approves as the person (code `246810`). Without `--code`, the probe
prints the approval link and waits for you to approve in a browser:

```bash
python scripts/ap2_probe.py direct
python scripts/ap2_probe.py --show autonomous --buys eu,us,eu
python scripts/ap2_probe.py --code 246810 attack reprice
```

To let the release agent buy, start it with `AP2_MERCHANT_URL` set:

```bash
AP2_MERCHANT_URL=http://127.0.0.1:8410 POC_FAKE_LLM=1 python -m servers.remote_agent_server
python scripts/ap2_probe.py agent "set spending limits for burst capacity"
```

## The two journeys

**Human present.** The agent gets a merchant-signed checkout (a UCP Checkout
JWT), opens an approval request, and a person approves on the Trusted Surface,
which signs a closed Checkout Mandate (`mandate.checkout.1`, bound to the
checkout hash) and a closed Payment Mandate (`mandate.payment.1`). The wallet
checks the payment mandate and issues a token scoped to that checkout, amount
and five minutes. The merchant checks the checkout mandate and charges the
token through its processor, which authorises it once with the wallet.

**Human not present.** A person approves limits once. The Trusted Surface signs
an open Checkout Mandate (allowed items and quantity, allowed merchant) and an
open Payment Mandate (amount range, payee, budget, recurrence, expiry, card,
and a reference to the open checkout mandate), both carrying the agent's
public key (`cnf`). For each purchase the agent appends a closed mandate signed
with its own key (`kb+sd-jwt`, with `sd_hash`, `aud` and a `nonce` from the
verifier). The merchant and the wallet each evaluate the constraints; the
wallet tracks budget and number of uses, and refuses a second presentation of
an open mandate while one is unresolved.

## SDK details worth knowing

- **Units.** Amounts and `payment.amount_range` are in cents. `payment.budget`
  `max` is in major units (the SDK multiplies by 100).
- **Line-item quantity is an upper bound.** The SDK's max-flow check accepts a
  cart with fewer items than the requirement's `quantity`, and refuses more.
- **Open-mandate `Item`** is `open_checkout_mandate.Item` (id and title only),
  not `types.Item`.
- **`Frequency` enum.** The SDK dumps payloads in python mode, so an
  `AgentRecurrence` fails to serialise; `trusted_surface._OpenPaymentMandate`
  dumps in JSON mode instead.
- **Install with `--no-deps`.** The SDK pins `cryptography==46.0.5` and
  `pytest==9.0.2`; this project keeps newer ones. It needs `jwcrypto` and
  `sd-jwt` (the `payments` extra).

## What is simplified

The approval code stands in for a passkey; keys are generated at start (or
kept in `PAYMENTS_KEY_DIR`) and found through `/.well-known/jwks.json`;
state is in memory; the wallet's JWT stands in for a network token. The
commerce messages (`search`, `create_checkout`, `complete_checkout`) are this
lab's own; AP2 leaves them to a commerce protocol such as UCP.
