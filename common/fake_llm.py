"""A deterministic, scripted stand-in for Gemini.

Set ``POC_FAKE_LLM=1`` and both agents run on this instead of the real model.
Nothing about the A2A wire behaviour changes — the same tools are called, the
same long-running function calls are issued, the same task states appear — but
the run is reproducible and needs no API key, which makes it usable in tests and
in a first walkthrough.

This is a rule engine, not a model. It reads the conversation so far and decides
the next move from the tool results it can see.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from collections.abc import AsyncGenerator, Callable

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types

logger = logging.getLogger(__name__)

FAKE_MODEL_NAME = "poc-scripted-model"

Decider = Callable[["Conversation"], LlmResponse]


class Conversation:
    """A read-only view over the contents ADK is about to send to the model."""

    def __init__(self, contents: list[types.Content]) -> None:
        self.contents = contents

    def last_user_text(self) -> str:
        for content in reversed(self.contents):
            if content.role == "user" and content.parts:
                text = " ".join(p.text for p in content.parts if p.text)
                if text.strip():
                    return text.strip()
        return ""

    def function_responses(self) -> list[types.FunctionResponse]:
        out: list[types.FunctionResponse] = []
        for content in self.contents:
            for part in content.parts or []:
                if part.function_response is not None:
                    out.append(part.function_response)
        return out

    def response_for(self, name: str) -> dict | None:
        """Returns the newest response payload for a named tool, if any."""
        for fr in reversed(self.function_responses()):
            if fr.name == name:
                response = fr.response
                if isinstance(response, dict):
                    return response
                return {"result": response}
        return None

    def called(self, name: str) -> bool:
        for content in self.contents:
            for part in content.parts or []:
                if part.function_call is not None and part.function_call.name == name:
                    return True
        return False

    def latest_policy_denial(self) -> dict | None:
        """The newest tool response the OPA guard blocked, if any.

        The guard (common.opa_guard) returns ``{"error": "denied_by_policy", ...}``
        in place of running a tool. A real model would read that and report it;
        the scripted model does the same so the demo output is clean.
        """
        for fr in reversed(self.function_responses()):
            resp = fr.response if isinstance(fr.response, dict) else {}
            if resp.get("error") == "denied_by_policy":
                return {"tool": fr.name, **resp}
        return None


def _text(message: str) -> LlmResponse:
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=message)])
    )


def _call(name: str, **args: object) -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=f"fc-{uuid.uuid4().hex[:12]}", name=name, args=dict(args)
                    )
                )
            ],
        )
    )


class ScriptedLlm(BaseLlm):
    """A ``BaseLlm`` that delegates the next move to a pure Python decider."""

    decider: Decider

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        conversation = Conversation(list(llm_request.contents or []))
        response = self.decider(conversation)
        logger.debug(
            "ScriptedLlm(%s) -> %s",
            self.model,
            response.content.parts[0] if response.content and response.content.parts else None,
        )
        yield response


# ---------------------------------------------------------------------------
# Orchestrator script
# ---------------------------------------------------------------------------

_RELEASE_WORDS = (
    "deploy", "release", "roll out", "rollout", "ship",
    "readiness", "compliance", "approval", "promote",
    "buy", "purchase", "capacity", "spending", "approved",
)


def _orchestrator_decider(conversation: Conversation) -> LlmResponse:
    denial = conversation.latest_policy_denial()
    if denial:
        return _text(f"Blocked by policy: cannot run `{denial['tool']}`. {denial.get('message', '')}")
    text = conversation.last_user_text().lower()
    if any(word in text for word in _RELEASE_WORDS):
        return _call("transfer_to_agent", agent_name="deployment_agent")
    # Quote the question back: when a turn is answered twice (the AG-UI replica
    # replay in agui/), the duplicate shows exactly which question it was.
    asked = conversation.last_user_text().strip()
    return _text(
        (f'You asked: "{asked[:80]}". ' if asked else "")
        + "I am the Ops Concierge. I don't run releases myself — I hand anything about "
        "readiness, compliance, change approval or deployment to the remote "
        "release-operations agent over A2A. Try: "
        '"deploy checkout-api 2.14.0 to production".'
    )


def build_orchestrator_model() -> ScriptedLlm:
    return ScriptedLlm(model=f"{FAKE_MODEL_NAME}/ops_concierge", decider=_orchestrator_decider)


# ---------------------------------------------------------------------------
# Deployment agent script
# ---------------------------------------------------------------------------


def _parse_release_request(text: str) -> tuple[str, str, str]:
    """Best-effort extraction of (service, version, environment) from free text."""
    service, version, environment = "checkout-api", "2.14.0", "production"
    tokens = text.replace(",", " ").split()
    for token in tokens:
        cleaned = token.strip(".:;'\"")
        if "-" in cleaned and not cleaned[0].isdigit() and cleaned.lower() not in ("roll-out",):
            service = cleaned
            break
    for token in tokens:
        cleaned = token.strip(".:;'\"v")
        if cleaned and cleaned[0].isdigit() and "." in cleaned:
            version = cleaned
            break
    lowered = text.lower()
    if "staging" in lowered:
        environment = "staging"
    return service, version, environment


_REQUEST_ID = re.compile(r"\breq_[0-9a-f]{8,}\b")


def _payments_decider(conversation: Conversation) -> LlmResponse | None:
    """Lab 86: buying burst capacity over AP2. None when the turn is not about buying."""
    last = conversation.contents[-1] if conversation.contents else None
    ran = [p.function_response for p in (last.parts or []) if p.function_response] if last else []
    if ran and ran[0].name in _PAYMENT_TOOLS:
        resp = ran[0].response if isinstance(ran[0].response, dict) else {}
        status = resp.get("status")
        if status == "awaiting_approval":
            return _text(
                f"Approval needed ({resp.get('request_id')}): open {resp.get('approval_url')} "
                "and approve, then tell me to continue with that request id."
            )
        if status == "refused":
            return _text(
                f"Purchase refused by the {resp.get('refused_by')}: {resp.get('error')}: "
                f"{resp.get('reason')}. Nothing was bought; I will not retry around a refusal."
            )
        if status == "purchased":
            return _text(
                f"Bought: order {resp.get('order_id')} for "
                f"${resp.get('total_cents', 0) / 100:.2f} (payment {resp.get('payment_id')})."
            )
        if status == "approved":
            limits = resp.get("limits")
            return _text(f"Spending limits approved; I can now buy within them: {limits}")
        return _text(f"{ran[0].name}: {json.dumps(resp, default=str)}")

    text = conversation.last_user_text()
    lowered = text.lower()
    request_id = (_REQUEST_ID.search(text) or [None])[0]
    if not request_id and not any(w in lowered for w in _PAYMENT_WORDS):
        return None
    if "limit" in lowered or "spending" in lowered or "delegat" in lowered:
        if request_id:
            return _call("check_spending_limits", request_id=request_id)
        return _call("request_spending_limits", purpose=text[:120])
    if request_id:
        return _call("complete_purchase", request_id=request_id)
    if "ci" in lowered.split() or "minutes" in lowered:
        return _call("prepare_purchase", sku="nw-ci-minutes-1000", quantity=1)
    if "offer" in lowered or "price" in lowered:
        return _call("search_capacity", query="burst")
    return _call("buy_burst_capacity", region="us" if " us" in f" {lowered}" else "eu", blocks=4)


_PAYMENT_WORDS = ("buy", "purchase", "capacity", "spending", "limits", "offers")
_PAYMENT_TOOLS = {
    "search_capacity",
    "prepare_purchase",
    "complete_purchase",
    "request_spending_limits",
    "check_spending_limits",
    "buy_burst_capacity",
}


def _deployment_decider(conversation: Conversation) -> LlmResponse:
    denial = conversation.latest_policy_denial()
    if denial:
        return _text(f"Blocked by policy: cannot run `{denial['tool']}`. {denial.get('message', '')}")
    if os.environ.get("AP2_MERCHANT_URL", "").strip():  # payments_tools.enabled()
        decided = _payments_decider(conversation)
        if decided is not None:
            return decided
    request_text = conversation.last_user_text()
    service, version, environment = _parse_release_request(request_text)

    readiness = conversation.response_for("check_release_readiness")
    if readiness is None:
        return _call(
            "check_release_readiness",
            service=service,
            version=version,
            environment=environment,
        )

    service = readiness.get("service", service)
    version = readiness.get("version", version)
    environment = readiness.get("environment", environment)

    if readiness.get("blockers"):
        return _text(
            f"Release blocked for {service} {version} -> {environment}: "
            + "; ".join(readiness["blockers"])
        )

    scan = conversation.response_for("run_compliance_scan")
    if scan is None:
        return _call("run_compliance_scan", service=service, environment=environment)
    if not scan.get("passed", True):
        return _text(f"Compliance scan failed for {service}: {scan.get('findings')}")

    approval = conversation.response_for("request_change_approval")
    if readiness.get("requires_human_approval") and approval is None:
        return _call(
            "request_change_approval",
            service=service,
            version=version,
            environment=environment,
            summary=f"Release {service} {version} to {environment}",
            risk=readiness.get("risk", "medium"),
        )

    if approval is not None and approval.get("status") == "pending_human_approval":
        # The gate is still open: ADK pauses the invocation here and this decider
        # is not reached again until a decision arrives.
        return _text(
            f"Waiting on human approval for ticket {approval.get('ticket_id')}."
        )

    if approval is not None and not approval.get("approved", False):
        note = approval.get("note") or "no rationale given"
        return _text(
            f"Release rejected for {service} {version} -> {environment}. "
            f"Ticket {approval.get('ticket_id', 'unknown')}; note: {note}. Nothing was deployed."
        )

    ticket = (approval or {}).get("ticket_id", "CHG-UNKNOWN")

    deployment = conversation.response_for("start_deployment")
    if deployment is None:
        return _call(
            "start_deployment",
            service=service,
            version=version,
            environment=environment,
            approval_ticket=ticket,
        )
    if deployment.get("status") == "running":
        return _text(
            f"Deployment job {deployment.get('job_id')} is running; awaiting its result."
        )

    return _text(
        f"Deployment of {service} {version} to {environment} finished with status "
        f"'{deployment.get('status')}' under approval ticket {ticket}. "
        f"Details: {json.dumps(deployment, default=str)}"
    )


def build_deployment_agent_model() -> ScriptedLlm:
    return ScriptedLlm(model=f"{FAKE_MODEL_NAME}/deployment_agent", decider=_deployment_decider)
