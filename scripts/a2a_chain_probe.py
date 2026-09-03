#!/usr/bin/env python
"""Drives the **whole agent network** from outside, over raw A2A.

``a2a_probe.py`` talks to one agent. This talks to the network as a caller who
knows nothing about ADK: it discovers ``ops_concierge`` from its Agent Card,
sends it a release request, and answers whatever that agent asks for — without
ever addressing ``deployment_agent`` directly, even though every decision is
actually made there.

That is the shape a real multi-agent A2A deployment has, and the property being
demonstrated is **chaining**:

    caller ──A2A──► ops_concierge ──A2A──► deployment_agent
                    (server + client)      (server)

    task A                                 task B
    input-required  ◄── mirrors ───────    input-required
    function response ─── forwards ──►     function response
    completed       ◄── mirrors ───────    completed

Each hop owns a *separate* task with its own id and its own lifecycle. Nothing
in A2A shares a task across a hop. What propagates is the pending long-running
call: the concierge's own task cannot finish while its downstream task is
parked, so it parks too, carrying the same pending function call outward. A
function response sent to the concierge is routed by ADK to its
``RemoteA2aAgent``, which forwards it onto the downstream task.

The downstream task id is visible from out here, in each event's
``metadata.adk_custom_metadata``, which is how this script prints both.

Usage:
    python scripts/a2a_chain_probe.py cards          # discover both agents
    python scripts/a2a_chain_probe.py run            # full chain, auto-approve
    python scripts/a2a_chain_probe.py run --reject    # rejection branch
    python scripts/a2a_chain_probe.py run --direct    # same flow, skipping hop 1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import httpx  # noqa: E402

from common.a2a_wire import (  # noqa: E402
    COMPLETED_STATES,
    A2AWireClient,
    PendingCall,
    TurnResult,
    card_summary,
    function_response_message,
    text_message,
)
from common.config import get_settings  # noqa: E402

HITL_TOOL = "request_change_approval"
JOB_TOOL = "start_deployment"

BOLD, DIM, CYAN, YELLOW, GREEN, RED, RESET = (
    "\033[1m", "\033[2m", "\033[36m", "\033[33m", "\033[32m", "\033[31m", "\033[0m"
)


def _c(colour: str, text: str) -> str:
    return f"{colour}{text}{RESET}"


def _print_card(card: dict[str, Any]) -> None:
    summary = card_summary(card)
    print(_c(BOLD, f"  {summary['name']}  v{summary['version']}"))
    print(_c(DIM, f"    {summary['description'][:150]}"))
    print(f"    endpoint   {summary['urls']}")
    print(f"    transports {summary['transports']}   streaming {summary['streaming']}")
    for skill_id, skill_name in summary["skills"]:
        print(_c(DIM, f"    skill      {skill_id}  ({skill_name})"))


def _print_turn(turn: TurnResult, label: str) -> None:
    print(_c(BOLD, f"\n── {label}"))
    if turn.error:
        print(_c(RED, f"   JSON-RPC error: {json.dumps(turn.error, default=str)[:300]}"))
        return
    print(f"   states           {' → '.join(turn.states)}")
    print(f"   this hop's task  {turn.task_id}")
    if turn.downstream_task_ids:
        print(
            _c(CYAN, "   downstream task  ")
            + ", ".join(sorted(turn.downstream_task_ids))
            + _c(DIM, "   ← a second, separate A2A task one hop further in")
        )
    for name, payload in turn.tool_responses.items():
        print(_c(DIM, f"   tool result      {name}: {json.dumps(payload, default=str)[:110]}"))
    for text in turn.texts:
        print(f"   agent says       {text[:160]}")
    for call in turn.pending_calls:
        print(_c(YELLOW, f"   ⏸ pending call   {call.name} ({call.call_id})"))


async def _poll_job(client: httpx.AsyncClient, base_url: str, job_id: str) -> dict[str, Any]:
    """Waits for a background job the *downstream* agent started.

    The caller never spoke to that agent, but the job handle it minted travelled
    outward in the pending call's tool result, poll URL and all. That is the
    long-running contract working across a hop: the handle is portable, so
    whoever ends up owning the wait can find the work.
    """
    settings = get_settings()
    url = f"{base_url}/ops/jobs/{job_id}"
    print(_c(DIM, f"   polling {url}"))
    last_stage = None
    for _ in range(settings.deployment_job_seconds * 4 + 60):
        job = (await client.get(url)).json()
        if job["stage"] != last_stage:
            last_stage = job["stage"]
            print(f"     {job['progress']:3d}%  {last_stage}")
        if job["state"] in ("succeeded", "failed"):
            return job["result"] or {"status": job["state"], "job_id": job_id}
        await asyncio.sleep(1)
    return {"status": "failed", "job_id": job_id, "error": "timed out"}


async def _resolve(
    pending: PendingCall,
    turn: TurnResult,
    http: httpx.AsyncClient,
    *,
    approve: bool,
) -> dict[str, Any]:
    settings = get_settings()
    if pending.name == HITL_TOOL:
        ticket = turn.tool_responses.get(HITL_TOOL, {}).get("ticket_id", "unknown")
        print(_c(YELLOW, "   human gate: ") + f"{pending.args.get('service')} "
              f"{pending.args.get('version')} → {pending.args.get('environment')}"
              f"  risk={pending.args.get('risk')}  ticket={ticket}")
        return {
            "ticket_id": ticket,
            "approved": approve,
            "decided_by": "chain-probe",
            "note": "approved by the chain probe" if approve else "rejected by the chain probe",
        }
    if pending.name == JOB_TOOL:
        started = turn.tool_responses.get(JOB_TOOL, {})
        job_id = started.get("job_id")
        if not job_id:
            return {"status": "failed", "error": "no job id came back"}
        return await _poll_job(http, settings.remote_agent_base_url, job_id)
    raise RuntimeError(f"no resolver for pending call {pending.name}")


async def cmd_cards(http: httpx.AsyncClient, _args: argparse.Namespace) -> int:
    settings = get_settings()
    print(_c(BOLD, "Agent network, discovered purely from Agent Cards\n"))
    for label, card_url, rpc_url in (
        ("front door", settings.orchestrator_card_url, settings.orchestrator_rpc_url),
        ("specialist", settings.deployment_agent_card_url, settings.deployment_agent_rpc_url),
    ):
        print(_c(CYAN, f"[{label}]  {card_url}"))
        _print_card(await A2AWireClient(http, rpc_url, card_url=card_url).fetch_card())
        print()
    print(_c(DIM, "Both agents are A2A servers. The front door is also an A2A client of the"))
    print(_c(DIM, "specialist, which is what makes this a network rather than a pair."))
    return 0


async def cmd_run(http: httpx.AsyncClient, args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.direct:
        entry, name = settings.deployment_agent_rpc_url, "deployment_agent"
        card_url = settings.deployment_agent_card_url
    else:
        entry, name = settings.orchestrator_rpc_url, "ops_concierge"
        card_url = settings.orchestrator_card_url

    agent = A2AWireClient(http, entry, card_url=card_url)
    card = await agent.fetch_card()
    print(_c(BOLD, f"entry point: {name}"))
    _print_card(card)

    turn = await agent.stream(text_message(args.prompt))
    _print_turn(turn, f"turn 1 — release request → {name}")
    if turn.error:
        return 1

    hop_task = turn.task_id
    downstream_seen: set[str] = set(turn.downstream_task_ids)

    caller_turns = 1
    for index in range(2, 2 + args.max_turns):
        pending = turn.pending
        if pending is None:
            break
        payload = await _resolve(pending, turn, http, approve=not args.reject)
        assert hop_task is not None
        turn = await agent.stream(
            function_response_message(
                call_id=pending.call_id,
                name=pending.name,
                payload=payload,
                task_id=hop_task,
                context_id=turn.context_id,
            )
        )
        caller_turns = index
        _print_turn(turn, f"turn {index} — function response for {pending.name}")
        if turn.error:
            return 1
        downstream_seen |= turn.downstream_task_ids
        if turn.task_id != hop_task:
            print(_c(RED, "   !! the resume opened a NEW task; it should have reused the old one"))
            return 1

    task = await agent.get_task(hop_task) if hop_task else {}
    final_state = (task.get("status") or {}).get("state")

    print(_c(BOLD, "\n── summary"))
    print(f"   entry agent            {name}")
    print(f"   hop-1 task             {hop_task}  ({final_state})")
    if downstream_seen:
        print(_c(CYAN, f"   hop-2 task(s)          {', '.join(sorted(downstream_seen))}"))
        print(_c(DIM, "   Two task ids for one conversation: each A2A hop owns its own task."))
        print(_c(DIM, "   The caller only ever addressed hop 1."))
    else:
        print(_c(DIM, "   no downstream hop (this agent did the work itself)"))
    print(f"   turns from the caller  {caller_turns}")
    if turn.pending is not None:
        print(_c(RED, f"   still pending: {turn.pending.name} (gave up after {args.max_turns})"))

    if final_state in COMPLETED_STATES:
        print(_c(GREEN, "\n✓ chain completed"))
        return 0
    print(_c(RED, f"\n✗ chain ended in {final_state}"))
    return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("cards", help="discover every agent in the network")

    run = sub.add_parser("run", help="drive the whole chain from outside")
    run.add_argument("--prompt", default="Please deploy checkout-api 2.14.0 to production.")
    run.add_argument("--reject", action="store_true", help="reject at the human gate")
    run.add_argument(
        "--direct",
        action="store_true",
        help="enter at the specialist instead, to compare one hop against two",
    )
    run.add_argument("--max-turns", type=int, default=6)
    return parser.parse_args()


async def amain() -> int:
    args = parse_args()
    handlers = {"cards": cmd_cards, "run": cmd_run}
    timeout = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as http:
        try:
            return await handlers[args.command](http, args)
        except httpx.ConnectError as exc:
            print(_c(RED, f"cannot reach an agent: {exc}"))
            print(_c(DIM, "  start both with: ./scripts/run_all.sh"))
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
