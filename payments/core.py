"""Shared pieces for the AP2 roles: keys, trust, wire constants, the catalogue.

Trust works the way AP2's Trusted Agent Provider model expects: every role
publishes its public key at ``/.well-known/jwks.json`` and verifiers fetch the
keys of the parties they trust from URLs in their own configuration. Nothing
is trusted because a message says so.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric import ec
from jwcrypto.jwk import JWK

# ── wire constants ──────────────────────────────────────────────────────────

#: The AP2 A2A extension URI (from the official samples' a2a_extension_utils).
AP2_EXTENSION_URI = "https://github.com/google-agentic-commerce/ap2/v1"
#: DataPart keys for mandates and receipts (from the official samples' constants).
CHECKOUT_MANDATE_KEY = "ap2.mandates.CheckoutMandateSdJwt"
PAYMENT_MANDATE_KEY = "ap2.mandates.PaymentMandateSdJwt"
PAYMENT_RECEIPT_KEY = "ap2.PaymentReceipt"
CHECKOUT_RECEIPT_KEY = "ap2.CheckoutReceipt"
#: AP2 leaves the commerce protocol (catalogue, cart, checkout) open. Ours is a
#: small UCP-shaped vocabulary under one key.
COMMERCE_KEY = "commerce"
PAYMENT_TOKEN_KEY = "ap2.PaymentToken"

CURRENCY = "USD"
MANDATE_TTL_SECONDS = 60 * 60


# ── the vendor and its catalogue ────────────────────────────────────────────

MERCHANT = {
    "id": "northwind-compute",
    "name": "Northwind Compute",
    "website": "https://northwind-compute.example",
}
PROCESSOR_ISSUER = "https://payments.northwind-compute.example"
CREDENTIAL_PROVIDER_ISSUER = "https://wallet.acme.example"
AGENT_PROVIDER_ISSUER = "https://agents.acme.example"

#: Prices are in cents (minor units), as UCP and the AP2 SDK expect.
CATALOG: dict[str, dict[str, Any]] = {
    "nw-burst-node-hour-eu": {
        "title": "Burst node-hour, eu-west1 (8 vCPU, 32 GB)",
        "price": 240,
        "region": "eu-west1",
        "kind": "node-hour",
    },
    "nw-burst-node-hour-us": {
        "title": "Burst node-hour, us-east1 (8 vCPU, 32 GB)",
        "price": 210,
        "region": "us-east1",
        "kind": "node-hour",
    },
    "nw-gpu-hour-l4-eu": {
        "title": "GPU hour, eu-west1 (1x L4)",
        "price": 95,
        "region": "eu-west1",
        "kind": "gpu-hour",
    },
    "nw-ci-minutes-1000": {
        "title": "1,000 CI build minutes",
        "price": 800,
        "region": "global",
        "kind": "ci-minutes",
    },
}

#: The corporate card the wallet holds. Only a masked description ever leaves it.
INSTRUMENT = {
    "id": "acme-corp-card-4242",
    "type": "card",
    "description": "Acme corporate card ••••4242",
}


def sku_for(region: str, kind: str = "node-hour") -> str | None:
    for sku, item in CATALOG.items():
        if item["kind"] == kind and item["region"] == region:
            return sku
    return None


# ── keys ────────────────────────────────────────────────────────────────────


def new_jwk(kid: str) -> JWK:
    data = json.loads(JWK.from_pyca(ec.generate_private_key(ec.SECP256R1())).export())
    data["kid"] = kid
    return JWK(**data)


def load_or_create_key(role: str) -> JWK:
    """An ES256 key for ``role``. Kept in ``PAYMENTS_KEY_DIR`` when that is set,
    so a restart keeps the same identity; otherwise it lives in memory."""
    kid = f"{role}-1"
    key_dir = os.environ.get("PAYMENTS_KEY_DIR", "").strip()
    if key_dir:
        path = Path(key_dir) / f"{role}.jwk.json"
        if path.exists():
            return JWK(**json.loads(path.read_text()))
        key = new_jwk(kid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key.export(private_key=True))
        path.chmod(0o600)
        return key
    return new_jwk(kid)


def public_jwk_dict(key: JWK) -> dict[str, Any]:
    return json.loads(key.export_public())


def jwks_document(key: JWK) -> dict[str, Any]:
    return {"keys": [public_jwk_dict(key)]}


class TrustStore:
    """Public keys of the parties a role trusts, fetched from configured URLs.

    Fetched keys are cached for ``ttl`` seconds, like any JWKS client, so a
    party that restarts with a new key is picked up again within a minute.
    """

    def __init__(self, urls: dict[str, str], *, client: httpx.Client | None = None, ttl: int = 60):
        self._urls = {k: v for k, v in urls.items() if v}
        self._keys: dict[str, tuple[JWK, float]] = {}
        self._client = client
        self._ttl = ttl

    def pin(self, name: str, key: JWK) -> None:
        """Trust a key directly (tests, single-process runs). Never expires."""
        self._keys[name] = (JWK(**public_jwk_dict(key)), float("inf"))

    def key(self, name: str) -> JWK:
        cached = self._keys.get(name)
        if cached and cached[1] > time.time():
            return cached[0]
        url = self._urls.get(name)
        if not url:
            raise KeyError(f"no trusted key configured for {name!r}")
        client = self._client or httpx.Client(timeout=10)
        doc = client.get(url.rstrip("/") + "/.well-known/jwks.json").raise_for_status().json()
        key = JWK(**doc["keys"][0])
        self._keys[name] = (key, time.time() + self._ttl)
        return key


# ── small helpers ───────────────────────────────────────────────────────────


def now() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def dollars(cents: int | float) -> str:
    return f"${int(cents) / 100:,.2f}"


@dataclass
class Ap2Error(Exception):
    """An AP2 action-authorization error (agent_authorization.md §Errors)."""

    code: (
        str  # invalid_credential | unresolved_constraint | invalid_mandate | mandates_not_supported
    )
    description: str

    def __str__(self) -> str:
        return f"{self.code}: {self.description}"
