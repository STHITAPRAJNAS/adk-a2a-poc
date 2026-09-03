"""End-to-end tests through the orchestrator's ADK runner.

These exercise the client half: the orchestrator delegates to the remote agent,
the remote's pending long-running call comes back as a real ADK function call,
and a function response posted into the orchestrator's session is routed onto
the same A2A task.

They run the orchestrator in process against a real remote server, so the A2A
hop is genuine — only the models are scripted.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest
from google.adk.events.event import Event
from google.adk.runners import InMemoryRunner
from google.genai import types

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENTS_DIR = REPO_ROOT / "agents"
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

pytestmark = pytest.mark.asyncio

A2A_TASK_ID = "a2a:task_id"

PROD_RELEASE = "Please deploy checkout-api 2.14.0 to production."
BILLING_RELEASE = "Please deploy billing-worker 3.1.0 to production."


@pytest.fixture
async def orchestrator(remote_a2a_server):
    """A runner over the real ops_concierge app, plus a fresh session."""
    import ops_concierge  # imported late so conftest has set POC_FAKE_LLM

    runner = InMemoryRunner(app=ops_concierge.app)
    session = await runner.session_service.create_session(
        app_name="ops_concierge", user_id="pytest-operator"
    )
    yield runner, session.id
    await runner.close()


async def _turn(runner, session_id: str, message: types.Content) -> list[Event]:
    return [
        event
        async for event in runner.run_async(
            user_id="pytest-operator", session_id=session_id, new_message=message
        )
    ]


def _text(message: str) -> types.Content:
    return types.Content(role="user", parts=[types.Part(text=message)])


def _function_response(call_id: str, name: str, payload: dict[str, Any]) -> types.Content:
    return types.Content(
        role="user",
        parts=[
            types.Part(
                function_response=types.FunctionResponse(id=call_id, name=name, response=payload)
            )
        ],
    )


def _pending_call(events: list[Event]) -> tuple[str, str, dict] | None:
    """Returns (call_id, name, args) for the newest unresolved long-running call."""
    for event in reversed(events):
        for call_id in event.long_running_tool_ids or ():
            for call in event.get_function_calls():
                if call.id == call_id:
                    return call.id, call.name, dict(call.args or {})
    return None


def _tool_response(events: list[Event], name: str) -> dict | None:
    for event in reversed(events):
        for response in event.get_function_responses():
            if response.name == name and isinstance(response.response, dict):
                return response.response
    return None


def _task_ids(events: list[Event]) -> set[str]:
    return {
        event.custom_metadata[A2A_TASK_ID]
        for event in events
        if event.custom_metadata and A2A_TASK_ID in event.custom_metadata
    }


async def test_orchestrator_delegates_over_a2a_and_parks_on_the_human_gate(orchestrator):
    runner, session_id = orchestrator
    events = await _turn(runner, session_id, _text(PROD_RELEASE))

    transfers = [
        call.args["agent_name"]
        for event in events
        for call in event.get_function_calls()
        if call.name == "transfer_to_agent"
    ]
    assert transfers == ["deployment_agent"], "the concierge must hand release work to the remote"

    task_ids = _task_ids(events)
    assert len(task_ids) == 1, "the whole exchange should ride one A2A task"

    pending = _pending_call(events)
    assert pending is not None, "the remote's approval gate did not reach the orchestrator"
    _, name, args = pending
    assert name == "request_change_approval"
    assert args["environment"] == "production"


async def test_approval_resumes_the_same_a2a_task(orchestrator):
    runner, session_id = orchestrator
    first = await _turn(runner, session_id, _text(PROD_RELEASE))
    task_id = _task_ids(first).pop()
    call_id, name, _ = _pending_call(first)
    ticket = _tool_response(first, "request_change_approval")["ticket_id"]

    second = await _turn(
        runner,
        session_id,
        _function_response(
            call_id, name, {"ticket_id": ticket, "approved": True, "decided_by": "pytest"}
        ),
    )
    assert second, "approving produced no events; the resume was dropped"
    assert _task_ids(second) == {task_id}, "the resume must land on the original A2A task"

    pending = _pending_call(second)
    assert pending is not None
    assert pending[1] == "start_deployment"
    assert pending[2]["approval_ticket"] == ticket


async def test_full_flow_reaches_a_deployed_state(orchestrator, settings):
    """The whole PoC in one test: delegate, gate on a human, run a job, report."""
    runner, session_id = orchestrator
    first = await _turn(runner, session_id, _text(PROD_RELEASE))
    task_id = _task_ids(first).pop()

    # 1. human approves the change
    call_id, name, _ = _pending_call(first)
    ticket = _tool_response(first, "request_change_approval")["ticket_id"]
    second = await _turn(
        runner,
        session_id,
        _function_response(call_id, name, {"ticket_id": ticket, "approved": True}),
    )

    # 2. a watcher polls the background job the remote started
    started = _tool_response(second, "start_deployment")
    job_id = started["job_id"]
    async with httpx.AsyncClient(timeout=30) as client:
        url = f"{settings.remote_agent_base_url}/ops/jobs/{job_id}"
        deadline = settings.deployment_job_seconds * 4 + 30
        for _ in range(deadline):
            job = (await client.get(url)).json()
            if job["state"] in ("succeeded", "failed"):
                break
            await asyncio.sleep(1)
    assert job["state"] == "succeeded", f"deployment job did not finish: {job}"

    # 3. the terminal result goes back in as the response to the long-running call
    call_id, name, _ = _pending_call(second)
    third = await _turn(runner, session_id, _function_response(call_id, name, job["result"]))

    assert _task_ids(third) == {task_id}
    assert _pending_call(third) is None, "nothing should still be pending"
    final = " ".join(
        part.text
        for event in third
        for part in (event.content.parts if event.content else []) or []
        if part.text
    )
    assert "succeeded" in final
    assert ticket in final


async def test_rejection_stops_the_release(orchestrator):
    runner, session_id = orchestrator
    first = await _turn(runner, session_id, _text(BILLING_RELEASE))
    call_id, name, _ = _pending_call(first)
    ticket = _tool_response(first, "request_change_approval")["ticket_id"]

    second = await _turn(
        runner,
        session_id,
        _function_response(
            call_id,
            name,
            {"ticket_id": ticket, "approved": False, "note": "outside the change window"},
        ),
    )
    assert _pending_call(second) is None, "a rejected change must not start a deployment"
    final = " ".join(
        part.text
        for event in second
        for part in (event.content.parts if event.content else []) or []
        if part.text
    )
    assert "rejected" in final.lower()
    assert "outside the change window" in final


async def test_non_release_chat_stays_local(orchestrator):
    """A question that is not release work must not open an A2A task at all."""
    runner, session_id = orchestrator
    events = await _turn(runner, session_id, _text("hello, who are you?"))
    assert not _task_ids(events)
    assert not any(
        call.name == "transfer_to_agent"
        for event in events
        for call in event.get_function_calls()
    )
