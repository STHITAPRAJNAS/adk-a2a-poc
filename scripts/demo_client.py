#!/usr/bin/env python
"""Drives the orchestrator end to end and narrates the protocol as it goes.

This is the scripted counterpart to clicking through the Dev UI. It exists
because the interesting parts of the flow are the pauses, and a script can prove
they resume correctly:

  1. POST a release request to the orchestrator's ``/run_sse``.
  2. Watch the stream. Every event carries ``a2a:task_id`` / ``a2a:context_id``
     once the remote agent takes over, which is the A2A task this conversation
     is bound to.
  3. When the stream ends on a pending long-running function call:
       * ``request_change_approval`` -> ask the operator here, in the terminal,
         and post the decision back as a function response;
       * ``start_deployment``       -> poll the remote server's ``/ops/jobs``
         endpoint until the background job reaches a terminal state, then post
         the result back as a function response.
  4. Repeat until the stream ends with no pending call.

Steps 3 and 4 are the whole point: a function response posted to ``/run_sse``
is routed by ADK back through ``RemoteA2aAgent`` onto the *same* A2A task, which
moves from INPUT_REQUIRED back to WORKING and on to COMPLETED.

Usage:
    python scripts/demo_client.py
    python scripts/demo_client.py --prompt "deploy billing-worker 3.1.0 to production"
    python scripts/demo_client.py --auto-approve      # no prompting, always approve
    python scripts/demo_client.py --auto-reject       # exercise the rejection path
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import httpx  # noqa: E402

from common.config import ORCHESTRATOR_APP_NAME, get_settings  # noqa: E402

HITL_TOOL = "request_change_approval"
JOB_TOOL = "start_deployment"

DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"


def _c(colour: str, text: str) -> str:
    return f"{colour}{text}{RESET}"


class PendingCall:
    """A long-running function call the agent is parked on."""

    def __init__(self, call_id: str, name: str, args: dict[str, Any]) -> None:
        self.call_id = call_id
        self.name = name
        self.args = args


class DemoClient:
    def __init__(self, client: httpx.AsyncClient, *, user_id: str, session_id: str) -> None:
        self._client = client
        self._settings = get_settings()
        self._user_id = user_id
        self._session_id = session_id
        self._task_id: str | None = None
        self._context_id: str | None = None
        #: newest response payload seen per tool name
        self._responses: dict[str, dict[str, Any]] = {}
        #: event ids already rendered, plus the last line printed. ADK re-emits a
        #: remote agent's terminal event a second time when it promotes the
        #: branch output, and printing it twice makes the trace look like the
        #: agent repeated itself.
        self._seen_events: set[str] = set()
        self._last_line: str | None = None

    # -- session ----------------------------------------------------------
    async def create_session(self) -> None:
        url = (
            f"{self._settings.orchestrator_base_url}"
            f"/apps/{ORCHESTRATOR_APP_NAME}/users/{self._user_id}/sessions"
        )
        response = await self._client.post(url, json={"session_id": self._session_id})
        response.raise_for_status()
        print(_c(DIM, f"session {self._session_id} created on {ORCHESTRATOR_APP_NAME}"))

    # -- streaming --------------------------------------------------------
    async def _run(self, parts: list[dict[str, Any]]) -> PendingCall | None:
        """Streams one turn and returns the long-running call it parked on."""
        body = {
            "appName": ORCHESTRATOR_APP_NAME,
            "userId": self._user_id,
            "sessionId": self._session_id,
            "streaming": False,
            "newMessage": {"role": "user", "parts": parts},
        }
        pending: PendingCall | None = None
        url = f"{self._settings.orchestrator_base_url}/run_sse"
        async with self._client.stream("POST", url, json=body) as response:
            if response.status_code != 200:
                body_text = (await response.aread()).decode()
                raise RuntimeError(f"/run_sse failed: {response.status_code} {body_text}")
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[len("data: ") :])
                found = self._render(event)
                if found is not None:
                    pending = found
        return pending

    def _render(self, event: dict[str, Any]) -> PendingCall | None:
        """Prints one ADK event and reports any long-running call it carries."""
        event_id = event.get("id")
        if event_id and event_id in self._seen_events:
            return None
        if event_id:
            self._seen_events.add(event_id)

        author = event.get("author", "?")
        metadata = event.get("customMetadata") or {}
        task_id = metadata.get("a2a:task_id")
        if task_id and task_id != self._task_id:
            self._task_id = task_id
            self._context_id = metadata.get("a2a:context_id")
            print(
                _c(CYAN, "  ┌─ A2A task bound ")
                + _c(DIM, f"task_id={task_id} context_id={self._context_id}")
            )

        long_running = set(event.get("longRunningToolIds") or [])
        pending: PendingCall | None = None
        for part in (event.get("content") or {}).get("parts") or []:
            if text := part.get("text"):
                line = f"  {_c(BOLD, author)}: {text.strip()}"
                if line != self._last_line:
                    print(line)
                    self._last_line = line
            if call := part.get("functionCall"):
                marker = _c(YELLOW, "⏸ long-running") if call["id"] in long_running else "→"
                print(f"  {_c(DIM, author)} {marker} call {_c(BOLD, call['name'])}"
                      f"({json.dumps(call.get('args') or {}, default=str)[:140]})")
                if call["id"] in long_running:
                    pending = PendingCall(call["id"], call["name"], call.get("args") or {})
            if response := part.get("functionResponse"):
                payload = response.get("response")
                if isinstance(payload, dict):
                    self._responses[response["name"]] = payload
                print(f"  {_c(DIM, author)} ← {response['name']} "
                      f"{_c(DIM, json.dumps(payload, default=str)[:140])}")
        if error := event.get("errorMessage"):
            print(_c(RED, f"  !! {author}: {error}"))
        return pending

    # -- turns ------------------------------------------------------------
    async def send_text(self, text: str) -> PendingCall | None:
        print(f"\n{_c(BOLD, '▶ user')}: {text}")
        return await self._run([{"text": text}])

    async def send_function_response(
        self, call: PendingCall, payload: dict[str, Any]
    ) -> PendingCall | None:
        print(
            f"\n{_c(BOLD, '▶ user')} → function response for "
            f"{_c(BOLD, call.name)} ({call.call_id}): "
            f"{json.dumps(payload, default=str)[:160]}"
        )
        return await self._run(
            [{"functionResponse": {"id": call.call_id, "name": call.name, "response": payload}}]
        )

    # -- resolvers --------------------------------------------------------
    def resolve_approval(self, call: PendingCall, mode: str) -> dict[str, Any]:
        pending = self._responses.get(HITL_TOOL, {})
        ticket = pending.get("ticket_id", "unknown")
        print()
        print(_c(YELLOW, "  ── HUMAN APPROVAL REQUIRED ──────────────────────────────"))
        print(f"     ticket      {ticket}")
        print(f"     change      {call.args.get('service')} {call.args.get('version')} "
              f"-> {call.args.get('environment')}")
        print(f"     risk        {call.args.get('risk')}")
        print(f"     summary     {call.args.get('summary')}")
        print(_c(DIM, f"     the remote A2A task {self._task_id} is parked in INPUT_REQUIRED"))
        if mode == "approve":
            approved, note = True, "auto-approved by demo client"
        elif mode == "reject":
            approved, note = False, "auto-rejected by demo client"
        else:
            answer = input("     approve this change? [y/N] ").strip().lower()
            approved = answer in ("y", "yes")
            note = input("     note (optional): ").strip() or None
        print()
        return {
            "ticket_id": ticket,
            "approved": approved,
            "decided_by": "demo-client-operator",
            "note": note,
        }

    async def resolve_job(self, call: PendingCall) -> dict[str, Any]:
        started = self._responses.get(JOB_TOOL, {})
        job_id = started.get("job_id")
        if not job_id:
            return {"status": "failed", "error": "no job id was returned by start_deployment"}
        url = f"{self._settings.remote_agent_base_url}/ops/jobs/{job_id}"
        print(_c(YELLOW, f"  ── WAITING ON BACKGROUND JOB {job_id} ────────────────"))
        print(_c(DIM, f"     the remote A2A task {self._task_id} is parked in INPUT_REQUIRED"))
        print(_c(DIM, f"     polling {url}"))
        last_stage = None
        deadline = self._settings.deployment_job_seconds * 4 + 60
        for _ in range(deadline):
            response = await self._client.get(url)
            response.raise_for_status()
            job = response.json()
            if job["stage"] != last_stage:
                last_stage = job["stage"]
                print(f"     {job['progress']:3d}%  {last_stage}")
            if job["state"] in ("succeeded", "failed"):
                print()
                return job["result"] or {"status": job["state"], "job_id": job_id}
            await asyncio.sleep(1)
        return {"status": "failed", "job_id": job_id, "error": "timed out waiting for the job"}

    # -- driver -----------------------------------------------------------
    async def run(self, prompt: str, approval_mode: str, max_turns: int = 12) -> None:
        await self.create_session()
        pending = await self.send_text(prompt)
        for _ in range(max_turns):
            if pending is None:
                break
            if pending.name == HITL_TOOL:
                payload = self.resolve_approval(pending, approval_mode)
            elif pending.name == JOB_TOOL:
                payload = await self.resolve_job(pending)
            else:
                print(_c(RED, f"  !! unhandled long-running call: {pending.name}"))
                break
            pending = await self.send_function_response(pending, payload)
        else:
            print(_c(RED, "  !! gave up after too many turns"))
            return
        if pending is None:
            print(_c(GREEN, "\n✓ conversation finished with no pending calls"))
            if self._task_id:
                print(_c(DIM, f"  final A2A task: {self._task_id}"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--prompt",
        default="Please deploy checkout-api 2.14.0 to production.",
        help="the opening message sent to the orchestrator",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--auto-approve", action="store_true", help="approve without prompting")
    group.add_argument("--auto-reject", action="store_true", help="reject without prompting")
    parser.add_argument("--user-id", default="demo-operator")
    parser.add_argument("--session-id", default=None)
    return parser.parse_args()


async def amain() -> int:
    args = parse_args()
    settings = get_settings()
    mode = "approve" if args.auto_approve else "reject" if args.auto_reject else "ask"
    session_id = args.session_id or f"demo-{uuid.uuid4().hex[:8]}"

    print(_c(BOLD, "adk-a2a-poc demo client"))
    print(_c(DIM, f"  orchestrator {settings.orchestrator_base_url}"))
    print(_c(DIM, f"  remote card  {settings.deployment_agent_card_url}"))

    timeout = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        demo = DemoClient(client, user_id=args.user_id, session_id=session_id)
        try:
            await demo.run(args.prompt, mode)
        except httpx.ConnectError as exc:
            print(_c(RED, f"\ncannot reach a server: {exc}"))
            print(_c(DIM, "  start both with: make run  (or scripts/run_all.sh)"))
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
