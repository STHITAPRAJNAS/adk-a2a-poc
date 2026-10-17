"""AP2: the release agent buys burst capacity from Northwind Compute.

All four roles run in one process (``payments.mesh``) but every call still goes
through their real HTTP apps: JWKS fetches, A2A JSON-RPC to the merchant, the
wallet's challenge and redeem endpoints. The attack tests switch off the
shopper's own pre-checks where needed, to show the *other* parties refuse too:
the spec assumes the agent can be talked into anything.
"""

from __future__ import annotations

import pytest

pytest.importorskip("ap2.sdk", reason="AP2 SDK not installed (make install-payments)")

from payments import shopper as shopper_module  # noqa: E402
from payments.core import AP2_EXTENSION_URI, MERCHANT  # noqa: E402
from payments.mesh import CP_URL, MERCHANT_A2A_URL, PROCESSOR_URL, TS_URL, LocalMesh  # noqa: E402
from payments.shopper import PurchaseError  # noqa: E402

EU, US, GPU, CI = (
    "nw-burst-node-hour-eu",
    "nw-burst-node-hour-us",
    "nw-gpu-hour-l4-eu",
    "nw-ci-minutes-1000",
)


@pytest.fixture
def mesh():
    return LocalMesh()


@pytest.fixture
def agent(mesh):
    return mesh.shopper()


def delegate(mesh, agent, **overrides):
    limits = dict(
        skus=[EU, US],
        quantity=4,
        max_per_purchase=1000,
        budget=2000,
        max_purchases=2,
        valid_hours=6,
        purpose="0.9.0 rollout: burst capacity",
    )
    limits.update(overrides)
    req = agent.request_delegation(**limits)
    mesh.approve(req["request_id"])
    assert agent.collect_delegation(req["request_id"])["status"] == "approved"
    return agent.active_delegation()


@pytest.fixture
def no_agent_prechecks(monkeypatch):
    """A compromised or confused agent: it skips its own constraint checks."""
    monkeypatch.setattr(shopper_module, "check_checkout_constraints", lambda *a, **k: [])
    monkeypatch.setattr(shopper_module, "check_payment_constraints", lambda *a, **k: [])


# ── human present ──────────────────────────────────────────────────────────


def test_human_present_purchase(mesh, agent):
    prepared = agent.prepare_direct(CI, 1)
    assert prepared["summary"]["total"] == 800
    assert prepared["approval_url"].startswith(f"{TS_URL}/approve/")
    assert agent.complete_direct(prepared["request_id"])["status"] == "pending"

    mesh.approve(prepared["request_id"])
    done = agent.complete_direct(prepared["request_id"])
    assert done["status"] == "purchased"
    assert done["payment_receipt"]["status"] == "Success"
    assert done["checkout_receipt"]["order_id"] == done["order_id"]
    assert [o["order_id"] for o in mesh.merchant.orders] == [done["order_id"]]
    assert [t["state"] for t in mesh.http.get(f"{CP_URL}/usage").json()["tokens"]] == ["settled"]


def test_wrong_approval_code_is_refused(mesh, agent):
    prepared = agent.prepare_direct(CI, 1)
    resp = mesh.http.post(
        f"{TS_URL}/requests/{prepared['request_id']}/approve", json={"code": "000000"}
    )
    assert resp.status_code == 403
    assert agent.complete_direct(prepared["request_id"])["status"] == "pending"


def test_repriced_checkout_is_rejected(mesh, agent):
    prepared = agent.prepare_direct(EU, 4)
    mesh.approve(prepared["request_id"])
    mesh.http.post(f"{mesh_merchant_url()}/ops/prices", json={"sku": EU, "price": 300})
    with pytest.raises(PurchaseError) as err:
        agent.complete_direct(prepared["request_id"])
    assert err.value.code == "invalid_mandate"
    assert mesh.merchant.orders == []
    assert mesh.processor.payments == []


def test_completed_checkout_cannot_be_replayed(mesh, agent):
    prepared = agent.prepare_direct(CI, 1)
    mesh.approve(prepared["request_id"])
    checkout = agent.pending_direct[prepared["request_id"]]
    mandates = mesh.http.get(f"{TS_URL}/requests/{prepared['request_id']}").json()["mandates"]
    agent.complete_direct(prepared["request_id"])
    token = agent._payment_credential(
        mandates["payment_mandate"], checkout["checkout_hash"], None, None
    )
    with pytest.raises(PurchaseError, match="already completed"):
        agent._complete(checkout, mandates["checkout_mandate"], token)
    assert len(mesh.merchant.orders) == 1


def test_payment_token_is_single_use(mesh, agent):
    checkout = agent.create_checkout(CI, 1)
    req = mesh.http.post(
        f"{TS_URL}/requests",
        json={
            "kind": "direct",
            "checkout_jwt": checkout["checkout_jwt"],
            "instrument": agent.instrument(),
        },
    ).json()
    mesh.approve(req["id"])
    mandate = mesh.http.get(f"{TS_URL}/requests/{req['id']}").json()["mandates"]["payment_mandate"]
    token = agent._payment_credential(mandate, checkout["checkout_hash"], None, None)
    charge = {
        "payment_token": token,
        "checkout_hash": checkout["checkout_hash"],
        "amount": 800,
        "payee_id": MERCHANT["id"],
    }
    assert mesh.http.post(f"{PROCESSOR_URL}/initiate-payment", json=charge).status_code == 200
    second = mesh.http.post(f"{PROCESSOR_URL}/initiate-payment", json=charge)
    assert second.status_code == 402
    assert "already used" in second.json()["error_description"]


def test_tampered_mandate_is_refused(mesh, agent):
    prepared = agent.prepare_direct(CI, 1)
    mesh.approve(prepared["request_id"])
    mandate = mesh.http.get(f"{TS_URL}/requests/{prepared['request_id']}").json()["mandates"][
        "payment_mandate"
    ]
    jwt, rest = mandate.split("~", 1)
    head, body, sig = jwt.split(".")
    sig = sig[:10] + ("A" if sig[10] != "A" else "B") + sig[11:]
    forged = f"{head}.{body}.{sig}~{rest}"
    resp = mesh.http.post(
        f"{CP_URL}/payment-credentials",
        json={"payment_mandate": forged, "checkout_hash": prepared["checkout"]["checkout_hash"]},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_credential"


def test_missing_extension_header_gets_32008(mesh):
    resp = mesh.http.post(
        MERCHANT_A2A_URL,
        headers={"A2A-Version": "1.0"},
        json={
            "jsonrpc": "2.0",
            "id": "1",
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "m1",
                    "role": "ROLE_USER",
                    "parts": [{"data": {"commerce": {"op": "search"}}}],
                }
            },
        },
    )
    assert resp.json()["error"]["code"] == -32008
    assert resp.json()["error"]["data"]["required"] == [AP2_EXTENSION_URI]


def test_agent_card_requires_ap2(mesh):
    card = mesh.http.get(
        f"{mesh_merchant_url()}/a2a/northwind_sales/.well-known/agent-card.json"
    ).json()
    assert {"uri": AP2_EXTENSION_URI, "required": True}.items() <= card["capabilities"][
        "extensions"
    ][0].items()


# ── human not present ──────────────────────────────────────────────────────


def test_autonomous_purchases_within_limits(mesh, agent):
    d = delegate(mesh, agent)
    first = agent.buy_autonomously(EU, 4)
    second = agent.buy_autonomously(US, 4)
    assert (first["total"], second["total"]) == (960, 840)
    assert second["spent_so_far"] == "$18.00"
    usage = mesh.http.get(f"{CP_URL}/usage").json()["usage"]
    assert list(usage.values()) == [
        {
            "total_amount": 1800.0,
            "total_uses": 2,
            "last_used_date": usage[next(iter(usage))]["last_used_date"],
        }
    ]
    # Third purchase: over both the count and the budget. The agent stops itself.
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(EU, 4)
    assert err.value.code == "outside_limits"
    assert len(d.purchases) == 2


def test_wallet_enforces_limits_even_if_agent_does_not(mesh, agent, no_agent_prechecks):
    delegate(mesh, agent, max_purchases=1)
    agent.buy_autonomously(EU, 4)
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(US, 4)
    assert (err.value.stage, err.value.code) == ("credential_provider", "unresolved_constraint")
    assert "occurrences" in err.value.description.lower()
    assert len(mesh.merchant.orders) == 1


def test_over_the_per_purchase_limit(mesh, agent, no_agent_prechecks):
    delegate(mesh, agent, max_per_purchase=900)
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(EU, 4)
    assert err.value.code == "unresolved_constraint"
    assert mesh.processor.payments == []


def test_merchant_refuses_items_outside_the_mandate(mesh, agent, no_agent_prechecks):
    delegate(mesh, agent, max_per_purchase=100000, budget=100000)
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(GPU, 4)
    assert (err.value.stage, err.value.code) == ("merchant", "unresolved_constraint")
    assert mesh.merchant.orders == []
    states = [t["state"] for t in mesh.http.get(f"{CP_URL}/usage").json()["tokens"]]
    assert states == ["voided"]  # the agent released the credential after the rejection


def test_more_blocks_than_approved_is_refused(mesh, agent, no_agent_prechecks):
    # The SDK reads a line-item quantity as an upper bound: 4 approved, 5 refused.
    delegate(mesh, agent, max_per_purchase=100000, budget=100000)
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(EU, 5)
    assert (err.value.stage, err.value.code) == ("merchant", "unresolved_constraint")


def test_mandate_for_another_merchant_is_refused(mesh, agent, no_agent_prechecks, monkeypatch):
    other = {"id": "contoso-cloud", "name": "Contoso Cloud", "website": "https://contoso.example"}
    monkeypatch.setattr(shopper_module, "MERCHANT", other)
    delegate(mesh, agent)
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(EU, 4)
    assert err.value.code == "unresolved_constraint"
    assert mesh.processor.payments == []


def test_open_mandate_not_presented_twice_while_unresolved(mesh, agent):
    d = delegate(mesh, agent)
    d.inflight = True
    with pytest.raises(PurchaseError, match="still unresolved"):
        agent.buy_autonomously(EU, 4)
    d.inflight = False

    # The wallet holds the same line if the agent ignores it.
    checkout = agent.create_checkout(EU, 4)
    from ap2.sdk.generated.payment_mandate import PaymentMandate
    from ap2.sdk.generated.types.amount import Amount
    from ap2.sdk.generated.types.merchant import Merchant
    from ap2.sdk.generated.types.payment_instrument import PaymentInstrument

    closed = PaymentMandate(
        transaction_id=checkout["checkout_hash"],
        payee=Merchant(**MERCHANT),
        payment_amount=Amount(amount=960, currency="USD"),
        payment_instrument=PaymentInstrument(**agent.instrument()),
    )

    def present():
        nonce = mesh.http.post(f"{CP_URL}/payment-credentials/challenge").json()["nonce"]
        token = agent.client.present(
            holder_key=agent.key,
            mandate_token=d.open_payment,
            payloads=[closed],
            nonce=nonce,
            aud="credential-provider",
        )
        return mesh.http.post(
            f"{CP_URL}/payment-credentials",
            json={
                "payment_mandate": token,
                "checkout_hash": checkout["checkout_hash"],
                "nonce": nonce,
                "open_checkout_hash": d.open_checkout_hash,
            },
        )

    assert present().status_code == 200
    second = present()
    assert second.status_code == 400
    assert "still unresolved" in second.json()["error_description"]


def test_nonce_cannot_be_reused(mesh, agent):
    d = delegate(mesh, agent)
    checkout = agent.create_checkout(EU, 4)
    from ap2.sdk.generated.payment_mandate import PaymentMandate
    from ap2.sdk.generated.types.amount import Amount
    from ap2.sdk.generated.types.merchant import Merchant
    from ap2.sdk.generated.types.payment_instrument import PaymentInstrument

    closed = PaymentMandate(
        transaction_id=checkout["checkout_hash"],
        payee=Merchant(**MERCHANT),
        payment_amount=Amount(amount=960, currency="USD"),
        payment_instrument=PaymentInstrument(**agent.instrument()),
    )
    nonce = mesh.http.post(f"{CP_URL}/payment-credentials/challenge").json()["nonce"]
    token = agent.client.present(
        holder_key=agent.key,
        mandate_token=d.open_payment,
        payloads=[closed],
        nonce=nonce,
        aud="credential-provider",
    )
    body = {
        "payment_mandate": token,
        "checkout_hash": checkout["checkout_hash"],
        "nonce": nonce,
        "open_checkout_hash": d.open_checkout_hash,
    }
    first = mesh.http.post(f"{CP_URL}/payment-credentials", json=body)
    assert first.status_code == 200
    mesh.http.post(
        f"{CP_URL}/payment-credentials/release",
        json={"payment_token": first.json()["payment_token"]},
    )
    replay = mesh.http.post(f"{CP_URL}/payment-credentials", json=body)
    assert replay.status_code == 400
    assert "nonce" in replay.json()["error_description"]


def test_no_delegation_means_no_autonomous_purchase(agent):
    with pytest.raises(PurchaseError) as err:
        agent.buy_autonomously(EU, 4)
    assert err.value.code == "no_mandate"


def mesh_merchant_url() -> str:
    return MERCHANT_A2A_URL.rsplit("/a2a/", 1)[0]


# ── the release agent drives it (scripted model, real ADK runner) ─────────


@pytest.fixture
def release_agent(mesh, monkeypatch):
    from google.adk.runners import InMemoryRunner

    from remote_agents.deployment_agent import agent as agent_module
    from remote_agents.deployment_agent import payments_tools

    monkeypatch.setenv("AP2_MERCHANT_URL", "http://merchant.ap2.local")
    monkeypatch.setenv("POC_FAKE_LLM", "1")
    payments_tools.use_shopper(mesh.shopper())
    runner = InMemoryRunner(agent=agent_module.build_agent(), app_name="deployment_agent")
    session = runner.session_service.create_session_sync(app_name="deployment_agent", user_id="u")

    def say(text: str) -> str:
        from google.genai import types

        msg = types.Content(role="user", parts=[types.Part(text=text)])
        out = []
        for event in runner.run(user_id="u", session_id=session.id, new_message=msg):
            for part in (event.content.parts if event.content else None) or []:
                if part.text:
                    out.append(part.text)
        return out[-1] if out else ""

    yield say
    payments_tools.use_shopper(None)


def test_release_agent_buys_within_approved_limits(mesh, release_agent):
    import re

    reply = release_agent("set spending limits for burst capacity during the 0.9.0 rollout")
    request_id = re.search(r"req_[0-9a-f]+", reply).group(0)
    assert "approve" in reply.lower()
    mesh.approve(request_id)
    assert "approved" in release_agent(f"check spending limits {request_id}")
    assert "Bought: order" in release_agent("buy burst capacity in eu")
    assert "Bought: order" in release_agent("buy burst capacity in us")
    third = release_agent("buy burst capacity in eu")
    assert "refused by the agent" in third and "outside_limits" in third
    assert len(mesh.merchant.orders) == 2


def test_release_agent_human_present_purchase(mesh, release_agent):
    import re

    reply = release_agent("buy 1,000 CI minutes")
    request_id = re.search(r"req_[0-9a-f]+", reply).group(0)
    mesh.approve(request_id)
    assert "Bought: order" in release_agent(f"I approved {request_id}, continue")
