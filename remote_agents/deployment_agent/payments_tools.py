"""Buying tools for the release agent: burst capacity paid for over AP2 (lab 86).

During a big rollout the release agent may need more build or canary
capacity. Northwind Compute sells it through an A2A sales agent that requires
the Agent Payments Protocol, so the agent plays the AP2 *Shopping Agent*:

===========================  ======================================================
Tool                         What happens
===========================  ======================================================
``search_capacity``          ask the merchant for offers and current prices
``prepare_purchase``         human present: get a signed checkout, open an approval
                             request; a person approves that exact checkout
``complete_purchase``        after approval: get a scoped card token, pay
``request_spending_limits``  human not present: ask a person to approve limits
                             once (blocks, merchant, per-purchase cap, budget,
                             number of purchases, expiry)
``check_spending_limits``    pick up the signed open mandates after approval
``buy_burst_capacity``       buy on its own within those limits
===========================  ======================================================

The model only decides *what* to buy. Mandate building, key binding,
constraint checks and receipt verification are deterministic code in
``payments.shopper``, and the merchant, wallet and processor check everything
again on their side.

Off unless ``AP2_MERCHANT_URL`` is set (the agent then gets these tools too).
"""

from __future__ import annotations

import os
from typing import Any

_SHOPPER: Any = None


def enabled() -> bool:
    return bool(os.environ.get("AP2_MERCHANT_URL", "").strip())


def use_shopper(shopper: Any) -> None:
    """Tests and single-process runs hand in their own shopper."""
    global _SHOPPER
    _SHOPPER = shopper


def _shopper() -> Any:
    global _SHOPPER
    if _SHOPPER is None:
        from payments.core import TrustStore
        from payments.shopper import Shopper

        merchant = os.environ["AP2_MERCHANT_URL"].rstrip("/")
        ts = os.environ.get("AP2_TRUSTED_SURFACE_URL", "http://127.0.0.1:8413")
        processor = os.environ.get("AP2_PROCESSOR_URL", "http://127.0.0.1:8412")
        _SHOPPER = Shopper(
            merchant_url=os.environ.get("AP2_MERCHANT_A2A_URL", f"{merchant}/a2a/northwind_sales"),
            credential_provider_url=os.environ.get(
                "AP2_CREDENTIAL_PROVIDER_URL", "http://127.0.0.1:8411"
            ),
            trusted_surface_url=ts,
            trust=TrustStore({"merchant": merchant, "processor": processor, "agent-provider": ts}),
        )
        # The approval link a person clicks may differ from the in-cluster URL.
        _SHOPPER.public_ts_url = os.environ.get("AP2_TRUSTED_SURFACE_PUBLIC_URL", ts).rstrip("/")
    return _SHOPPER


def _public(url: str) -> str:
    s = _shopper()
    public = getattr(s, "public_ts_url", None)
    return url.replace(s.ts_url, public, 1) if public else url


def _failure(err: Exception) -> dict[str, Any]:
    from payments.shopper import PurchaseError

    if isinstance(err, PurchaseError):
        return {
            "status": "refused",
            "refused_by": err.stage,
            "error": err.code,
            "reason": err.description,
        }
    return {"status": "error", "error": type(err).__name__, "reason": str(err)}


def _cents(usd: float) -> int:
    return int(round(float(usd) * 100))


def search_capacity(query: str = "burst") -> dict[str, Any]:
    """List Northwind Compute offers (node-hours, GPU hours, CI minutes), prices in cents."""
    try:
        return _shopper().search(query)
    except Exception as err:  # noqa: BLE001
        return _failure(err)


def prepare_purchase(sku: str, quantity: int) -> dict[str, Any]:
    """Human present: create a checkout and ask a person to approve exactly it.

    Returns an ``approval_url`` for the person and a ``request_id``. Nothing is
    paid until the person approves and you call ``complete_purchase``.
    """
    try:
        out = _shopper().prepare_direct(sku, int(quantity))
        return {
            "status": "awaiting_approval",
            "request_id": out["request_id"],
            "approval_url": _public(out["approval_url"]),
            "summary": out["summary"],
        }
    except Exception as err:  # noqa: BLE001
        return _failure(err)


def complete_purchase(request_id: str) -> dict[str, Any]:
    """Pay for a purchase a person approved with ``prepare_purchase``."""
    try:
        out = _shopper().complete_direct(request_id)
        if out["status"] != "purchased":
            return {"status": out["status"], "approval_url": _public(out.get("approval_url", ""))}
        return {
            "status": "purchased",
            "order_id": out["order_id"],
            "total_cents": out["total"],
            "payment_id": out["payment_receipt"]["payment_id"],
        }
    except Exception as err:  # noqa: BLE001
        return _failure(err)


def request_spending_limits(
    blocks: int = 4,
    max_per_purchase_usd: float = 10.0,
    budget_usd: float = 20.0,
    max_purchases: int = 2,
    valid_hours: int = 6,
    purpose: str = "burst capacity for a rollout",
) -> dict[str, Any]:
    """Human not present: ask a person to approve spending limits once.

    Covers burst node-hours in eu-west1 or us-east1 from Northwind Compute only,
    paid with the corporate card. Returns an ``approval_url`` for the person.
    """
    try:
        out = _shopper().request_delegation(
            skus=["nw-burst-node-hour-eu", "nw-burst-node-hour-us"],
            quantity=int(blocks),
            max_per_purchase=_cents(max_per_purchase_usd),
            budget=_cents(budget_usd),
            max_purchases=int(max_purchases),
            valid_hours=int(valid_hours),
            purpose=purpose,
        )
        return {
            "status": "awaiting_approval",
            "request_id": out["request_id"],
            "approval_url": _public(out["approval_url"]),
        }
    except Exception as err:  # noqa: BLE001
        return _failure(err)


def check_spending_limits(request_id: str) -> dict[str, Any]:
    """After the person approved ``request_spending_limits``: load the signed limits."""
    try:
        return _shopper().collect_delegation(request_id)
    except Exception as err:  # noqa: BLE001
        return _failure(err)


def buy_burst_capacity(region: str = "eu", blocks: int = 4) -> dict[str, Any]:
    """Buy burst node-hours on your own, inside the approved spending limits.

    ``region`` is ``eu`` or ``us``. Refused if no limits are approved or the
    purchase would break any of them.
    """
    from payments.core import sku_for

    sku = sku_for("eu-west1" if region.lower().startswith("eu") else "us-east1")
    if sku is None:
        return {
            "status": "refused",
            "refused_by": "agent",
            "error": "unknown_region",
            "reason": region,
        }
    try:
        out = _shopper().buy_autonomously(sku, int(blocks))
        return {
            "status": "purchased",
            "order_id": out["order_id"],
            "total_cents": out["total"],
            "spent_so_far": out["spent_so_far"],
            "payment_id": out["payment_receipt"]["payment_id"],
        }
    except Exception as err:  # noqa: BLE001
        return _failure(err)


ALL_TOOLS = [
    search_capacity,
    prepare_purchase,
    complete_purchase,
    request_spending_limits,
    check_spending_limits,
    buy_burst_capacity,
]

NAMES = {t.__name__ for t in ALL_TOOLS}
