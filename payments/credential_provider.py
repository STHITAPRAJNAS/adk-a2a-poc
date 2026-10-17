"""Credential Provider (CP): Acme's corporate-card wallet.

What AP2 asks of this role (specification.md §Verification, Credential
Provider and Network):

* Before releasing any payment credential, receive a Payment Mandate and
  verify it: signatures back to a trusted issuer (here the agent provider's
  key), audience and nonce, and, for an open mandate, every constraint.
* On failure, return a signed Payment Receipt carrying the error.
* Release a credential **scoped to this one checkout**: our token is a
  CP-signed JWT carrying the closed Payment Mandate, the checkout hash and the
  amount, valid for five minutes and redeemable once.
* Track usage of open mandates so ``payment.budget`` and
  ``payment.agent_recurrence`` can be evaluated (MandateContext), and refuse a
  second presentation of an open mandate while an earlier one is unresolved.

It also plays the card issuer for the processor's authorization call
(``/redeem``), which is where single use is enforced.
"""

from __future__ import annotations

import os
from typing import Any

from ap2.sdk.constraints import MandateContext
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.jwt_helper import create_jwt, verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from ap2.sdk.sdjwt import compute_sd_hash, parse_token
from ap2.sdk.utils import compute_sha256_b64url

from payments.core import (
    CREDENTIAL_PROVIDER_ISSUER,
    INSTRUMENT,
    Ap2Error,
    TrustStore,
    jwks_document,
    load_or_create_key,
    new_id,
    now,
)

TOKEN_TTL_SECONDS = 300


class CredentialProvider:
    def __init__(self, *, trust: TrustStore):
        self.key = load_or_create_key("credential-provider")
        self.trust = trust
        self.client = MandateClient()
        self.nonces: dict[str, int] = {}
        self.tokens: dict[str, dict[str, Any]] = {}
        self.usage: dict[str, MandateContext] = {}  # open payment mandate hash -> usage
        self.inflight: dict[str, str] = {}  # open payment mandate hash -> token jti
        self.receipts: list[dict[str, Any]] = []

    # ── challenge ──────────────────────────────────────────────────────────

    def challenge(self) -> dict[str, Any]:
        nonce = new_id("n")
        self.nonces[nonce] = now() + 120
        return {"nonce": nonce, "aud": "credential-provider"}

    # ── issuing a scoped credential ────────────────────────────────────────

    def issue(self, body: dict[str, Any]) -> dict[str, Any]:
        token = body["payment_mandate"]
        checkout_hash = body["checkout_hash"]
        nonce = body.get("nonce")
        provider = self.trust.key("agent-provider")
        open_hash = None
        if "~~" in token:  # human not present: open (user) + closed (agent) chain
            if not nonce or self.nonces.pop(nonce, 0) < now():
                raise Ap2Error(
                    "invalid_mandate", "missing or expired nonce; ask for a fresh challenge"
                )
            try:
                payloads = self.client.verify(
                    token=token,
                    key_or_provider=lambda _t: provider,
                    expected_aud="credential-provider",
                    expected_nonce=nonce,
                )
                chain = PaymentMandateChain.parse(payloads)
            except Exception as e:  # noqa: BLE001 - any verification failure is terminal
                raise Ap2Error(
                    "invalid_credential", f"mandate chain failed verification: {e}"
                ) from e
            open_hash = compute_sd_hash(parse_token(token.split("~~")[0] + "~"))
            if (
                open_hash in self.inflight
                and self.tokens.get(self.inflight[open_hash], {}).get("state") == "issued"
            ):
                raise Ap2Error(
                    "invalid_mandate",
                    "an earlier purchase under this open mandate is still unresolved",
                )
            violations = chain.verify(
                expected_transaction_id=checkout_hash,
                expected_open_checkout_hash=body.get("open_checkout_hash"),
                mandate_context=self.usage.get(open_hash, MandateContext()),
            )
            if violations:
                raise Ap2Error("unresolved_constraint", "; ".join(violations))
            closed = chain.closed_mandate
        else:  # human present: one closed mandate signed on the trusted surface
            try:
                closed = self.client.verify(
                    token=token, key_or_provider=provider, payload_type=PaymentMandate
                ).mandate_payload
            except Exception as e:  # noqa: BLE001
                raise Ap2Error("invalid_credential", f"mandate failed verification: {e}") from e
            if closed.transaction_id != checkout_hash:
                raise Ap2Error(
                    "invalid_mandate", "payment mandate is bound to a different checkout"
                )
        if closed.payment_instrument.id != INSTRUMENT["id"]:
            raise Ap2Error("invalid_mandate", "unknown payment instrument")

        jti = new_id("tok")
        claims = {
            "iss": CREDENTIAL_PROVIDER_ISSUER,
            "jti": jti,
            "iat": now(),
            "exp": now() + TOKEN_TTL_SECONDS,
            "checkout_hash": checkout_hash,
            "amount": closed.payment_amount.amount,
            "currency": closed.payment_amount.currency,
            "payee": closed.payee.model_dump(exclude_none=True),
            "instrument": INSTRUMENT["description"],
            "payment_mandate": token,
        }
        self.tokens[jti] = {
            "state": "issued",
            "claims": claims,
            "open_hash": open_hash,
            "reference": compute_sha256_b64url(self.client.get_closed_mandate_jwt(token)),
        }
        if open_hash:
            self.inflight[open_hash] = jti
        return {
            "payment_token": create_jwt(
                {"alg": "ES256", "typ": "JWT", "kid": self.key.key_id}, claims, self.key
            ),
            "expires_in": TOKEN_TTL_SECONDS,
        }

    def error_receipt(self, err: Ap2Error, reference: str) -> str:
        body = {
            "status": "Error",
            "iss": CREDENTIAL_PROVIDER_ISSUER,
            "iat": now(),
            "reference": reference,
            "error": err.code,
            "error_description": err.description,
        }
        return create_jwt({"alg": "ES256", "typ": "JWT", "kid": self.key.key_id}, body, self.key)

    # ── the issuer side: the processor authorizes against us ──────────────

    def redeem(self, body: dict[str, Any]) -> dict[str, Any]:
        claims = verify_jwt(body["payment_token"], self.key)
        record = self.tokens.get(claims["jti"])
        if record is None or claims["exp"] < now():
            raise Ap2Error("invalid_credential", "unknown or expired payment token")
        if record["state"] != "issued":
            raise Ap2Error("invalid_credential", "payment token already used")
        if (
            body.get("checkout_hash") != claims["checkout_hash"]
            or int(body.get("amount", -1)) != claims["amount"]
        ):
            raise Ap2Error(
                "invalid_mandate", "authorization request does not match the scoped token"
            )
        record["state"] = "authorized"
        return {
            "authorization_code": new_id("auth"),
            "amount": claims["amount"],
            "currency": claims["currency"],
        }

    def record_receipt(self, body: dict[str, Any]) -> dict[str, Any]:
        receipt = verify_jwt(body["payment_receipt"], self.trust.key("processor"))
        rec = next(
            (r for r in self.tokens.values() if r["reference"] == receipt["reference"]), None
        )
        if rec is not None:
            if receipt.get("status") == "Success":
                rec["state"] = "settled"
                if rec["open_hash"]:
                    ctx = self.usage.setdefault(rec["open_hash"], MandateContext())
                    ctx.total_amount += rec["claims"]["amount"]
                    ctx.total_uses += 1
                    ctx.last_used_date = float(now())
            else:
                rec["state"] = "failed"
            if rec["open_hash"] and self.inflight.get(rec["open_hash"]) == rec["claims"]["jti"]:
                self.inflight.pop(rec["open_hash"], None)
        self.receipts.append(receipt)
        return {"stored": True}

    def release(self, body: dict[str, Any]) -> dict[str, Any]:
        """The shopper reports a merchant rejection: free the open mandate."""
        claims = verify_jwt(body["payment_token"], self.key)
        rec = self.tokens.get(claims["jti"])
        if rec and rec["state"] == "issued":
            rec["state"] = "voided"
            if rec["open_hash"]:
                self.inflight.pop(rec["open_hash"], None)
        return {"released": bool(rec)}


def build_app(cp: CredentialProvider | None = None) -> Any:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse

    cp = cp or CredentialProvider(
        trust=TrustStore(
            {
                "agent-provider": os.environ.get("AP2_TRUSTED_SURFACE_URL", ""),
                "processor": os.environ.get("AP2_PROCESSOR_URL", ""),
            }
        )
    )
    app = FastAPI(title="Credential Provider (AP2)")
    app.state.cp = cp

    @app.get("/.well-known/jwks.json")
    def jwks() -> dict[str, Any]:
        return jwks_document(cp.key)

    @app.get("/instruments")
    def instruments() -> dict[str, Any]:
        return {"instruments": [INSTRUMENT]}

    @app.post("/payment-credentials/challenge")
    def challenge() -> dict[str, Any]:
        return cp.challenge()

    @app.post("/payment-credentials")
    def issue(body: dict[str, Any]) -> Any:
        try:
            return cp.issue(body)
        except Ap2Error as e:
            ref = compute_sha256_b64url(
                MandateClient().get_closed_mandate_jwt(body.get("payment_mandate", "x.y.z~"))
            )
            return JSONResponse(
                status_code=400,
                content={
                    "error": e.code,
                    "error_description": e.description,
                    "payment_receipt": cp.error_receipt(e, ref),
                },
            )

    @app.post("/payment-credentials/release")
    def release(body: dict[str, Any]) -> dict[str, Any]:
        return cp.release(body)

    @app.post("/redeem")
    def redeem(body: dict[str, Any]) -> Any:
        try:
            return cp.redeem(body)
        except Ap2Error as e:
            raise HTTPException(402, f"{e.code}: {e.description}") from e

    @app.post("/payment-receipts")
    def receipts(body: dict[str, Any]) -> dict[str, Any]:
        return cp.record_receipt(body)

    @app.get("/usage")
    def usage() -> dict[str, Any]:
        return {
            "usage": {k: v.model_dump() for k, v in cp.usage.items()},
            "tokens": [
                {"jti": j, "state": r["state"], "amount": r["claims"]["amount"]}
                for j, r in cp.tokens.items()
            ],
            "receipts": cp.receipts,
        }

    return app
