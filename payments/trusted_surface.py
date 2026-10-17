"""Trusted Surface (TS): Acme's approval page, in the Trusted Agent Provider model.

AP2 requires this role to be **non-agentic**: deterministic code that shows a
person exactly what they are approving and signs only after they consent. No
LLM touches it. The agent asks for approval; the person approves here; the
agent collects the signed mandates.

Two kinds of request:

``direct`` (human present)
    The agent sends a merchant-signed checkout JWT and the payment details. The
    page verifies the merchant's signature and renders the items and total
    *from the checkout JWT itself*, not from anything the agent says. On
    approval it signs a closed Checkout Mandate (``mandate.checkout.1``) and a
    closed Payment Mandate (``mandate.payment.1``) bound to the checkout hash.

``delegation`` (human not present)
    The agent asks for limits it may act within. On approval the page signs an
    open Checkout Mandate (``mandate.checkout.open.1``) and an open Payment
    Mandate (``mandate.payment.open.1``), both carrying the agent's public key
    in ``cnf`` so only that agent can use them, and linked by
    ``payment.reference``.

The approval code stands in for the biometric or passkey step a real surface
would use (``TS_APPROVAL_CODE``, a demo value by default).
"""

from __future__ import annotations

import html
import json
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.open_checkout_mandate import (
    AllowedMerchants,
    Item,
    LineItemRequirements,
    LineItems,
    OpenCheckoutMandate,
)
from ap2.sdk.generated.open_payment_mandate import (
    AgentRecurrence,
    AllowedPayees,
    AllowedPaymentInstruments,
    AmountRange,
    Budget,
    ExecutionDate,
    Frequency,
    OpenPaymentMandate,
    PaymentReference,
)
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.generated.types.amount import Amount
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
from ap2.sdk.jwt_helper import verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.sdjwt import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url

from payments.core import (
    CATALOG,
    CURRENCY,
    MANDATE_TTL_SECONDS,
    TrustStore,
    dollars,
    jwks_document,
    load_or_create_key,
    new_id,
    now,
)


class _OpenPaymentMandate(OpenPaymentMandate):
    """The SDK dumps payloads in python mode, which leaves ``Frequency`` as an enum
    the JSON encoder cannot handle; dump in JSON mode instead."""

    def model_dump(self, **kw: Any) -> dict[str, Any]:
        kw.setdefault("mode", "json")
        return super().model_dump(**kw)


DEFAULT_APPROVAL_CODE = "246810"  # demo stand-in for a biometric / passkey step


class TrustedSurface:
    def __init__(self, *, trust: TrustStore, approval_code: str | None = None):
        self.key = load_or_create_key("agent-provider")
        self.trust = trust
        self.approval_code = approval_code or os.environ.get(
            "TS_APPROVAL_CODE", DEFAULT_APPROVAL_CODE
        )
        self.requests: dict[str, dict[str, Any]] = {}
        self.client = MandateClient()

    # ── creating requests (called by the agent) ────────────────────────────

    def create_direct(self, body: dict[str, Any]) -> dict[str, Any]:
        checkout_jwt = body["checkout_jwt"]
        # Render from the merchant-signed checkout, never from the agent's words.
        checkout = verify_jwt(checkout_jwt, self.trust.key("merchant"))
        checkout_hash = compute_sha256_b64url(checkout_jwt)
        total = next(t["amount"] for t in checkout["totals"] if t["type"] == "total")
        req = {
            "id": new_id("req"),
            "kind": "direct",
            "status": "pending",
            "created": now(),
            "checkout_jwt": checkout_jwt,
            "checkout_hash": checkout_hash,
            "display": {
                "merchant": checkout["merchant"]["name"],
                "lines": [
                    {
                        "title": li["item"]["title"],
                        "quantity": li["quantity"],
                        "amount": li["totals"][-1]["amount"],
                    }
                    for li in checkout["line_items"]
                ],
                "total": total,
                "currency": checkout["currency"],
                "instrument": body["instrument"]["description"],
            },
            "payee": checkout["merchant"],
            "instrument": body["instrument"],
            "amount": total,
        }
        self.requests[req["id"]] = req
        return self._public(req)

    def create_delegation(self, body: dict[str, Any]) -> dict[str, Any]:
        limits = body["limits"]
        skus = [s for s in limits["skus"] if s in CATALOG]
        if not skus:
            raise ValueError("no known SKUs in the requested limits")
        hours = int(limits.get("valid_hours", 12))
        req = {
            "id": new_id("req"),
            "kind": "delegation",
            "status": "pending",
            "created": now(),
            "agent_jwk": body["agent_jwk"],
            "agent_name": body.get("agent_name", "agent"),
            "limits": {
                "skus": skus,
                "quantity": int(limits["quantity"]),
                "max_per_purchase": int(limits["max_per_purchase"]),
                "budget": int(limits["budget"]),
                "max_purchases": int(limits.get("max_purchases", 2)),
                "merchant": limits["merchant"],
                "instrument": limits["instrument"],
                "not_after": (datetime.now(UTC) + timedelta(hours=hours)).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "valid_hours": hours,
            },
            "purpose": body.get("purpose", ""),
        }
        self.requests[req["id"]] = req
        return self._public(req)

    # ── the person's decision ──────────────────────────────────────────────

    def decide(self, request_id: str, *, approve: bool, code: str | None) -> dict[str, Any]:
        req = self.requests.get(request_id)
        if req is None:
            raise KeyError(request_id)
        if req["status"] != "pending":
            raise ValueError(f"request is already {req['status']}")
        if not approve:
            req["status"] = "declined"
            return self._public(req)
        if code != self.approval_code:
            raise PermissionError("approval code incorrect")
        req["mandates"] = (
            self._sign_direct(req) if req["kind"] == "direct" else self._sign_delegation(req)
        )
        req["status"] = "approved"
        req["approved_at"] = now()
        return self._public(req)

    def _sign_direct(self, req: dict[str, Any]) -> dict[str, str]:
        t = now()
        checkout = self.client.create(
            payloads=[
                CheckoutMandate(
                    checkout_jwt=req["checkout_jwt"],
                    checkout_hash=req["checkout_hash"],
                    iat=t,
                    exp=t + 900,
                )
            ],
            issuer_key=self.key,
        )
        payment = self.client.create(
            payloads=[
                PaymentMandate(
                    transaction_id=req["checkout_hash"],
                    payee=Merchant(**req["payee"]),
                    payment_amount=Amount(amount=int(req["amount"]), currency=CURRENCY),
                    payment_instrument=PaymentInstrument(**req["instrument"]),
                    iat=t,
                    exp=t + 900,
                )
            ],
            issuer_key=self.key,
        )
        return {"checkout_mandate": checkout, "payment_mandate": payment}

    def _sign_delegation(self, req: dict[str, Any]) -> dict[str, str]:
        lim, t = req["limits"], now()
        exp = t + min(MANDATE_TTL_SECONDS * 24, lim["valid_hours"] * 3600)
        cnf = {"jwk": req["agent_jwk"]}
        merchant = Merchant(**lim["merchant"])
        open_checkout = self.client.create(
            payloads=[
                OpenCheckoutMandate(
                    constraints=[
                        LineItems(
                            items=[
                                LineItemRequirements(
                                    id="capacity_block",
                                    acceptable_items=[
                                        Item(id=s, title=CATALOG[s]["title"]) for s in lim["skus"]
                                    ],
                                    quantity=lim["quantity"],
                                )
                            ]
                        ),
                        AllowedMerchants(allowed=[merchant]),
                    ],
                    cnf=cnf,
                    iat=t,
                    exp=exp,
                )
            ],
            issuer_key=self.key,
        )
        open_payment = self.client.create(
            payloads=[
                _OpenPaymentMandate(
                    constraints=[
                        AmountRange(currency=CURRENCY, min=0, max=lim["max_per_purchase"]),
                        AllowedPayees(allowed=[merchant]),
                        PaymentReference(
                            conditional_transaction_id=compute_sd_hash(parse_token(open_checkout))
                        ),
                        Budget(max=lim["budget"] / 100, currency=CURRENCY),
                        AgentRecurrence(
                            frequency=Frequency.ON_DEMAND, max_occurrences=lim["max_purchases"]
                        ),
                        ExecutionDate(not_after=lim["not_after"]),
                        AllowedPaymentInstruments(allowed=[PaymentInstrument(**lim["instrument"])]),
                    ],
                    cnf=cnf,
                    iat=t,
                    exp=exp,
                )
            ],
            issuer_key=self.key,
        )
        return {"open_checkout_mandate": open_checkout, "open_payment_mandate": open_payment}

    # ── views ──────────────────────────────────────────────────────────────

    def _public(self, req: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in req.items() if k not in ("checkout_jwt", "agent_jwk")}
        out["approval_path"] = f"/approve/{req['id']}"
        return out

    def summary_lines(self, req: dict[str, Any]) -> list[str]:
        if req["kind"] == "direct":
            d = req["display"]
            lines = [
                f"{line['quantity']} × {line['title']} = {dollars(line['amount'])}"
                for line in d["lines"]
            ]
            return [f"Pay {d['merchant']} {dollars(d['total'])} with {d['instrument']}", *lines]
        lim = req["limits"]
        items = " or ".join(CATALOG[s]["title"] for s in lim["skus"])
        return [
            f"Let {req['agent_name']} buy on its own, without asking again:",
            f"{lim['quantity']} × {items}",
            f"from {lim['merchant']['name']} only, paid with {lim['instrument']['description']}",
            f"at most {dollars(lim['max_per_purchase'])} per purchase, "
            f"{dollars(lim['budget'])} in total, {lim['max_purchases']} purchases",
            f"until {lim['not_after']}",
        ]


_PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve a purchase</title>
<style>
body{font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}
li{margin:.3rem 0} button{font:inherit;padding:.4rem .9rem}
</style>
<h1>Acme · approve an agent purchase</h1>
<p>Request <code>{rid}</code> · {state}</p>
<ul>{rows}</ul>{form}
<details><summary>What will be signed</summary><pre>{signed}</pre></details>
"""

_FORM = """<form onsubmit="go(event,'approve')">
<label>Approval code <input id="code" inputmode="numeric" autocomplete="off"></label>
<button>Approve</button> <button type="button" onclick="go(event,'decline')">Decline</button>
</form>
<script>
async function go(e, action) {
  e.preventDefault();
  const code = document.getElementById('code')?.value || '';
  const r = await fetch('/requests/{rid}/' + action, {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code})});
  const msg = r.ok ? 'Done: ' + action + 'd.' : 'Refused: ' + (await r.json()).detail;
  document.body.insertAdjacentHTML('beforeend', '<p>' + msg + '</p>');
}
</script>"""


def build_app(surface: TrustedSurface | None = None) -> Any:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import HTMLResponse

    ts = surface or TrustedSurface(
        trust=TrustStore({"merchant": os.environ.get("AP2_MERCHANT_URL", "")})
    )
    app = FastAPI(title="Trusted Surface (AP2)")
    app.state.surface = ts

    @app.get("/.well-known/jwks.json")
    def jwks() -> dict[str, Any]:
        return jwks_document(ts.key)

    @app.post("/requests")
    def create(body: dict[str, Any]) -> dict[str, Any]:
        try:
            return (
                ts.create_direct(body)
                if body.get("kind") == "direct"
                else ts.create_delegation(body)
            )
        except (KeyError, ValueError) as e:
            raise HTTPException(400, f"bad request: {e}") from e

    @app.get("/requests")
    def list_requests() -> dict[str, Any]:
        return {"requests": [ts._public(r) for r in ts.requests.values()]}

    @app.get("/requests/{rid}")
    def get(rid: str) -> dict[str, Any]:
        req = ts.requests.get(rid)
        if req is None:
            raise HTTPException(404, "no such request")
        return ts._public(req)

    @app.post("/requests/{rid}/approve")
    def approve(rid: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return ts.decide(rid, approve=True, code=str(body.get("code", "")))
        except KeyError as e:
            raise HTTPException(404, "no such request") from e
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e
        except ValueError as e:
            raise HTTPException(409, str(e)) from e

    @app.post("/requests/{rid}/decline")
    def decline(rid: str) -> dict[str, Any]:
        try:
            return ts.decide(rid, approve=False, code=None)
        except KeyError as e:
            raise HTTPException(404, "no such request") from e
        except ValueError as e:
            raise HTTPException(409, str(e)) from e

    @app.get("/approve/{rid}", response_class=HTMLResponse)
    def page(rid: str) -> str:
        req = ts.requests.get(rid)
        if req is None:
            raise HTTPException(404, "no such request")
        rows = "".join(f"<li>{html.escape(line)}</li>" for line in ts.summary_lines(req))
        form = _FORM.replace("{rid}", html.escape(rid)) if req["status"] == "pending" else ""
        signed = html.escape(json.dumps(ts._public(req), indent=1, default=str))
        return (
            _PAGE.replace("{rid}", html.escape(rid))
            .replace("{state}", html.escape(req["status"]))
            .replace("{rows}", rows)
            .replace("{form}", form)
            .replace("{signed}", signed)
        )

    return app
