"""Shopping Agent (SA) side: the release agent's wallet code.

AP2 expects the Shopping Agent to be agentic (an LLM decides *what* to buy),
but everything below is the deterministic part the spec requires: building
mandate content, asking the Trusted Surface, choosing the open mandate,
key-binding closed mandates with the agent's own key, minimising disclosures,
not presenting an open mandate twice before the first is resolved, and
checking receipts.

Two journeys:

* ``prepare_direct`` + ``complete_direct``: human present. The person approves
  the exact checkout on the Trusted Surface.
* ``request_delegation`` + ``collect_delegation`` + ``buy_autonomously``: human
  not present. The person approves limits once; the agent buys within them.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from ap2.sdk.constraints import (
    MandateContext,
    check_checkout_constraints,
    check_payment_constraints,
)
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.generated.types.amount import Amount
from ap2.sdk.generated.types.checkout import Checkout
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
from ap2.sdk.jwt_helper import verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.sdjwt import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url

from payments.core import (
    AP2_EXTENSION_URI,
    CHECKOUT_MANDATE_KEY,
    CHECKOUT_RECEIPT_KEY,
    COMMERCE_KEY,
    CURRENCY,
    MERCHANT,
    PAYMENT_RECEIPT_KEY,
    PAYMENT_TOKEN_KEY,
    TrustStore,
    dollars,
    load_or_create_key,
    public_jwk_dict,
)


class PurchaseError(Exception):
    def __init__(self, stage: str, code: str, description: str, detail: Any = None):
        super().__init__(f"{stage}: {code}: {description}")
        self.stage, self.code, self.description, self.detail = stage, code, description, detail


@dataclass
class Delegation:
    request_id: str
    open_checkout: str
    open_payment: str
    open_checkout_hash: str
    open_payment_hash: str
    purchases: list[dict[str, Any]] = field(default_factory=list)
    spent: int = 0
    inflight: bool = False


class MerchantClient:
    """A2A JSON-RPC (1.0 shapes) to the merchant, activating AP2 on every call."""

    def __init__(self, url: str, http: Any, *, activate_ap2: bool = True):
        self.url, self.http, self.activate_ap2 = url, http, activate_ap2
        self.last_exchange: dict[str, Any] = {}

    def send(self, data: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any]]:
        body = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": [{"data": data}],
                }
            },
        }
        headers = {"A2A-Version": "1.0"}
        if self.activate_ap2:
            headers["A2A-Extensions"] = AP2_EXTENSION_URI
        resp = self.http.post(self.url, json=body, headers=headers)
        doc = resp.json()
        self.last_exchange = {
            "request": body,
            "headers": headers,
            "response": doc,
            "response_headers": dict(resp.headers),
        }
        if "error" in doc:
            raise PurchaseError(
                "merchant",
                str(doc["error"].get("code")),
                doc["error"].get("message", ""),
                doc["error"].get("data"),
            )
        task = doc["result"].get("task", doc["result"])
        state = task.get("status", {}).get("state", "")
        artifact: dict[str, Any] = {}
        for art in task.get("artifacts", []):
            for part in art.get("parts", []):
                if isinstance(part.get("data"), dict):
                    artifact.update(part["data"])
        return state, artifact, task


class Shopper:
    def __init__(
        self,
        *,
        merchant_url: str,
        credential_provider_url: str,
        trusted_surface_url: str,
        trust: TrustStore,
        http: Any = None,
        agent_name: str = "deployment_agent",
    ):
        self.http = http or httpx.Client(timeout=30)
        self.merchant = MerchantClient(merchant_url, self.http)
        self.cp_url = credential_provider_url.rstrip("/")
        self.ts_url = trusted_surface_url.rstrip("/")
        self.trust = trust
        self.agent_name = agent_name
        self.key = load_or_create_key("shopping-agent")
        self.client = MandateClient()
        self.pending_direct: dict[str, dict[str, Any]] = {}
        self.delegations: dict[str, Delegation] = {}
        self.history: list[dict[str, Any]] = []

    # ── shared steps ───────────────────────────────────────────────────────

    def search(self, query: str) -> dict[str, Any]:
        _, art, _ = self.merchant.send({COMMERCE_KEY: {"op": "search", "query": query}})
        return art

    def instrument(self) -> dict[str, Any]:
        return (
            self.http.get(f"{self.cp_url}/instruments").raise_for_status().json()["instruments"][0]
        )

    def create_checkout(self, sku: str, quantity: int) -> dict[str, Any]:
        state, art, _ = self.merchant.send(
            {COMMERCE_KEY: {"op": "create_checkout", "items": [{"sku": sku, "quantity": quantity}]}}
        )
        if "checkout_jwt" not in art:
            raise PurchaseError(
                "checkout", "merchant_error", f"no checkout returned (task {state})"
            )
        # Check the merchant's signature before showing or signing anything.
        verify_jwt(art["checkout_jwt"], self.trust.key("merchant"))
        if compute_sha256_b64url(art["checkout_jwt"]) != art["checkout_hash"]:
            raise PurchaseError(
                "checkout", "bad_hash", "checkout hash does not match the checkout JWT"
            )
        return art

    def _payment_credential(
        self, mandate: str, checkout_hash: str, nonce: str | None, open_checkout_hash: str | None
    ) -> str:
        resp = self.http.post(
            f"{self.cp_url}/payment-credentials",
            json={
                "payment_mandate": mandate,
                "checkout_hash": checkout_hash,
                "nonce": nonce,
                "open_checkout_hash": open_checkout_hash,
            },
        )
        doc = resp.json()
        if resp.status_code != 200:
            raise PurchaseError(
                "credential_provider",
                doc.get("error", "error"),
                doc.get("error_description", ""),
                doc,
            )
        return doc["payment_token"]

    def _complete(
        self, checkout: dict[str, Any], checkout_mandate: str, payment_token: str
    ) -> dict[str, Any]:
        state, art, _ = self.merchant.send(
            {
                COMMERCE_KEY: {"op": "complete_checkout", "checkout_id": checkout["checkout_id"]},
                CHECKOUT_MANDATE_KEY: checkout_mandate,
                PAYMENT_TOKEN_KEY: payment_token,
            }
        )
        receipt = (
            verify_jwt(art[CHECKOUT_RECEIPT_KEY], self.trust.key("merchant"))
            if CHECKOUT_RECEIPT_KEY in art
            else {}
        )
        if not art.get("ok"):
            raise PurchaseError(
                "merchant",
                art.get("error", "rejected"),
                art.get("error_description", state),
                {"checkout_receipt": receipt},
            )
        expected = compute_sha256_b64url(self.client.get_closed_mandate_jwt(checkout_mandate))
        if receipt.get("reference") != expected:
            raise PurchaseError(
                "merchant", "bad_receipt", "checkout receipt does not reference our mandate"
            )
        payment_receipt = verify_jwt(art[PAYMENT_RECEIPT_KEY], self.trust.key("processor"))
        result = {
            "order_id": art["order_id"],
            "total": art["total"],
            "checkout_receipt": receipt,
            "payment_receipt": payment_receipt,
        }
        self.history.append(result)
        return result

    # ── human present ──────────────────────────────────────────────────────

    def prepare_direct(self, sku: str, quantity: int) -> dict[str, Any]:
        checkout = self.create_checkout(sku, quantity)
        req = (
            self.http.post(
                f"{self.ts_url}/requests",
                json={
                    "kind": "direct",
                    "checkout_jwt": checkout["checkout_jwt"],
                    "instrument": self.instrument(),
                },
            )
            .raise_for_status()
            .json()
        )
        self.pending_direct[req["id"]] = checkout
        return {
            "request_id": req["id"],
            "approval_url": f"{self.ts_url}{req['approval_path']}",
            "summary": req["display"],
            "checkout": checkout,
        }

    def complete_direct(self, request_id: str) -> dict[str, Any]:
        checkout = self.pending_direct.get(request_id)
        if checkout is None:
            raise PurchaseError("agent", "unknown_request", f"no pending purchase {request_id}")
        req = self.http.get(f"{self.ts_url}/requests/{request_id}").raise_for_status().json()
        if req["status"] != "approved":
            return {"status": req["status"], "approval_url": f"{self.ts_url}{req['approval_path']}"}
        mandates = req["mandates"]
        token = self._payment_credential(
            mandates["payment_mandate"], checkout["checkout_hash"], None, None
        )
        result = self._complete(checkout, mandates["checkout_mandate"], token)
        self.pending_direct.pop(request_id, None)
        return {"status": "purchased", **result}

    # ── human not present ──────────────────────────────────────────────────

    def request_delegation(
        self,
        *,
        skus: list[str],
        quantity: int,
        max_per_purchase: int,
        budget: int,
        max_purchases: int,
        valid_hours: int,
        purpose: str,
    ) -> dict[str, Any]:
        req = (
            self.http.post(
                f"{self.ts_url}/requests",
                json={
                    "kind": "delegation",
                    "agent_name": self.agent_name,
                    "agent_jwk": public_jwk_dict(self.key),
                    "purpose": purpose,
                    "limits": {
                        "skus": skus,
                        "quantity": quantity,
                        "max_per_purchase": max_per_purchase,
                        "budget": budget,
                        "max_purchases": max_purchases,
                        "valid_hours": valid_hours,
                        "merchant": MERCHANT,
                        "instrument": self.instrument(),
                    },
                },
            )
            .raise_for_status()
            .json()
        )
        return {
            "request_id": req["id"],
            "approval_url": f"{self.ts_url}{req['approval_path']}",
            "limits": req["limits"],
        }

    def collect_delegation(self, request_id: str) -> dict[str, Any]:
        req = self.http.get(f"{self.ts_url}/requests/{request_id}").raise_for_status().json()
        if req["status"] != "approved":
            return {"status": req["status"]}
        m = req["mandates"]
        provider = self.trust.key("agent-provider")
        # Verify what we were given before relying on it.
        self.client.verify(
            token=m["open_checkout_mandate"],
            key_or_provider=provider,
            payload_type=OpenCheckoutMandate,
        )
        self.client.verify(
            token=m["open_payment_mandate"],
            key_or_provider=provider,
            payload_type=OpenPaymentMandate,
        )
        self.delegations[request_id] = Delegation(
            request_id,
            m["open_checkout_mandate"],
            m["open_payment_mandate"],
            compute_sd_hash(parse_token(m["open_checkout_mandate"])),
            compute_sd_hash(parse_token(m["open_payment_mandate"])),
        )
        return {"status": "approved", "limits": req["limits"]}

    def active_delegation(self) -> Delegation | None:
        return next(reversed(self.delegations.values()), None) if self.delegations else None

    def buy_autonomously(
        self, sku: str, quantity: int, *, delegation: Delegation | None = None
    ) -> dict[str, Any]:
        d = delegation or self.active_delegation()
        if d is None:
            raise PurchaseError(
                "agent",
                "no_mandate",
                "no approved spending limits; ask a person to approve a delegation first",
            )
        if d.inflight:
            raise PurchaseError(
                "agent", "inflight", "an earlier purchase under these limits is still unresolved"
            )
        provider = self.trust.key("agent-provider")
        open_checkout = self.client.verify(
            token=d.open_checkout, key_or_provider=provider, payload_type=OpenCheckoutMandate
        ).mandate_payload
        open_payment = self.client.verify(
            token=d.open_payment, key_or_provider=provider, payload_type=OpenPaymentMandate
        ).mandate_payload

        checkout = self.create_checkout(sku, quantity)
        parsed = Checkout.model_validate(
            verify_jwt(checkout["checkout_jwt"], self.trust.key("merchant"))
        )
        # Check locally first: never present a mandate we know will fail.
        problems = check_checkout_constraints(open_checkout, parsed)
        candidate = PaymentMandate(
            transaction_id=checkout["checkout_hash"],
            payee=Merchant(**MERCHANT),
            payment_amount=Amount(amount=int(checkout["total"]), currency=CURRENCY),
            payment_instrument=PaymentInstrument(**self.instrument()),
        )
        problems += check_payment_constraints(
            open_payment,
            candidate,
            open_checkout_hash=d.open_checkout_hash,
            mandate_context=MandateContext(total_amount=d.spent, total_uses=len(d.purchases)),
        )
        if problems:
            raise PurchaseError(
                "agent", "outside_limits", "; ".join(problems), {"checkout": checkout}
            )

        closed_checkout = self.client.present(
            holder_key=self.key,
            mandate_token=d.open_checkout,
            payloads=[
                CheckoutMandate(
                    checkout_jwt=checkout["checkout_jwt"], checkout_hash=checkout["checkout_hash"]
                )
            ],
            nonce=checkout["nonce"],
            aud="merchant",
        )
        challenge = (
            self.http.post(f"{self.cp_url}/payment-credentials/challenge").raise_for_status().json()
        )
        closed_payment = self.client.present(
            holder_key=self.key,
            mandate_token=d.open_payment,
            payloads=[candidate],
            nonce=challenge["nonce"],
            aud="credential-provider",
        )
        d.inflight = True
        token = None
        try:
            token = self._payment_credential(
                closed_payment, checkout["checkout_hash"], challenge["nonce"], d.open_checkout_hash
            )
            result = self._complete(checkout, closed_checkout, token)
        except PurchaseError:
            if token:
                self.http.post(
                    f"{self.cp_url}/payment-credentials/release", json={"payment_token": token}
                )
            raise
        finally:
            d.inflight = False
        d.spent += int(checkout["total"])
        d.purchases.append(
            {
                "order_id": result["order_id"],
                "total": checkout["total"],
                "sku": sku,
                "quantity": quantity,
            }
        )
        return {"status": "purchased", **result, "spent_so_far": dollars(d.spent)}
