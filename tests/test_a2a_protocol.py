"""Wire-level tests against one running A2A agent.

These bypass ADK's client entirely and speak JSON-RPC through
``common.a2a_wire``, so they pin the exact protocol behaviour the PoC
demonstrates:

  * a long-running tool call ends the task in ``input-required``, not
    ``completed``;
  * the pending call travels as a DataPart tagged ``adk_is_long_running``;
  * a function-response DataPart on the same ``taskId`` resumes it;
  * plain text on a paused task does not.
"""

from __future__ import annotations

import httpx
import pytest

from common.a2a_wire import (
    COMPLETED_STATES,
    PAUSED_STATES,
    A2AWireClient,
    function_response_message,
    text_message,
)

pytestmark = pytest.mark.asyncio

PROD_RELEASE = "Please deploy checkout-api 2.14.0 to production."


@pytest.fixture
async def agent(remote_a2a_server, settings):
    timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as http:
        yield A2AWireClient(
            http,
            settings.deployment_agent_rpc_url,
            card_url=settings.deployment_agent_card_url,
        )


async def _paused_task(agent: A2AWireClient, prompt: str = PROD_RELEASE):
    turn = await agent.stream(text_message(prompt))
    assert turn.error is None, turn.error
    assert turn.is_paused, f"expected the task to pause, got {turn.states}"
    return turn


async def test_production_release_parks_the_task_in_input_required(agent):
    turn = await agent.stream(text_message(PROD_RELEASE))

    assert turn.states[0] == "submitted"
    assert "working" in turn.states
    assert turn.final_state == "input-required", (
        "a pending long-running call must leave the task awaiting input, not completed"
    )

    pending = turn.pending
    assert pending is not None, "the pending call was not surfaced as a long-running DataPart"
    assert pending.name == "request_change_approval"
    assert pending.call_id
    assert pending.args["environment"] == "production"


async def test_staging_release_skips_the_human_gate(agent):
    """Staging needs no approval, so the task parks on the job, not the gate."""
    turn = await agent.stream(text_message("Deploy checkout-api 2.14.0 to staging."))

    readiness = turn.tool_responses["check_release_readiness"]
    assert readiness["requires_human_approval"] is False
    assert "request_change_approval" not in turn.tool_responses
    assert [call.name for call in turn.pending_calls] == ["start_deployment"]
    assert turn.final_state in PAUSED_STATES


async def test_blocked_release_completes_without_asking_a_human(agent):
    turn = await agent.stream(text_message("Deploy search-indexer 0.9.1 to production."))

    assert turn.final_state in COMPLETED_STATES
    assert not turn.pending_calls
    assert turn.tool_responses["check_release_readiness"]["ready"] is False


async def test_function_response_resumes_the_same_task(agent):
    turn = await _paused_task(agent)
    pending = turn.pending
    ticket = turn.tool_responses["request_change_approval"]["ticket_id"]

    resumed = await agent.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"ticket_id": ticket, "approved": True, "decided_by": "pytest"},
            task_id=turn.task_id,
            context_id=turn.context_id,
        )
    )

    assert resumed.error is None, resumed.error
    assert resumed.task_id == turn.task_id, "the resume must land on the original task"
    assert resumed.pending is not None, "approving should have started the deployment job"
    assert resumed.pending.name == "start_deployment"
    assert resumed.pending.args["approval_ticket"] == ticket
    assert resumed.final_state in PAUSED_STATES


async def test_rejecting_the_change_ends_the_task_without_deploying(agent):
    turn = await _paused_task(agent, "Please deploy billing-worker 3.1.0 to production.")
    pending = turn.pending
    ticket = turn.tool_responses["request_change_approval"]["ticket_id"]

    resumed = await agent.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"ticket_id": ticket, "approved": False, "note": "outside change window"},
            task_id=turn.task_id,
            context_id=turn.context_id,
        )
    )

    assert resumed.final_state in COMPLETED_STATES
    assert not resumed.pending_calls, "a rejected change must not start a deployment"


async def test_tasks_get_reports_the_paused_state(agent):
    turn = await _paused_task(agent)
    task = await agent.get_task(turn.task_id)

    assert task["id"] == turn.task_id
    assert task["status"]["state"] == "input-required"
    assert task["history"], "the task should retain its message history"


async def test_a_paused_task_answered_with_text_completes_unanswered(agent):
    """Documents the trap: text does not resume a gate, it ends the task.

    ADK re-runs the agent with the text as ordinary input. No new long-running
    call is issued, so the task reaches a terminal state and the original gate
    can never be answered.
    """
    turn = await _paused_task(agent)
    pending = turn.pending

    after_text = await agent.stream(
        text_message("yes, go ahead", task_id=turn.task_id, context_id=turn.context_id)
    )
    assert after_text.final_state in COMPLETED_STATES

    refused = await agent.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"approved": True},
            task_id=turn.task_id,
            context_id=turn.context_id,
        )
    )
    assert refused.error is not None, "a terminal task must refuse a late function response"
    assert "terminal" in str(refused.error).lower() or "completed" in str(refused.error).lower()
