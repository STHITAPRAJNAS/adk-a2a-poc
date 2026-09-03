#!/usr/bin/env python
"""Talks raw A2A JSON-RPC to **one** agent, with no ADK client in between.

Use this to understand a single agent's protocol behaviour. Use
``a2a_chain_probe.py`` to see two agents talking to each other.

What it exercises:

  * ``GET  /.well-known/agent-card.json``  discovery
  * ``POST message/stream``                streaming task execution
  * ``POST tasks/get``                     task state after a stream ends
  * ``POST tasks/cancel``                  cancellation

and the task state machine that carries HITL:

    submitted → working → input-required   (agent parked on a long-running call)
              → working → completed        (after a function response resumes it)

The pending call is not free text: it arrives as a DataPart whose metadata
carries ``adk_type: function_call`` and ``adk_is_long_running: true``. Resuming
means sending a message on the *same* ``taskId`` carrying a DataPart with
``adk_type: function_response`` and the same call id.

Replying with ordinary text instead does not error — and that is the trap worth
seeing. The agent is simply run again with the text as input, produces no new
long-running call, and the task therefore reaches ``completed``. The gate is now
unanswerable: a function response sent afterwards is refused with "Task ... is
already completed". ``wrong-resume`` demonstrates that, on its own task.

Usage:
    python scripts/a2a_probe.py card
    python scripts/a2a_probe.py run --prompt "deploy checkout-api 2.14.0 to production"
    python scripts/a2a_probe.py run --approve      # also resume the HITL gate
    python scripts/a2a_probe.py wrong-resume       # what a plain text reply does
    python scripts/a2a_probe.py card --agent ops_concierge   # the other agent
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
    ADK_LONG_RUNNING_KEY,
    ADK_TYPE_KEY,
    COMPLETED_STATES,
    FAILED_STATES,
    PAUSED_STATES,
    A2AWireClient,
    TurnResult,
    card_summary,
    function_response_message,
    text_message,
)
from common.config import get_settings  # noqa: E402

BOLD, DIM, CYAN, YELLOW, GREEN, RED, RESET = (
    "\033[1m", "\033[2m", "\033[36m", "\033[33m", "\033[32m", "\033[31m", "\033[0m"
)


def _c(colour: str, text: str) -> str:
    return f"{colour}{text}{RESET}"


def _endpoints(agent: str) -> tuple[str, str]:
    settings = get_settings()
    if agent == "ops_concierge":
        return settings.orchestrator_rpc_url, settings.orchestrator_card_url
    return settings.deployment_agent_rpc_url, settings.deployment_agent_card_url


def _describe_part(part: dict[str, Any]) -> str:
    metadata = part.get("metadata") or {}
    if text := part.get("text"):
        return f"text: {text.strip()[:200]}"
    if (data := part.get("data")) is not None:
        kind = metadata.get(ADK_TYPE_KEY, "data")
        flag = " [LONG-RUNNING]" if metadata.get(ADK_LONG_RUNNING_KEY) else ""
        return f"{kind}{flag}: {json.dumps(data, default=str)[:220]}"
    return f"part: {json.dumps(part, default=str)[:200]}"


def _render(turn: TurnResult) -> None:
    """Prints a turn frame by frame, as the wire delivered it."""
    if turn.error:
        print(_c(RED, f"  << JSON-RPC error {json.dumps(turn.error, default=str)[:400]}"))
        return
    last_state = None
    print(_c(CYAN, f"  << task {turn.task_id}") + _c(DIM, f"  context {turn.context_id}"))
    for result in turn.results:
        status = result.get("status") or {}
        state = status.get("state")
        if state and state != last_state:
            last_state = state
            colour = (
                YELLOW if state in PAUSED_STATES
                else GREEN if state in COMPLETED_STATES
                else RED if state in FAILED_STATES
                else CYAN
            )
            final = " (final)" if result.get("final") else ""
            kind = result.get("kind", "raw")
            print(f"  << {_c(colour, state)}{_c(DIM, final)}  {_c(DIM, f'[{kind}]')}")
        message = status.get("message") or (result if result.get("kind") == "message" else None)
        for part in (message or {}).get("parts") or []:
            print(f"       {_describe_part(part)}")
        for artifact in result.get("artifacts") or []:
            for part in artifact.get("parts") or []:
                print(f"       artifact {artifact.get('name', '')}: {_describe_part(part)}")


async def _stream(agent: A2AWireClient, message: dict[str, Any], label: str) -> TurnResult:
    print(_c(BOLD, f"\nPOST {agent.rpc_url}  method=message/stream  ({label})"))
    print(_c(DIM, f"  request: {json.dumps(message, default=str)[:300]}"))
    turn = await agent.stream(message)
    _render(turn)
    return turn


async def _show_task(agent: A2AWireClient, task_id: str) -> dict[str, Any]:
    print(_c(BOLD, f"\nPOST {agent.rpc_url}  method=tasks/get  id={task_id}"))
    task = await agent.get_task(task_id)
    print(f"  state    {_c(BOLD, str((task.get('status') or {}).get('state')))}")
    print(f"  history  {len(task.get('history') or [])} message(s)")
    return task


async def cmd_card(agent: A2AWireClient, _args: argparse.Namespace) -> int:
    print(_c(BOLD, f"GET {agent.card_url}"))
    summary = card_summary(await agent.fetch_card())
    print(f"  name        {summary['name']}")
    print(f"  version     {summary['version']}")
    print(f"  transports  {summary['transports']}")
    print(f"  rpc url     {summary['urls']}")
    print(f"  streaming   {summary['streaming']}")
    print("  skills")
    for skill_id, skill_name in summary["skills"]:
        print(f"    - {skill_id}: {skill_name}")
    return 0


async def cmd_run(agent: A2AWireClient, args: argparse.Namespace) -> int:
    await cmd_card(agent, args)
    turn = await _stream(agent, text_message(args.prompt), "new task")
    if turn.error or turn.task_id is None:
        return 1
    await _show_task(agent, turn.task_id)

    pending = turn.pending
    if pending is None:
        print(_c(GREEN, "\n✓ task finished without pausing for input"))
        return 0

    print(_c(YELLOW, f"\n── task paused on long-running call {pending.name} ({pending.call_id})"))
    print(_c(DIM, f"   args: {json.dumps(pending.args, default=str)[:300]}"))
    if not args.approve:
        print(_c(DIM, "   re-run with --approve to send the function response that resumes it"))
        return 0

    payload = {
        "ticket_id": turn.tool_responses.get(pending.name, {}).get("ticket_id", "unknown"),
        "approved": True,
        "decided_by": "a2a-probe",
        "note": "approved from the raw protocol probe",
    }
    resumed = await _stream(
        agent,
        function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload=payload,
            task_id=turn.task_id,
            context_id=turn.context_id,
        ),
        "resume with a function-response DataPart",
    )
    if resumed.error:
        return 1
    await _show_task(agent, turn.task_id)
    if resumed.pending is not None:
        print(
            _c(YELLOW, f"\n── task paused again on {resumed.pending.name}; ")
            + _c(YELLOW, "that is the long-running deployment job.")
        )
        print(_c(DIM, "   scripts/demo_client.py and scripts/a2a_chain_probe.py drive that one"))
        jobs_url = f"{get_settings().remote_agent_base_url}/ops/jobs"
        print(_c(DIM, f"   to completion by polling {jobs_url}"))
    return 0


async def cmd_wrong_resume(agent: A2AWireClient, args: argparse.Namespace) -> int:
    """Answers a paused task with text instead of a function response."""
    turn = await _stream(agent, text_message(args.prompt), "new task")
    if turn.pending is None or turn.task_id is None:
        print(_c(RED, "task never paused; nothing to demonstrate"))
        return 1
    pending = turn.pending
    print(_c(YELLOW, f"\n── paused on {pending.name} ({pending.call_id})"))

    after_text = await _stream(
        agent,
        text_message("yes, go ahead", task_id=turn.task_id, context_id=turn.context_id),
        "answering with plain text instead of a function response",
    )
    task = await _show_task(agent, turn.task_id)
    state = (task.get("status") or {}).get("state")
    print()
    if state in COMPLETED_STATES:
        print(_c(RED, "  The task completed without the gate ever being answered."))
        print(_c(DIM, "  The pending long-running call is now unanswerable. Proof:"))
        refused = await agent.stream(
            function_response_message(
                call_id=pending.call_id,
                name=pending.name,
                payload={"approved": True},
                task_id=turn.task_id,
                context_id=turn.context_id,
            )
        )
        print(_c(DIM, f"    {json.dumps(refused.error, default=str)[:200]}"))
        print(_c(DIM, "  Resume a paused task with a function-response DataPart, never text."))
    else:
        print(_c(DIM, f"  task state after the text reply: {state} (states: {after_text.states})"))
    return 0


async def cmd_cancel(agent: A2AWireClient, args: argparse.Namespace) -> int:
    print(_c(BOLD, f"POST {agent.rpc_url}  method=tasks/cancel  id={args.task_id}"))
    print(json.dumps(await agent.cancel_task(args.task_id), indent=2)[:1200])
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--agent",
        choices=("deployment_agent", "ops_concierge"),
        default="deployment_agent",
        help="which agent to probe (both are A2A servers)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("card", help="fetch and summarise the Agent Card")

    run = sub.add_parser("run", help="stream a task and show the state machine")
    run.add_argument("--prompt", default="Please deploy checkout-api 2.14.0 to production.")
    run.add_argument("--approve", action="store_true", help="resume the HITL gate")

    wrong = sub.add_parser(
        "wrong-resume",
        help="show what happens when a paused task is answered with plain text",
    )
    wrong.add_argument("--prompt", default="Please deploy checkout-api 2.14.0 to production.")

    cancel = sub.add_parser("cancel", help="cancel a task by id")
    cancel.add_argument("task_id")

    return parser.parse_args()


async def amain() -> int:
    args = parse_args()
    handlers = {
        "card": cmd_card,
        "run": cmd_run,
        "wrong-resume": cmd_wrong_resume,
        "cancel": cmd_cancel,
    }
    rpc_url, card_url = _endpoints(args.agent)
    timeout = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as http:
        agent = A2AWireClient(http, rpc_url, card_url=card_url)
        try:
            return await handlers[args.command](agent, args)
        except httpx.ConnectError as exc:
            print(_c(RED, f"cannot reach {args.agent}: {exc}"))
            print(_c(DIM, "  start both with: ./scripts/run_all.sh"))
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
