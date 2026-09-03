#!/usr/bin/env python
"""Talks raw A2A JSON-RPC to the remote agent, with no ADK client in between.

``scripts/demo_client.py`` shows the flow as ADK presents it. This shows the
same flow as it actually goes over the wire, so you can see the parts of the
protocol ADK normally hides:

  * ``GET  /.well-known/agent-card.json``  discovery
  * ``POST message/stream``                streaming task execution
  * ``POST tasks/get``                     task state after a stream ends
  * ``POST tasks/cancel``                  cancellation

and the task state machine that carries HITL:

    submitted -> working -> input-required   (agent parked on a long-running call)
              -> working -> completed        (after a function response resumes it)

The endpoint ADK mounts speaks both JSON-RPC generations on one URL: the 0.3
method names used here (``message/stream``, ``tasks/get``) go through the SDK's
compatibility adapter, and the newer proto-JSON names (``SendStreamingMessage``,
``GetTask``) hit the 1.x path directly. The 0.3 shape is what most existing A2A
tooling speaks, and it reads far better in a terminal, so that is what this
probe sends.

The pending call is not free text: it arrives as a DataPart whose metadata
carries ``adk_type: function_call`` and ``adk_is_long_running: true``. Resuming
means sending a message on the *same* ``taskId`` carrying a DataPart with
``adk_type: function_response`` and the same call id.

Replying with ordinary text instead does not error — and that is the trap worth
seeing. The agent is simply run again with the text as input, produces no new
long-running call, and the task therefore reaches ``completed``. The gate is now
unanswerable: a function response sent afterwards is refused with "Task ... is
already completed". ``wrong-resume`` demonstrates exactly that, on its own task.

Usage:
    python scripts/a2a_probe.py card
    python scripts/a2a_probe.py run --prompt "deploy checkout-api 2.14.0 to production"
    python scripts/a2a_probe.py run --approve      # also resume the HITL gate
    python scripts/a2a_probe.py wrong-resume       # what a plain text reply does
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

from common.config import get_settings  # noqa: E402

BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

#: ADK namespaces its A2A part metadata. These are the keys the executor writes.
ADK_TYPE_KEY = "adk_type"
ADK_LONG_RUNNING_KEY = "adk_is_long_running"

#: Task states, in both the 0.3 spelling the compat adapter emits and the
#: proto enum spelling the 1.x path uses, so the probe reads either.
COMPLETED_STATES = {"completed", "TASK_STATE_COMPLETED"}
FAILED_STATES = {"failed", "rejected", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"}
PAUSED_STATES = {
    "input-required",
    "auth-required",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
}


def _c(colour: str, text: str) -> str:
    return f"{colour}{text}{RESET}"


def _rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}


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
    *,
    call_id: str,
    name: str,
    payload: dict[str, Any],
    task_id: str,
    context_id: str | None,
) -> dict[str, Any]:
    """Builds the message that resumes a task parked in INPUT_REQUIRED.

    The shape matters: ADK's ``handle_user_input`` rejects any resume message
    that does not carry a DataPart tagged as a function response, so a plain
    "yes, go ahead" would bounce back with a complaint rather than resuming.
    """
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


def _iter_parts(container: dict[str, Any]) -> list[dict[str, Any]]:
    return container.get("parts") or []


def _describe_part(part: dict[str, Any]) -> str:
    metadata = part.get("metadata") or {}
    if text := part.get("text"):
        return f"text: {text.strip()[:200]}"
    if (data := part.get("data")) is not None:
        kind = metadata.get(ADK_TYPE_KEY, "data")
        flag = " [LONG-RUNNING]" if metadata.get(ADK_LONG_RUNNING_KEY) else ""
        return f"{kind}{flag}: {json.dumps(data, default=str)[:220]}"
    return f"part: {json.dumps(part, default=str)[:200]}"


class PendingLongRunningCall:
    def __init__(self, call_id: str, name: str, args: dict[str, Any]) -> None:
        self.call_id = call_id
        self.name = name
        self.args = args


class Probe:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client
        self._settings = get_settings()
        self.task_id: str | None = None
        self.context_id: str | None = None
        self.last_state: str | None = None
        self.pending: PendingLongRunningCall | None = None
        #: newest function-response payload per tool name, so a resume can echo
        #: back identifiers the agent minted (the change ticket id, a job id).
        self.tool_responses: dict[str, dict[str, Any]] = {}

    async def fetch_card(self) -> dict[str, Any]:
        url = self._settings.deployment_agent_card_url
        print(_c(BOLD, f"GET {url}"))
        response = await self._client.get(url)
        response.raise_for_status()
        card = response.json()
        interfaces = card.get("supportedInterfaces") or []
        print(f"  name        {card.get('name')}")
        print(f"  version     {card.get('version')}")
        print(f"  transports  {[i.get('protocolBinding') for i in interfaces]}")
        print(f"  rpc url     {[i.get('url') for i in interfaces]}")
        print(f"  streaming   {(card.get('capabilities') or {}).get('streaming')}")
        print("  skills")
        for skill in card.get("skills") or []:
            print(f"    - {skill['id']}: {skill['name']}")
        return card

    async def stream(self, message: dict[str, Any]) -> None:
        """POSTs ``message/stream`` and narrates every event that comes back."""
        self.pending = None
        url = self._settings.deployment_agent_rpc_url
        payload = _rpc("message/stream", {"message": message})
        print(_c(BOLD, f"\nPOST {url}  method=message/stream"))
        print(_c(DIM, f"  request: {json.dumps(payload['params'], default=str)[:300]}"))
        async with self._client.stream(
            "POST", url, json=payload, headers={"Accept": "text/event-stream"}
        ) as response:
            if response.status_code != 200:
                body = (await response.aread()).decode()
                raise RuntimeError(f"message/stream failed: {response.status_code} {body}")
            # A JSON-RPC error comes back as a plain JSON body with status 200,
            # not as an event stream. Surface it rather than reading zero frames
            # and reporting a clean run.
            if "text/event-stream" not in response.headers.get("content-type", ""):
                body = json.loads((await response.aread()).decode())
                error = body.get("error")
                print(_c(RED, f"  << JSON-RPC error {json.dumps(error, default=str)[:400]}"))
                return
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                self._handle_stream_frame(json.loads(line[len("data: ") :]))

    def _handle_stream_frame(self, frame: dict[str, Any]) -> None:
        if "error" in frame:
            print(_c(RED, f"  << error {json.dumps(frame['error'])[:300]}"))
            return
        result = frame.get("result") or {}
        # 0.3 frames are flat and self-describing via ``kind``; 1.x wraps the
        # payload in a one-key envelope. Normalise both to a flat dict.
        for key in ("task", "statusUpdate", "artifactUpdate", "message"):
            if key in result and isinstance(result[key], dict):
                result = {**result[key], "kind": key}
                break
        self._render_result(result)

    def _render_result(self, result: dict[str, Any]) -> None:
        kind = result.get("kind", "raw")
        task_id = result.get("id") or result.get("taskId")
        if task_id and task_id != self.task_id:
            self.task_id = task_id
            self.context_id = result.get("contextId")
            print(_c(CYAN, f"  << task {task_id}") + _c(DIM, f"  context {self.context_id}"))

        status = result.get("status") or {}
        state = status.get("state")
        if state and state != self.last_state:
            self.last_state = state
            colour = (
                YELLOW if state in PAUSED_STATES
                else GREEN if state in COMPLETED_STATES
                else RED if state in FAILED_STATES
                else CYAN
            )
            final = " (final)" if result.get("final") else ""
            print(f"  << {_c(colour, state)}{_c(DIM, final)}  {_c(DIM, f'[{kind}]')}")

        # A status update carries its parts under status.message; a bare
        # message frame carries them at the top level.
        inline = result if kind in ("message", "statusUpdate") else None
        for message in (status.get("message"), inline):
            if not message:
                continue
            for part in _iter_parts(message):
                print(f"       {_describe_part(part)}")
                self._capture_pending(part)

        for artifact in result.get("artifacts") or []:
            for part in _iter_parts(artifact):
                print(f"       artifact {artifact.get('name', '')}: {_describe_part(part)}")

    def _capture_pending(self, part: dict[str, Any]) -> None:
        metadata = part.get("metadata") or {}
        data = part.get("data") or {}
        if metadata.get(ADK_TYPE_KEY) == "function_response":
            payload = data.get("response")
            if isinstance(payload, dict) and data.get("name"):
                self.tool_responses[data["name"]] = payload
            return
        if not metadata.get(ADK_LONG_RUNNING_KEY):
            return
        call_id, name = data.get("id"), data.get("name")
        if call_id and name:
            self.pending = PendingLongRunningCall(call_id, name, data.get("args") or {})

    async def get_task(self) -> dict[str, Any] | None:
        if not self.task_id:
            return None
        url = self._settings.deployment_agent_rpc_url
        print(_c(BOLD, f"\nPOST {url}  method=tasks/get  id={self.task_id}"))
        # 0.3 keys the task by ``id``; the 1.x ``GetTask`` method keys it by
        # ``name``. Try the 0.3 shape first to match the rest of this probe.
        response = await self._client.post(url, json=_rpc("tasks/get", {"id": self.task_id}))
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            response = await self._client.post(url, json=_rpc("GetTask", {"name": self.task_id}))
            body = response.json()
        task = (body.get("result") or {}).get("task") or body.get("result") or {}
        state = (task.get("status") or {}).get("state")
        history = task.get("history") or []
        print(f"  state    {_c(BOLD, str(state))}")
        print(f"  history  {len(history)} message(s)")
        return task


async def cmd_card(probe: Probe, _args: argparse.Namespace) -> int:
    await probe.fetch_card()
    return 0


async def cmd_run(probe: Probe, args: argparse.Namespace) -> int:
    await probe.fetch_card()
    await probe.stream(_text_message(args.prompt))
    await probe.get_task()

    if probe.pending is None:
        print(_c(GREEN, "\n✓ task finished without pausing for input"))
        return 0

    pending = probe.pending
    print(_c(YELLOW, f"\n── task paused on long-running call {pending.name} ({pending.call_id})"))
    print(_c(DIM, f"   args: {json.dumps(pending.args, default=str)[:300]}"))

    if not args.approve:
        print(_c(DIM, "   re-run with --approve to send the function response that resumes it"))
        return 0

    payload = {
        "ticket_id": probe.tool_responses.get(pending.name, {}).get("ticket_id", "unknown"),
        "approved": True,
        "decided_by": "a2a-probe",
        "note": "approved from the raw protocol probe",
    }
    print(_c(BOLD, "\n-- resuming with a function-response DataPart --"))
    assert probe.task_id is not None
    await probe.stream(
        _function_response_message(
            call_id=pending.call_id,
            name=pending.name,
            payload=payload,
            task_id=probe.task_id,
            context_id=probe.context_id,
        )
    )
    await probe.get_task()
    if probe.pending is not None:
        print(
            _c(YELLOW, f"\n── task paused again on {probe.pending.name}; ")
            + _c(YELLOW, "that is the long-running deployment job.")
        )
        print(_c(DIM, "   scripts/demo_client.py drives that one to completion by polling"))
        print(_c(DIM, f"   {get_settings().remote_agent_base_url}/ops/jobs"))
    return 0


async def cmd_wrong_resume(probe: Probe, args: argparse.Namespace) -> int:
    """Answers a paused task with text instead of a function response."""
    await probe.stream(_text_message(args.prompt))
    if probe.pending is None:
        print(_c(RED, "task never paused; nothing to demonstrate"))
        return 1
    print(_c(YELLOW, f"\n── paused on {probe.pending.name} ({probe.pending.call_id})"))
    print(_c(BOLD, "\n-- answering with plain text instead of a function response --"))
    await probe.stream(
        _text_message("yes, go ahead", task_id=probe.task_id, context_id=probe.context_id)
    )
    task = await probe.get_task()
    state = ((task or {}).get("status") or {}).get("state")
    print()
    if state in COMPLETED_STATES:
        print(_c(RED, "  The task completed without the gate ever being answered."))
        print(_c(DIM, "  The pending long-running call is now unanswerable — sending the"))
        print(_c(DIM, "  function response after this point is refused with"))
        print(_c(DIM, '  "Task ... is already completed".'))
        print(_c(DIM, "  Resume a paused task with a function-response DataPart, never text."))
    else:
        print(_c(DIM, f"  task state after the text reply: {state}"))
    return 0


async def cmd_cancel(probe: Probe, args: argparse.Namespace) -> int:
    url = probe._settings.deployment_agent_rpc_url  # noqa: SLF001 - probe is local
    print(_c(BOLD, f"POST {url}  method=tasks/cancel  id={args.task_id}"))
    response = await probe._client.post(  # noqa: SLF001
        url, json=_rpc("tasks/cancel", {"id": args.task_id})
    )
    print(json.dumps(response.json(), indent=2)[:1200])
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
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
    timeout = httpx.Timeout(connect=10.0, read=900.0, write=30.0, pool=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        probe = Probe(client)
        try:
            return await handlers[args.command](probe, args)
        except httpx.ConnectError as exc:
            print(_c(RED, f"cannot reach the remote agent: {exc}"))
            print(_c(DIM, "  start it with: make run-remote"))
            return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain()))
