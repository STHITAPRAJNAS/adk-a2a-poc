"""Wire-level tests against the running A2A server.

These bypass ADK's client entirely and speak JSON-RPC, so they pin the exact
protocol behaviour the PoC is meant to demonstrate:

  * a long-running tool call ends the task in ``input-required``, not
    ``completed``;
  * the pending call travels as a DataPart tagged ``adk_is_long_running``;
  * a function-response DataPart on the same ``taskId`` resumes it.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest

ADK_TYPE_KEY = "adk_type"
ADK_LONG_RUNNING_KEY = "adk_is_long_running"

pytestmark = pytest.mark.asyncio


def _rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}


async def _stream(client: httpx.AsyncClient, url: str, message: dict[str, Any]) -> list[dict]:
    """POSTs ``message/stream`` and returns every JSON-RPC result frame."""
    frames: list[dict] = []
    async with client.stream(
        "POST", url, json=_rpc("message/stream", {"message": message}),
        headers={"Accept": "text/event-stream"},
    ) as response:
        assert response.status_code == 200
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" not in content_type:
            body = json.loads((await response.aread()).decode())
            pytest.fail(f"expected a stream, got a JSON-RPC body: {body}")
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: ") :]))
    return frames


def _results(frames: list[dict]) -> list[dict]:
    return [frame["result"] for frame in frames if "result" in frame]


def _states(frames: list[dict]) -> list[str]:
    seen: list[str] = []
    for result in _results(frames):
        state = (result.get("status") or {}).get("state")
        if state and (not seen or seen[-1] != state):
            seen.append(state)
    return seen


def _long_running_calls(frames: list[dict]) -> list[dict]:
    """Pending long-running calls, deduplicated by call id and in first-seen order.

    ADK emits each pending call twice: once inside the ``working`` update that
    carries the model turn, and again in the terminal ``input-required`` update
    that summarises what the task is waiting on.
    """
    calls: dict[str, dict] = {}
    for result in _results(frames):
        message = (result.get("status") or {}).get("message") or {}
        for part in message.get("parts") or []:
            metadata = part.get("metadata") or {}
            if metadata.get(ADK_LONG_RUNNING_KEY):
                data = part["data"]
                calls.setdefault(data["id"], data)
    return list(calls.values())


def _tool_responses(frames: list[dict]) -> dict[str, dict]:
    responses: dict[str, dict] = {}
    for result in _results(frames):
        message = (result.get("status") or {}).get("message") or {}
        for part in message.get("parts") or []:
            metadata = part.get("metadata") or {}
            if metadata.get(ADK_TYPE_KEY) == "function_response":
                data = part.get("data") or {}
                if isinstance(data.get("response"), dict) and data.get("name"):
                    responses[data["name"]] = data["response"]
    return responses


def _text_message(text: str, *, task_id: str | None = None, context_id: str | None = None):
    message: dict[str, Any] = {
        "messageId": uuid.uuid4().hex,
        "kind": "message",
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
    }
    if task_id:
        message["taskId"] = task_id
    if context_id:
        message["contextId"] = context_id
    return message


def _function_response_message(
    *, call_id: str, name: str, payload: dict, task_id: str, context_id: str | None
):
    message: dict[str, Any] = {
        "messageId": uuid.uuid4().hex,
        "kind": "message",
        "role": "user",
        "taskId": task_id,
        "parts": [
            {
                "kind": "data",
                "data": {"id": call_id, "name": name, "response": payload},
                "metadata": {ADK_TYPE_KEY: "function_response"},
            }
        ],
    }
    if context_id:
        message["contextId"] = context_id
    return message


def _task_ids(frames: list[dict]) -> tuple[str, str | None]:
    for result in _results(frames):
        task_id = result.get("id") or result.get("taskId")
        if task_id:
            return task_id, result.get("contextId")
    raise AssertionError("no task id appeared in the stream")


@pytest.fixture
async def client():
    timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as http_client:
        yield http_client


async def test_production_release_parks_the_task_in_input_required(
    client, remote_a2a_server, settings
):
    frames = await _stream(
        client,
        settings.deployment_agent_rpc_url,
        _text_message("Please deploy checkout-api 2.14.0 to production."),
    )
    states = _states(frames)
    assert states[0] == "submitted"
    assert "working" in states
    assert states[-1] == "input-required", (
        "a pending long-running call must leave the task awaiting input, not completed"
    )

    calls = _long_running_calls(frames)
    assert calls, "the pending call was not surfaced as a long-running DataPart"
    assert calls[-1]["name"] == "request_change_approval"
    assert calls[-1]["id"]
    assert calls[-1]["args"]["environment"] == "production"


async def test_staging_release_skips_the_human_gate(client, remote_a2a_server, settings):
    """Staging needs no approval, so the task should park on the job, not the gate."""
    frames = await _stream(
        client,
        settings.deployment_agent_rpc_url,
        _text_message("Deploy checkout-api 2.14.0 to staging."),
    )
    readiness = _tool_responses(frames)["check_release_readiness"]
    assert readiness["requires_human_approval"] is False
    assert "request_change_approval" not in _tool_responses(frames)

    calls = _long_running_calls(frames)
    assert [call["name"] for call in calls] == ["start_deployment"]
    assert _states(frames)[-1] == "input-required"


async def test_blocked_release_completes_without_asking_a_human(
    client, remote_a2a_server, settings
):
    frames = await _stream(
        client,
        settings.deployment_agent_rpc_url,
        _text_message("Deploy search-indexer 0.9.1 to production."),
    )
    assert _states(frames)[-1] == "completed"
    assert not _long_running_calls(frames)
    readiness = _tool_responses(frames)["check_release_readiness"]
    assert readiness["ready"] is False


async def test_function_response_resumes_the_same_task(client, remote_a2a_server, settings):
    url = settings.deployment_agent_rpc_url
    frames = await _stream(
        client, url, _text_message("Please deploy checkout-api 2.14.0 to production.")
    )
    task_id, context_id = _task_ids(frames)
    pending = _long_running_calls(frames)[-1]
    ticket = _tool_responses(frames)["request_change_approval"]["ticket_id"]

    resumed = await _stream(
        client,
        url,
        _function_response_message(
            call_id=pending["id"],
            name=pending["name"],
            payload={"ticket_id": ticket, "approved": True, "decided_by": "pytest"},
            task_id=task_id,
            context_id=context_id,
        ),
    )
    # Same task, moved on to the next gate rather than starting over.
    assert _task_ids(resumed)[0] == task_id
    next_calls = _long_running_calls(resumed)
    assert next_calls, "approving should have started the deployment job"
    assert next_calls[-1]["name"] == "start_deployment"
    assert next_calls[-1]["args"]["approval_ticket"] == ticket
    assert _states(resumed)[-1] == "input-required"


async def test_rejecting_the_change_ends_the_task_without_deploying(
    client, remote_a2a_server, settings
):
    url = settings.deployment_agent_rpc_url
    frames = await _stream(
        client, url, _text_message("Please deploy billing-worker 3.1.0 to production.")
    )
    task_id, context_id = _task_ids(frames)
    pending = _long_running_calls(frames)[-1]
    ticket = _tool_responses(frames)["request_change_approval"]["ticket_id"]

    resumed = await _stream(
        client,
        url,
        _function_response_message(
            call_id=pending["id"],
            name=pending["name"],
            payload={"ticket_id": ticket, "approved": False, "note": "outside change window"},
            task_id=task_id,
            context_id=context_id,
        ),
    )
    assert _states(resumed)[-1] == "completed"
    assert not _long_running_calls(resumed), "a rejected change must not start a deployment"


async def test_tasks_get_reports_the_paused_state(client, remote_a2a_server, settings):
    url = settings.deployment_agent_rpc_url
    frames = await _stream(
        client, url, _text_message("Please deploy checkout-api 2.14.0 to production.")
    )
    task_id, _ = _task_ids(frames)

    # The 0.3 method keys the task by ``id`` and returns it flat in ``result``.
    response = await client.post(url, json=_rpc("tasks/get", {"id": task_id}))
    body = response.json()
    assert "error" not in body, body
    task = body["result"]
    assert task["id"] == task_id
    assert task["status"]["state"] == "input-required"
    assert task["history"], "the task should retain its message history"


async def test_a_paused_task_answered_with_text_completes_unanswered(
    client, remote_a2a_server, settings
):
    """Documents the trap: text does not resume a gate, it ends the task.

    ADK re-runs the agent with the text as ordinary input. No new long-running
    call is issued, so the task reaches a terminal state and the original gate
    can never be answered.
    """
    url = settings.deployment_agent_rpc_url
    frames = await _stream(
        client, url, _text_message("Please deploy checkout-api 2.14.0 to production.")
    )
    task_id, context_id = _task_ids(frames)
    pending = _long_running_calls(frames)[-1]

    after_text = await _stream(
        client, url, _text_message("yes, go ahead", task_id=task_id, context_id=context_id)
    )
    assert _states(after_text)[-1] == "completed"

    # And now the correct resume is refused, because the task is terminal.
    async with client.stream(
        "POST",
        url,
        json=_rpc(
            "message/stream",
            {
                "message": _function_response_message(
                    call_id=pending["id"],
                    name=pending["name"],
                    payload={"approved": True},
                    task_id=task_id,
                    context_id=context_id,
                )
            },
        ),
        headers={"Accept": "text/event-stream"},
    ) as response:
        body = (await response.aread()).decode()
    assert "already completed" in body
