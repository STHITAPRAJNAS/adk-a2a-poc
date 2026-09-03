"""Two remote agents talking to each other over A2A.

This is the topology a real deployment has, and the one the rest of the suite
does not cover: the caller speaks A2A to ``ops_concierge`` and nothing else,
while every decision is actually made by ``deployment_agent``, one more A2A hop
in. Both agents are independently deployed A2A servers; the concierge is also an
A2A client of the specialist.

    pytest ──A2A──► ops_concierge ──A2A──► deployment_agent
                    (server+client)        (server)

The properties worth pinning:

  * each hop owns a **separate** task with its own id — nothing in A2A shares a
    task across a hop;
  * a downstream pause **mirrors** outward: the caller's task parks in
    ``input-required`` carrying the same pending function call;
  * a function response sent to hop 1 is **forwarded** onto hop 2's task, and
    both tasks resume;
  * the caller can finish the whole flow without ever addressing hop 2 — the
    job handle it needs travels outward in the tool result.
"""

from __future__ import annotations

import asyncio

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
async def http():
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        yield client


@pytest.fixture
async def concierge(orchestrator_server, settings, http):
    """The front door, addressed over A2A exactly as another agent would."""
    return A2AWireClient(
        http, settings.orchestrator_rpc_url, card_url=settings.orchestrator_card_url
    )


@pytest.fixture
async def specialist(remote_a2a_server, settings, http):
    return A2AWireClient(
        http, settings.deployment_agent_rpc_url, card_url=settings.deployment_agent_card_url
    )


async def test_both_agents_publish_their_own_agent_card(concierge, specialist, settings):
    """A network of agents means every agent is independently discoverable."""
    front = await concierge.fetch_card()
    back = await specialist.fetch_card()

    assert front["name"] == "ops_concierge"
    assert back["name"] == "deployment_agent"
    assert front["supportedInterfaces"][0]["url"] == settings.orchestrator_rpc_url
    assert back["supportedInterfaces"][0]["url"] == settings.deployment_agent_rpc_url
    # Different origins: these are two independently deployed services.
    assert settings.orchestrator_base_url != settings.remote_agent_base_url


async def test_downstream_pause_mirrors_onto_the_callers_task(concierge):
    turn = await concierge.stream(text_message(PROD_RELEASE))

    assert turn.error is None, turn.error
    assert turn.final_state in PAUSED_STATES, (
        "the front door's own task must park while its downstream task is parked"
    )
    assert turn.pending is not None
    assert turn.pending.name == "request_change_approval", (
        "the specialist's pending call should reach the caller unchanged"
    )
    # The caller never addressed the specialist, but it can see that a second
    # task exists, because RemoteA2aAgent stamps the downstream ids on the
    # events the concierge emits.
    assert turn.downstream_task_ids, "no downstream task id surfaced to the caller"
    assert turn.task_id not in turn.downstream_task_ids, (
        "each hop must own a distinct task; ids must not be reused across the hop"
    )


async def test_approval_sent_to_hop_one_is_forwarded_to_hop_two(concierge):
    first = await concierge.stream(text_message(PROD_RELEASE))
    pending = first.pending
    ticket = first.tool_responses["request_change_approval"]["ticket_id"]
    downstream = set(first.downstream_task_ids)

    second = await concierge.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"ticket_id": ticket, "approved": True, "decided_by": "pytest"},
            task_id=first.task_id,
            context_id=first.context_id,
        )
    )

    assert second.error is None, second.error
    assert second.task_id == first.task_id, "hop 1 must reuse its task"
    assert second.downstream_task_ids == downstream, "hop 2 must reuse its task too"
    # The forwarded approval reached the specialist: it moved past the gate.
    assert second.pending is not None
    assert second.pending.name == "start_deployment"
    assert second.pending.args["approval_ticket"] == ticket


async def test_caller_completes_the_whole_chain_without_addressing_hop_two(
    concierge, settings, http
):
    """End to end across two hops, from a caller that only knows the front door."""
    first = await concierge.stream(text_message(PROD_RELEASE))
    hop1_task = first.task_id
    hop2_tasks = set(first.downstream_task_ids)

    # 1. answer the human gate at hop 1
    pending = first.pending
    ticket = first.tool_responses["request_change_approval"]["ticket_id"]
    second = await concierge.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"ticket_id": ticket, "approved": True},
            task_id=hop1_task,
            context_id=first.context_id,
        )
    )

    # 2. the job handle minted two hops in travelled out to the caller, poll URL
    #    and all, so the caller can wait on work it never started.
    started = second.tool_responses["start_deployment"]
    assert started["poll_url"].startswith(settings.remote_agent_base_url)
    for _ in range(settings.deployment_job_seconds * 4 + 60):
        job = (await http.get(started["poll_url"])).json()
        if job["state"] in ("succeeded", "failed"):
            break
        await asyncio.sleep(1)
    assert job["state"] == "succeeded", f"deployment job did not finish: {job}"

    # 3. deliver the terminal result back through hop 1
    pending = second.pending
    third = await concierge.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload=job["result"],
            task_id=hop1_task,
            context_id=second.context_id,
        )
    )

    assert third.final_state in COMPLETED_STATES
    assert not third.pending_calls
    assert third.task_id == hop1_task
    assert third.downstream_task_ids == hop2_tasks, "one task per hop for the whole conversation"

    final = " ".join(third.texts)
    assert "succeeded" in final
    assert ticket in final

    # Both tasks ended, each on its own server.
    hop1 = await concierge.get_task(hop1_task)
    assert hop1["status"]["state"] in COMPLETED_STATES


async def test_rejection_at_hop_one_stops_the_release_at_hop_two(concierge):
    billing = "Please deploy billing-worker 3.1.0 to production."
    first = await concierge.stream(text_message(billing))
    pending = first.pending
    ticket = first.tool_responses["request_change_approval"]["ticket_id"]

    second = await concierge.stream(
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload={"ticket_id": ticket, "approved": False, "note": "outside change window"},
            task_id=first.task_id,
            context_id=first.context_id,
        )
    )

    assert second.final_state in COMPLETED_STATES
    assert not second.pending_calls, "a rejected change must not start a deployment"
    assert "rejected" in " ".join(second.texts).lower()


async def test_the_same_flow_costs_the_caller_the_same_turns_either_way(concierge, specialist):
    """Adding a hop must not change the caller's contract.

    Entering at the front door and entering at the specialist take the caller
    through the same number of pauses with the same pending call names. That
    equivalence is what makes an A2A hop transparent to whoever is driving.
    """

    async def gate_names(agent: A2AWireClient) -> list[str]:
        names: list[str] = []
        turn = await agent.stream(text_message(PROD_RELEASE))
        while turn.pending is not None and len(names) < 4:
            pending = turn.pending
            names.append(pending.name)
            payload = (
                {"approved": True, "ticket_id": turn.tool_responses.get(pending.name, {}).get(
                    "ticket_id", "unknown"
                )}
                if pending.name == "request_change_approval"
                else {"status": "succeeded", "job_id": "job-stub"}
            )
            turn = await agent.stream(
                function_response_message(
                    call_id=pending.call_id,
                    name=pending.name,
                    payload=payload,
                    task_id=turn.task_id,
                    context_id=turn.context_id,
                )
            )
        assert turn.final_state in COMPLETED_STATES
        return names

    assert await gate_names(concierge) == await gate_names(specialist)
