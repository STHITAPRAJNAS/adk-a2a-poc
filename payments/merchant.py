"""Merchant (M): Northwind Compute's sales agent, an A2A server with AP2 required.

The Agent Card declares the AP2 extension with ``required: true``; a client
that doesn't activate it (``A2A-Extensions`` header) gets
``ExtensionSupportRequiredError`` (-32008) before anything else happens.

The merchant is **non-agentic** (AP2 allows either): every decision below is
deterministic code. Messages carry one DataPart. Commerce operations live
under ``commerce`` (AP2 leaves that protocol open; ours is UCP-shaped):

``{"commerce": {"op": "search", "query": "..."}}``
    → artifact ``offers``
``{"commerce": {"op": "create_checkout", "items": [{"sku", "quantity"}]}}``
    → artifact with a merchant-signed UCP Checkout JWT, its hash, and a nonce
    for the closed Checkout Mandate.
``{"commerce": {"op": "complete_checkout", "checkout_id": ...},
   "ap2.mandates.CheckoutMandateSdJwt": ..., "ap2.PaymentToken": ...}``
    → verify the Checkout Mandate (AP2 §Verification, Merchant), charge
    through the processor, and return a signed Checkout Receipt plus the
    processor's Payment Receipt. A rejection returns an error Checkout Receipt
    and the task ends ``REJECTED``.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx
from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.types.checkout import Checkout, Status
from ap2.sdk.generated.types.item import Item
from ap2.sdk.generated.types.line_item import LineItem
from ap2.sdk.generated.types.link import Link
from ap2.sdk.generated.types.merchant import Merchant as MerchantModel
from ap2.sdk.generated.types.total import Total
from ap2.sdk.jwt_helper import create_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.utils import compute_sha256_b64url

from payments.core import (
    AP2_EXTENSION_URI,
    CATALOG,
    CHECKOUT_MANDATE_KEY,
    CHECKOUT_RECEIPT_KEY,
    COMMERCE_KEY,
    CURRENCY,
    MERCHANT,
    PAYMENT_RECEIPT_KEY,
    PAYMENT_TOKEN_KEY,
    Ap2Error,
    TrustStore,
    jwks_document,
    load_or_create_key,
    new_id,
    now,
)

logger = logging.getLogger("payments.merchant")
APP_NAME = "northwind_sales"


class Merchant:
    def __init__(self, *, trust: TrustStore, processor_url: str = "", http: Any = None):
        self.key = load_or_create_key("merchant")
        self.trust = trust
        self.processor_url = processor_url
        self.http = http or httpx.Client(timeout=20)
        self.client = MandateClient()
        self.prices = {sku: item["price"] for sku, item in CATALOG.items()}
        self.checkouts: dict[str, dict[str, Any]] = {}
        self.orders: list[dict[str, Any]] = []

    # ── catalogue ──────────────────────────────────────────────────────────

    def search(self, query: str) -> dict[str, Any]:
        words = [w for w in query.lower().replace(",", " ").split() if len(w) > 1]
        offers = []
        for sku, item in CATALOG.items():
            text = f"{sku} {item['title']} {item['region']} {item['kind']}".lower()
            if not words or any(w in text for w in words):
                offers.append(
                    {
                        "sku": sku,
                        "title": item["title"],
                        "price": self.prices[sku],
                        "currency": CURRENCY,
                        "region": item["region"],
                    }
                )
        return {"merchant": MERCHANT, "offers": offers}

    # ── checkout ───────────────────────────────────────────────────────────

    def _sign_checkout(self, cid: str, lines: list[dict[str, Any]]) -> tuple[str, int]:
        line_items, total = [], 0
        for i, line in enumerate(lines):
            price = self.prices[line["sku"]]
            amount = price * line["quantity"]
            total += amount
            line_items.append(
                LineItem(
                    id=f"li_{i}",
                    item=Item(id=line["sku"], title=CATALOG[line["sku"]]["title"], price=price),
                    quantity=line["quantity"],
                    totals=[
                        Total(type="subtotal", amount=amount),
                        Total(type="total", amount=amount),
                    ],
                )
            )
        checkout = Checkout(
            id=cid,
            merchant=MerchantModel(**MERCHANT),
            line_items=line_items,
            status=Status.incomplete,
            currency=CURRENCY,
            totals=[Total(type="subtotal", amount=total), Total(type="total", amount=total)],
            links=[
                Link(type="terms_of_service", url=f"{MERCHANT['website']}/terms"),
                Link(type="privacy_policy", url=f"{MERCHANT['website']}/privacy"),
            ],
        )
        payload = checkout.model_dump(mode="json", exclude_none=True)
        return create_jwt(
            {"alg": "ES256", "typ": "JWT", "kid": self.key.key_id}, payload, self.key
        ), total

    def create_checkout(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        lines = [{"sku": i["sku"], "quantity": int(i["quantity"])} for i in items]
        unknown = [line["sku"] for line in lines if line["sku"] not in CATALOG]
        if unknown or not lines or any(line["quantity"] < 1 for line in lines):
            raise ValueError(f"cannot build a checkout for {items}")
        cid = new_id("chk")
        jwt, total = self._sign_checkout(cid, lines)
        nonce = new_id("n")
        self.checkouts[cid] = {
            "lines": lines,
            "jwt": jwt,
            "hash": compute_sha256_b64url(jwt),
            "total": total,
            "status": "incomplete",
            "nonce": nonce,
        }
        return {
            "checkout_id": cid,
            "checkout_jwt": jwt,
            "checkout_hash": self.checkouts[cid]["hash"],
            "total": total,
            "currency": CURRENCY,
            "merchant": MERCHANT,
            "nonce": nonce,
            "aud": "merchant",
        }

    def reprice(self, sku: str, price: int) -> None:
        """Lab hook: the price moves. Open checkouts are re-signed at the new
        price, so a mandate approved for the old checkout no longer matches."""
        self.prices[sku] = int(price)
        for cid, c in self.checkouts.items():
            if c["status"] == "incomplete" and any(line["sku"] == sku for line in c["lines"]):
                c["jwt"], c["total"] = self._sign_checkout(cid, c["lines"])
                c["hash"] = compute_sha256_b64url(c["jwt"])

    def _verify_checkout_mandate(self, c: dict[str, Any], token: str) -> str:
        provider = self.trust.key("agent-provider")
        if "~~" in token:  # human not present: open (user) + closed (agent) chain
            try:
                payloads = self.client.verify(
                    token=token,
                    key_or_provider=lambda _t: provider,
                    expected_aud="merchant",
                    expected_nonce=c["nonce"],
                )
                chain = CheckoutMandateChain.parse(payloads)
            except Exception as e:  # noqa: BLE001
                raise Ap2Error(
                    "invalid_credential", f"checkout mandate chain failed verification: {e}"
                ) from e
            closed = chain.closed_mandate
            violations = chain.verify(
                expected_checkout_hash=c["hash"], checkout_jwt=closed.checkout_jwt
            )
            if violations:
                raise Ap2Error(
                    "unresolved_constraint"
                    if closed.checkout_hash == c["hash"]
                    else "invalid_mandate",
                    "; ".join(violations),
                )
        else:  # human present: signed on the trusted surface
            try:
                closed = self.client.verify(
                    token=token, key_or_provider=provider, payload_type=CheckoutMandate
                ).mandate_payload
            except Exception as e:  # noqa: BLE001
                raise Ap2Error(
                    "invalid_credential", f"checkout mandate failed verification: {e}"
                ) from e
        if closed.checkout_hash != c["hash"] or closed.checkout_jwt != c["jwt"]:
            raise Ap2Error(
                "invalid_mandate",
                "the approved checkout is not the current checkout (price or items changed)",
            )
        return compute_sha256_b64url(self.client.get_closed_mandate_jwt(token))

    def complete_checkout(self, cid: str, token: str, payment_token: str) -> dict[str, Any]:
        c = self.checkouts.get(cid)
        reference = (
            compute_sha256_b64url(self.client.get_closed_mandate_jwt(token)) if token else ""
        )
        try:
            if c is None:
                raise Ap2Error("invalid_mandate", f"no such checkout {cid}")
            if c["status"] != "incomplete":
                raise Ap2Error("invalid_mandate", f"checkout {cid} is already {c['status']}")
            if not token:
                raise Ap2Error(
                    "mandates_not_supported", "this merchant requires an AP2 Checkout Mandate"
                )
            reference = self._verify_checkout_mandate(c, token)
            charge = self.http.post(
                f"{self.processor_url}/initiate-payment",
                json={
                    "payment_token": payment_token,
                    "checkout_hash": c["hash"],
                    "amount": c["total"],
                    "payee_id": MERCHANT["id"],
                },
            )
            if charge.status_code != 200:
                err = charge.json()
                raise Ap2Error(
                    err.get("error", "invalid_credential"),
                    f"payment declined: {err.get('error_description', charge.text)}",
                )
        except Ap2Error as e:
            body = {
                "status": "Error",
                "iss": MERCHANT["website"],
                "iat": now(),
                "reference": reference,
                "error": e.code,
                "error_description": e.description,
            }
            return {
                "ok": False,
                CHECKOUT_RECEIPT_KEY: self._sign(body),
                "error": e.code,
                "error_description": e.description,
            }
        c["status"] = "completed"
        order_id = new_id("ord")
        self.orders.append(
            {"order_id": order_id, "checkout_id": cid, "total": c["total"], "lines": c["lines"]}
        )
        receipt = {
            "status": "Success",
            "iss": MERCHANT["website"],
            "iat": now(),
            "reference": reference,
            "order_id": order_id,
        }
        return {
            "ok": True,
            "order_id": order_id,
            "total": c["total"],
            CHECKOUT_RECEIPT_KEY: self._sign(receipt),
            PAYMENT_RECEIPT_KEY: charge.json()["payment_receipt"],
        }

    def _sign(self, body: dict[str, Any]) -> str:
        return create_jwt({"alg": "ES256", "typ": "JWT", "kid": self.key.key_id}, body, self.key)

    # ── one entry point for A2A messages ───────────────────────────────────

    def handle(self, data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        """Returns (outcome, artifact data). outcome: completed | rejected."""
        cmd = data.get(COMMERCE_KEY) or {}
        op = cmd.get("op")
        if op == "search":
            return "completed", self.search(cmd.get("query", ""))
        if op == "create_checkout":
            return "completed", self.create_checkout(cmd.get("items", []))
        if op == "complete_checkout":
            result = self.complete_checkout(
                cmd.get("checkout_id", ""),
                data.get(CHECKOUT_MANDATE_KEY, ""),
                data.get(PAYMENT_TOKEN_KEY, ""),
            )
            return ("completed" if result["ok"] else "rejected"), result
        raise ValueError(f"unknown commerce op {op!r}")


AGENT_CARD = {
    "name": APP_NAME,
    "description": (
        "Northwind Compute's sales agent. Sells burst node-hours, GPU hours and CI minutes. "
        "Requires the Agent Payments Protocol (AP2) for every purchase."
    ),
    "supportedInterfaces": [
        {
            "url": "http://127.0.0.1:8410/a2a/northwind_sales",
            "protocolBinding": "JSONRPC",
            "protocolVersion": "1.0",
        }
    ],
    "version": "1.0.0",
    "provider": {"organization": "Northwind Compute (lab)", "url": MERCHANT["website"]},
    "capabilities": {
        "streaming": False,
        "pushNotifications": False,
        "extensions": [
            {
                "uri": AP2_EXTENSION_URI,
                "description": "Supports the Agent Payments Protocol.",
                "required": True,
            }
        ],
    },
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["application/json"],
    "skills": [
        {
            "id": "search_offers",
            "name": "Search offers",
            "description": "Find burst capacity, GPU hours and CI minutes, with current prices.",
            "tags": ["catalog", "capacity"],
        },
        {
            "id": "checkout",
            "name": "Checkout with AP2",
            "description": (
                "Create a signed checkout; complete it with an AP2 Checkout Mandate "
                "and a scoped payment credential."
            ),
            "tags": ["checkout", "ap2", "payments"],
        },
    ],
}


def build_app(merchant: Merchant | None = None) -> Any:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from google.adk.a2a import _compat

    merchant = merchant or Merchant(
        trust=TrustStore({"agent-provider": os.environ.get("AP2_TRUSTED_SURFACE_URL", "")}),
        processor_url=os.environ.get("AP2_PROCESSOR_URL", ""),
    )
    from a2a.server.agent_execution import AgentExecutor
    from a2a.server.tasks import InMemoryTaskStore, TaskUpdater

    class MerchantExecutor(AgentExecutor):
        async def execute(self, context: Any, event_queue: Any) -> None:
            await _compat.enqueue_submitted_signal(event_queue, context=context)
            updater = TaskUpdater(event_queue, context.task_id, context.context_id)
            data: dict[str, Any] = {}
            for part in context.message.parts if context.message else []:
                if _compat.is_data_part(part):
                    data.update(_compat.data_part_dict(part))
            try:
                outcome, result = merchant.handle(data)
            except (ValueError, KeyError) as e:
                await updater.failed(
                    updater.new_agent_message([_compat.make_text_part(f"Bad request: {e}")])
                )
                return
            await updater.add_artifact(
                [_compat.make_data_part(data=json.loads(json.dumps(result)))], name="result"
            )
            if outcome == "completed":
                await updater.complete()
            else:
                await updater.reject(
                    updater.new_agent_message(
                        [
                            _compat.make_text_part(
                                f"{result['error']}: {result['error_description']}"
                            )
                        ]
                    )
                )

        async def cancel(self, context: Any, event_queue: Any) -> None:
            await TaskUpdater(event_queue, context.task_id, context.context_id).cancel()

    base_url = os.environ.get("AP2_MERCHANT_PUBLIC_URL", "http://127.0.0.1:8410").rstrip("/")
    card = json.loads(json.dumps(AGENT_CARD))
    card["supportedInterfaces"][0]["url"] = f"{base_url}/a2a/{APP_NAME}"

    app = FastAPI(title="Northwind Compute sales agent (A2A + AP2)")
    app.state.merchant = merchant

    @app.middleware("http")
    async def require_ap2(request: Request, call_next: Any) -> Any:
        if request.method == "POST" and request.url.path.rstrip("/") == f"/a2a/{APP_NAME}":
            requested = (
                request.headers.get("a2a-extensions", "")
                + ","
                + request.headers.get("x-a2a-extensions", "")
            )
            if AP2_EXTENSION_URI not in [u.strip() for u in requested.split(",")]:
                try:
                    rid = json.loads(await request.body()).get("id")
                except ValueError:
                    rid = None
                return JSONResponse(
                    {
                        "jsonrpc": "2.0",
                        "id": rid,
                        "error": {
                            "code": -32008,
                            "message": "ExtensionSupportRequiredError",
                            "data": {
                                "required": [AP2_EXTENSION_URI],
                                "hint": "send A2A-Extensions: " + AP2_EXTENSION_URI,
                            },
                        },
                    }
                )
            response = await call_next(request)
            response.headers["A2A-Extensions"] = AP2_EXTENSION_URI
            return response
        return await call_next(request)

    _compat.attach_a2a_routes_to_app(
        app,
        agent_card=_compat.parse_agent_card(card),
        agent_executor=MerchantExecutor(),
        task_store=InMemoryTaskStore(),
        prefix=f"/a2a/{APP_NAME}",
    )

    @app.get("/.well-known/jwks.json")
    def jwks() -> dict[str, Any]:
        return jwks_document(merchant.key)

    @app.post("/ops/prices")
    def set_price(body: dict[str, Any]) -> dict[str, Any]:
        merchant.reprice(body["sku"], int(body["price"]))
        return {"prices": merchant.prices}

    @app.get("/ops/orders")
    def orders() -> dict[str, Any]:
        return {"orders": merchant.orders, "prices": merchant.prices}

    return app
