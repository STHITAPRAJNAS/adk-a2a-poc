"""Merchant Payment Processor (MPP): Northwind's payment processor.

What AP2 asks of this role (specification.md §Merchant Payment Processor):
verify that the payment credential it receives is scoped to *this* checkout.
Our credential carries the closed Payment Mandate inside it, so the processor
checks, in deterministic code:

1. the credential is signed by the wallet and not expired;
2. the Payment Mandate inside verifies back to the trusted agent provider;
3. its ``transaction_id`` is the hash of the checkout the merchant is charging,
   and amount and payee match the charge.

Then it authorizes with the issuer (the wallet's ``/redeem``, which enforces
single use) and returns a signed Payment Receipt to the merchant, and sends a
copy to the wallet.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.jwt_helper import create_jwt, verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.utils import compute_sha256_b64url

from payments.core import (
    PROCESSOR_ISSUER,
    Ap2Error,
    TrustStore,
    jwks_document,
    load_or_create_key,
    new_id,
    now,
)


class Processor:
    def __init__(self, *, trust: TrustStore, cp_url: str = "", http: Any = None):
        self.key = load_or_create_key("processor")
        self.trust = trust
        self.cp_url = cp_url
        self.http = http or httpx.Client(timeout=15)
        self.client = MandateClient()
        self.payments: list[dict[str, Any]] = []

    def _closed_payment(self, token: str) -> PaymentMandate:
        provider = self.trust.key("agent-provider")
        if "~~" in token:
            payloads = self.client.verify(token=token, key_or_provider=lambda _t: provider)
            return PaymentMandate.model_validate(payloads[-1])
        return self.client.verify(
            token=token, key_or_provider=provider, payload_type=PaymentMandate
        ).mandate_payload

    def initiate(self, body: dict[str, Any]) -> dict[str, Any]:
        try:
            cred = verify_jwt(body["payment_token"], self.trust.key("credential-provider"))
        except Exception as e:  # noqa: BLE001
            raise Ap2Error(
                "invalid_credential", f"payment credential not signed by the wallet: {e}"
            ) from e
        if cred["exp"] < now():
            raise Ap2Error("invalid_credential", "payment credential expired")
        try:
            closed = self._closed_payment(cred["payment_mandate"])
        except Exception as e:  # noqa: BLE001
            raise Ap2Error("invalid_credential", f"payment mandate failed verification: {e}") from e
        if (
            closed.transaction_id != body["checkout_hash"]
            or cred["checkout_hash"] != body["checkout_hash"]
        ):
            raise Ap2Error("invalid_mandate", "payment mandate is bound to a different checkout")
        if (
            closed.payment_amount.amount != int(body["amount"])
            or closed.payee.id != body["payee_id"]
        ):
            raise Ap2Error("invalid_mandate", "amount or payee differ from the mandate")

        auth = self.http.post(
            f"{self.cp_url}/redeem",
            json={
                "payment_token": body["payment_token"],
                "checkout_hash": body["checkout_hash"],
                "amount": body["amount"],
            },
        )
        if auth.status_code != 200:
            raise Ap2Error(
                "invalid_credential", f"issuer declined: {auth.json().get('detail', auth.text)}"
            )

        reference = compute_sha256_b64url(
            self.client.get_closed_mandate_jwt(cred["payment_mandate"])
        )
        pid = new_id("pay")
        receipt = {
            "status": "Success",
            "iss": PROCESSOR_ISSUER,
            "iat": now(),
            "reference": reference,
            "payment_id": pid,
            "psp_confirmation_id": auth.json()["authorization_code"],
            "network_confirmation_id": new_id("net"),
        }
        signed = create_jwt(
            {"alg": "ES256", "typ": "JWT", "kid": self.key.key_id}, receipt, self.key
        )
        self.payments.append(
            {"payment_id": pid, "amount": closed.payment_amount.amount, "reference": reference}
        )
        try:
            self.http.post(f"{self.cp_url}/payment-receipts", json={"payment_receipt": signed})
        except httpx.HTTPError:
            pass  # the wallet copy is best effort; the merchant still gets its receipt
        return {"payment_receipt": signed, "payment_id": pid}


def build_app(proc: Processor | None = None) -> Any:
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    cp_url = os.environ.get("AP2_CREDENTIAL_PROVIDER_URL", "")
    proc = proc or Processor(
        trust=TrustStore(
            {
                "agent-provider": os.environ.get("AP2_TRUSTED_SURFACE_URL", ""),
                "credential-provider": cp_url,
            }
        ),
        cp_url=cp_url,
    )
    app = FastAPI(title="Merchant Payment Processor (AP2)")
    app.state.processor = proc

    @app.get("/.well-known/jwks.json")
    def jwks() -> dict[str, Any]:
        return jwks_document(proc.key)

    @app.post("/initiate-payment")
    def initiate(body: dict[str, Any]) -> Any:
        try:
            return proc.initiate(body)
        except Ap2Error as e:
            return JSONResponse(
                status_code=402, content={"error": e.code, "error_description": e.description}
            )

    @app.get("/payments")
    def payments() -> dict[str, Any]:
        return {"payments": proc.payments}

    return app
