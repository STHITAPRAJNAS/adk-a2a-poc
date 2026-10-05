#!/usr/bin/env python
"""Drives the production-hardening exercises: durability, cancel, identity.

``a2a_chain_probe.py`` runs a release start to finish in one go. The exercises
in ``k8s-lab/labs/8x-*`` need to *stop in the middle* — park a task at the human
approval gate, do something nasty to the cluster, then come back. So this probe
splits the conversation into steps and keeps what it learned in a small state
file between them:

    pause    send the release request, stop at the approval gate, save the ids
    resume   answer the gate on the saved task (approve or --reject)
    cancel   CancelTask the saved front-door task, then ask the specialist what
             became of the downstream task it had opened
    task     GetTask on any agent, by id
    tickets  list the specialist's approval tickets (its /ops surface, not A2A)
    login    get a user token from the lab token service (identity exercise)

Usage (local stack from ``./scripts/run_all.sh``):

    python scripts/a2a_prod_probe.py pause
    python scripts/a2a_prod_probe.py resume
    python scripts/a2a_prod_probe.py cancel

In the cluster it runs inside the ``a2a-probe`` pod (see
``k8s-lab/labs/80-durable-tasks/probe.yaml``), which survives the pod deletions
the exercises are about.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import httpx  # noqa: E402

from common.a2a_wire import (  # noqa: E402
    CANCELED_STATES,
    COMPLETED_STATES,
    PAUSED_STATES,
    TERMINAL_STATES,
    A2AWireClient,
    TurnResult,
    function_response_message,
    text_message,
)
from common.config import get_settings  # noqa: E402

HITL_TOOL = "request_change_approval"
JOB_TOOL = "start_deployment"

BOLD, DIM, CYAN, YELLOW, GREEN, RED, RESET = (
    "\033[1m",
    "\033[2m",
    "\033[36m",
    "\033[33m",
    "\033[32m",
    "\033[31m",
    "\033[0m",
)
if os.environ.get("NO_COLOR"):
    BOLD = DIM = CYAN = YELLOW = GREEN = RED = RESET = ""


def _c(colour: str, text: str) -> str:
    return f"{colour}{text}{RESET}"


def _default_state_file() -> str:
    return os.environ.get("A2A_PROBE_STATE", "/tmp/a2a-probe-state.json")


def _load_state(path: str) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        print(_c(RED, f"no saved state at {path} — run `pause` first"))
        raise SystemExit(2) from None


def _save_state(path: str, state: dict[str, Any]) -> None:
    Path(path).write_text(json.dumps(state, indent=2))


def _print_turn(turn: TurnResult, label: str) -> None:
    print(_c(BOLD, f"\n── {label}"))
    if turn.error:
        print(_c(RED, f"   error            {json.dumps(turn.error, default=str)[:400]}"))
        return
    print(f"   states           {' → '.join(turn.states) or '(none)'}")
    print(f"   front-door task  {turn.task_id}")
    if turn.downstream_task_ids:
        print(_c(CYAN, f"   downstream task  {', '.join(sorted(turn.downstream_task_ids))}"))
    for name, payload in turn.tool_responses.items():
        print(_c(DIM, f"   tool result      {name}: {json.dumps(payload, default=str)[:140]}"))
    requested_by = turn.tool_responses.get(HITL_TOOL, {}).get("requested_by")
    if requested_by:
        print(
            _c(CYAN, f"   requested by     {requested_by}")
            + _c(DIM, "   ← from the verified token")
        )
    for text in turn.texts:
        print(f"   agent says       {text[:200]}")
    for call in turn.pending_calls:
        print(_c(YELLOW, f"   ⏸ pending call   {call.name} ({call.call_id})"))


def _auth_headers(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


async def _login(sts_url: str, user: str) -> str:
    async with httpx.AsyncClient(timeout=10.0) as http:
        resp = await http.post(f"{sts_url.rstrip('/')}/dev/login", json={"user": user})
        if resp.status_code != 200:
            print(_c(RED, f"login failed: HTTP {resp.status_code} {resp.text[:200]}"))
            raise SystemExit(1)
        return resp.json()["access_token"]


async def _token_from_args(
    args: argparse.Namespace, state: dict[str, Any] | None = None
) -> str | None:
    if args.token:
        return args.token
    if args.user:
        return await _login(args.sts, args.user)
    if state and state.get("token"):
        return state["token"]
    return None


def _client(token: str | None) -> httpx.AsyncClient:
    timeout = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
    return httpx.AsyncClient(timeout=timeout, headers=_auth_headers(token))


# --------------------------------------------------------------------------- pause


async def cmd_pause(args: argparse.Namespace) -> int:
    token = await _token_from_args(args)
    async with _client(token) as http:
        agent = A2AWireClient(http, args.entry)
        print(_c(DIM, f"entry {args.entry}" + ("   (with a bearer token)" if token else "")))
        turn = await agent.stream(text_message(args.prompt))
    _print_turn(turn, "release request")
    if turn.error:
        return 1
    for name, payload in turn.tool_responses.items():
        if payload.get("error") == "denied_by_policy":
            print(_c(RED, f"\n✗ DENIED at {name}: {payload.get('message')}"))
            if turn.is_paused:
                # A long-running call is marked pending before callbacks run, so
                # ADK parks the task on the call the guard just refused.
                print(
                    _c(
                        DIM,
                        "  The task still parks on the refused call (ADK marks long-running calls",
                    )
                )
                print(
                    _c(
                        DIM,
                        "  pending before callbacks run). Cancel it rather than leave it waiting.",
                    )
                )
            return 4
    pending = turn.pending
    if not turn.is_paused or pending is None:
        print(
            _c(RED, f"\n✗ expected the task to park at the approval gate, got {turn.final_state}")
        )
        if turn.final_state in COMPLETED_STATES and not turn.texts:
            print(
                _c(DIM, "  Completed with no answer: a downstream hop probably refused or failed.")
            )
            print(_c(DIM, "  The front door's log says why ('A2A request failed: …')."))
        return 1
    ticket = turn.tool_responses.get(HITL_TOOL, {}).get("ticket_id")
    state = {
        "entry": args.entry,
        "task_id": turn.task_id,
        "context_id": turn.context_id,
        "downstream_task_ids": sorted(turn.downstream_task_ids),
        "pending": {"call_id": pending.call_id, "name": pending.name, "args": pending.args},
        "ticket_id": ticket,
        "token": token,
    }
    _save_state(args.state, state)
    print(_c(GREEN, f"\n✓ parked at {pending.name}"))
    print(_c(DIM, f"  state saved to {args.state}"))
    return 0


# -------------------------------------------------------------------------- resume


async def cmd_resume(args: argparse.Namespace) -> int:
    state = _load_state(args.state)
    token = await _token_from_args(args, state)
    pending = state["pending"]
    payload = {
        "ticket_id": state.get("ticket_id") or "unknown",
        "approved": not args.reject,
        "decided_by": args.decided_by,
        "note": "rejected by the production probe"
        if args.reject
        else "approved by the production probe",
    }
    async with _client(token) as http:
        agent = A2AWireClient(http, state.get("entry") or args.entry)
        turn = await agent.stream(
            function_response_message(
                call_id=pending["call_id"],
                name=pending["name"],
                payload=payload,
                task_id=state["task_id"],
                context_id=state.get("context_id"),
            )
        )
    _print_turn(turn, f"resume — answer {pending['name']} on task {state['task_id']}")
    if turn.error:
        print(_c(RED, "\n✗ the resume was refused"))
        return 1

    final = turn.final_state
    nxt = turn.pending
    refused = turn.tool_responses.get(JOB_TOOL, {})
    if refused.get("error") == "denied_by_policy":
        # Lab 55's tools policy (if still on) forbids production deploys. The
        # resume itself landed: the agent got past the gate to the next step.
        print(
            _c(GREEN, "\n✓ the gate was answered and the release moved on — to start_deployment,")
        )
        print(_c(DIM, f"  which policy then refused: {refused.get('message')}"))
        return 0
    if nxt is not None and nxt.name == JOB_TOOL:
        job = turn.tool_responses.get(JOB_TOOL, {}).get("job_id")
        print(
            _c(
                GREEN,
                f"\n✓ the gate was answered and the release moved on: job {job} is running",
            )
        )
        state["pending"] = {"call_id": nxt.call_id, "name": nxt.name, "args": nxt.args}
        state["job_id"] = job
        _save_state(args.state, state)
        return 0
    if final in COMPLETED_STATES:
        said = " ".join(turn.texts)
        if "Function call not found" in said:
            # The nastiest outcome: protocol state survived, agent state did not.
            # The task is "completed" and its answer is an error message.
            print(_c(RED, "\n✗ COMPLETED, BUT WRONG: the A2A task survived the restart, the ADK"))
            print(
                _c(RED, "  session holding the paused call did not. The approval answered nothing.")
            )
            print(_c(DIM, "  Make the session store durable too (SESSION_SERVICE_URI)."))
            return 1
        if args.reject or JOB_TOOL in turn.tool_responses:
            print(_c(GREEN, "\n✓ the task resumed and completed"))
            return 0
        print(_c(YELLOW, "\n? completed without starting a deployment — read what the agent said"))
        return 1
    if final in PAUSED_STATES and nxt is not None and nxt.call_id == pending["call_id"]:
        print(_c(RED, "\n✗ the task is still parked on the same gate — the answer did not land"))
        return 1
    if final in PAUSED_STATES or final in TERMINAL_STATES:
        print(_c(YELLOW, f"\n? the task ended in {final}"))
        return 0
    # The stream closed on a non-terminal, non-paused state. Ask the front door
    # directly: if it still says "working", nothing is ever going to finish it.
    async with _client(token) as http:
        got = await A2AWireClient(http, state.get("entry") or args.entry).get_task(state["task_id"])
    now = (got.get("status") or {}).get("state")
    print(_c(RED, f"\n✗ the resume did not land: the stream closed and the task still says {now}"))
    print(_c(DIM, "  The downstream hop failed. Its logs will say why — on a restart, look for"))
    print(_c(DIM, "  'Task … not found' (-32001): the task lived only in that pod's memory."))
    return 1


# -------------------------------------------------------------------------- cancel


async def cmd_cancel(args: argparse.Namespace) -> int:
    state = _load_state(args.state)
    token = await _token_from_args(args, state)
    task_id = state["task_id"]
    async with _client(token) as http:
        front = A2AWireClient(http, state.get("entry") or args.entry)
        print(_c(BOLD, f"\n── CancelTask {task_id} on the front door"))
        body = await front.cancel_task(task_id)
        if "error" in body:
            print(_c(RED, f"   error  {json.dumps(body['error'])[:300]}"))
            return 1
        result = body.get("result") or {}
        front_state = (result.get("status") or {}).get("state")
        print(f"   front-door task is now {front_state}")

    downstream = state.get("downstream_task_ids") or []
    if not downstream:
        print(_c(YELLOW, "   no downstream task was recorded at pause time; nothing to compare"))
        return 0

    # Give a propagating cancel a moment to land downstream.
    await asyncio.sleep(args.settle)

    print(_c(BOLD, "\n── what the specialist says about its own task"))
    print(_c(DIM, f"   GetTask on {args.specialist}"))
    orphaned = False
    async with _client(None) as http:
        specialist = A2AWireClient(http, args.specialist)
        for task in downstream:
            try:
                got = await specialist.get_task(task)
            except httpx.HTTPError as exc:
                print(_c(RED, f"   cannot reach the specialist: {exc}"))
                return 1
            st = (got.get("status") or {}).get("state")
            print(f"   downstream {task}  {st}")
            if st not in CANCELED_STATES:
                orphaned = True

    if orphaned:
        print(
            _c(
                YELLOW,
                "\n⚠ ORPHANED: the front door says canceled, the specialist is still waiting.",
            )
        )
        print(
            _c(
                DIM,
                "  Nobody will answer that gate. Its approval ticket is still open for a human.",
            )
        )
        return 3
    print(_c(GREEN, "\n✓ PROPAGATED: the downstream task was canceled too"))
    return 0


# ---------------------------------------------------------------------------- task


async def cmd_task(args: argparse.Namespace) -> int:
    url = args.specialist if args.on == "specialist" else args.entry
    token = await _token_from_args(args)
    async with _client(token) as http:
        got = await A2AWireClient(http, url).get_task(args.task_id)
    print(json.dumps(got, indent=2)[:4000])
    return 0


# ------------------------------------------------------------------------- tickets


async def cmd_tickets(args: argparse.Namespace) -> int:
    """Lists approval tickets from the specialist's /ops surface (not A2A)."""
    base = args.specialist.split("/a2a/", 1)[0]
    async with httpx.AsyncClient(timeout=10.0) as http:
        resp = await http.get(f"{base}/ops/approvals")
    if resp.status_code != 200:
        print(_c(RED, f"GET {base}/ops/approvals → HTTP {resp.status_code}"))
        return 1
    tickets = resp.json().get("tickets", [])
    if not tickets:
        print(_c(DIM, "no tickets (this registry is in memory: a restart empties it)"))
    for t in tickets:
        colour = {"pending": YELLOW, "voided": DIM, "approved": GREEN, "rejected": RED}.get(
            t["state"], ""
        )
        who = f"  requested by {t['requested_by']}" if t.get("requested_by") else ""
        print(_c(colour, f"{t['id']}  {t['state']:<8}") + f"  {t['service']} {t['version']}{who}")
    return 0


# --------------------------------------------------------------------------- login


async def cmd_login(args: argparse.Namespace) -> int:
    token = await _login(args.sts, args.user or "alice")
    if args.print:
        print(token)
        return 0
    import base64

    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    print(json.dumps(claims, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    settings = get_settings()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--entry", default=os.environ.get("A2A_ENTRY_URL", settings.orchestrator_rpc_url)
    )
    parser.add_argument(
        "--specialist",
        default=os.environ.get("A2A_SPECIALIST_URL", settings.deployment_agent_rpc_url),
    )
    parser.add_argument("--state", default=_default_state_file())
    parser.add_argument("--sts", default=os.environ.get("STS_URL", settings.sts_url))
    parser.add_argument("--user", help="log in as this user at the lab token service first")
    parser.add_argument("--token", help="send this bearer token")
    sub = parser.add_subparsers(dest="command", required=True)

    pause = sub.add_parser("pause", help="run to the approval gate and save the ids")
    pause.add_argument("--prompt", default="Please deploy checkout-api 2.14.0 to production.")

    resume = sub.add_parser("resume", help="answer the saved gate")
    resume.add_argument("--reject", action="store_true")
    resume.add_argument("--decided-by", default="prod-probe")

    cancel = sub.add_parser("cancel", help="cancel the saved task and check downstream")
    cancel.add_argument("--settle", type=float, default=1.5)

    task = sub.add_parser("task", help="GetTask by id")
    task.add_argument("task_id")
    task.add_argument("--on", choices=["entry", "specialist"], default="entry")

    sub.add_parser("tickets", help="list approval tickets on the specialist")

    login = sub.add_parser("login", help="get a user token from the lab token service")
    login.add_argument("--print", action="store_true", help="print the raw token")
    return parser.parse_args()


async def amain() -> int:
    args = parse_args()
    handlers = {
        "pause": cmd_pause,
        "resume": cmd_resume,
        "cancel": cmd_cancel,
        "task": cmd_task,
        "tickets": cmd_tickets,
        "login": cmd_login,
    }
    try:
        return await handlers[args.command](args)
    except httpx.ConnectError as exc:
        print(_c(RED, f"cannot reach an agent: {exc}"))
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
