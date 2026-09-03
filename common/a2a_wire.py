"""A minimal, dependency-light A2A JSON-RPC client.

Everything here is hand-rolled on top of ``httpx`` rather than the a2a-sdk
client, on purpose: the point of the probes and the protocol tests is to show
what actually crosses the wire, and a typed SDK client hides exactly the parts
worth looking at.

The endpoint ADK mounts answers both JSON-RPC generations on one URL. This
module speaks the **0.3** method names (``message/send``, ``message/stream``,
``tasks/get``, ``tasks/cancel``) with 0.3-shaped payloads, because that is what
most A2A tooling emits today and because the 0.3 frames are far easier to read.
The 1.x proto-JSON names (``SendMessage``, ``SendStreamingMessage``, ``GetTask``)
hit the same handler; ``TASK_STATE_*`` spellings are accepted throughout so a
1.x server reads correctly too.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

#: ADK namespaces the metadata it attaches to A2A parts and events.
ADK_TYPE_KEY = "adk_type"
ADK_LONG_RUNNING_KEY = "adk_is_long_running"
ADK_CUSTOM_METADATA_KEY = "adk_custom_metadata"
ADK_AUTHOR_KEY = "adk_author"

#: Keys ``RemoteA2aAgent`` writes onto ADK event metadata. When an agent is both
#: an A2A server and an A2A client, these ride out on its own A2A events, which
#: is how a caller can see the id of the *downstream* task its request created.
A2A_TASK_ID_KEY = "a2a:task_id"
A2A_CONTEXT_ID_KEY = "a2a:context_id"

COMPLETED_STATES = {"completed", "TASK_STATE_COMPLETED"}
FAILED_STATES = {"failed", "rejected", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"}
CANCELED_STATES = {"canceled", "TASK_STATE_CANCELED"}
PAUSED_STATES = {
    "input-required",
    "auth-required",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
}
TERMINAL_STATES = COMPLETED_STATES | FAILED_STATES | CANCELED_STATES


def rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}


def text_message(
    text: str, *, task_id: str | None = None, context_id: str | None = None
) -> dict[str, Any]:
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


def function_response_message(
    *,
    call_id: str,
    name: str,
    payload: dict[str, Any],
    task_id: str,
    context_id: str | None = None,
) -> dict[str, Any]:
    """Builds the message that resumes a task parked in ``input-required``.

    The shape is load-bearing. The server matches on a DataPart tagged
    ``adk_type: function_response`` whose ``id`` equals the pending call's id,
    sent on the same ``taskId``. Plain text on a paused task does not resume it
    — it runs the agent again and drives the task to a terminal state with the
    gate still unanswered.
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


@dataclass(frozen=True)
class PendingCall:
    """A long-running function call a task is parked on."""

    call_id: str
    name: str
    args: dict[str, Any]


@dataclass
class TurnResult:
    """Everything one ``message/stream`` exchange revealed."""

    frames: list[dict[str, Any]] = field(default_factory=list)
    task_id: str | None = None
    context_id: str | None = None
    #: Task ids created *downstream* of this agent, seen through the metadata
    #: its own RemoteA2aAgent stamped on the events it emitted. Empty for a leaf
    #: agent; one entry per hop for an agent that delegates.
    downstream_task_ids: set[str] = field(default_factory=set)
    error: dict[str, Any] | None = None

    @property
    def states(self) -> list[str]:
        """Task states in order, with consecutive repeats collapsed."""
        seen: list[str] = []
        for result in self.results:
            state = (result.get("status") or {}).get("state")
            if state and (not seen or seen[-1] != state):
                seen.append(state)
        return seen

    @property
    def final_state(self) -> str | None:
        return self.states[-1] if self.states else None

    @property
    def results(self) -> list[dict[str, Any]]:
        return [frame["result"] for frame in self.frames if "result" in frame]

    @property
    def is_paused(self) -> bool:
        return self.final_state in PAUSED_STATES

    @property
    def pending_calls(self) -> list[PendingCall]:
        """Unanswered long-running calls, deduplicated and in first-seen order.

        ADK surfaces each pending call twice: once in the ``working`` update
        carrying the model turn, and again in the terminal ``input-required``
        update that says what the task is waiting on.
        """
        found: dict[str, PendingCall] = {}
        for part in self._parts():
            metadata = part.get("metadata") or {}
            if not metadata.get(ADK_LONG_RUNNING_KEY):
                continue
            data = part.get("data") or {}
            if data.get("id") and data.get("name"):
                found.setdefault(
                    data["id"], PendingCall(data["id"], data["name"], data.get("args") or {})
                )
        return list(found.values())

    @property
    def pending(self) -> PendingCall | None:
        calls = self.pending_calls
        return calls[-1] if calls else None

    @property
    def tool_responses(self) -> dict[str, dict[str, Any]]:
        """Newest response payload per tool name, read off the DataParts."""
        responses: dict[str, dict[str, Any]] = {}
        for part in self._parts():
            metadata = part.get("metadata") or {}
            if metadata.get(ADK_TYPE_KEY) != "function_response":
                continue
            data = part.get("data") or {}
            if data.get("name") and isinstance(data.get("response"), dict):
                responses[data["name"]] = data["response"]
        return responses

    @property
    def texts(self) -> list[str]:
        out: list[str] = []
        for part in self._parts():
            if text := part.get("text"):
                stripped = text.strip()
                if stripped and (not out or out[-1] != stripped):
                    out.append(stripped)
        return out

    def _parts(self) -> list[dict[str, Any]]:
        parts: list[dict[str, Any]] = []
        for result in self.results:
            message = (result.get("status") or {}).get("message") or {}
            parts.extend(message.get("parts") or [])
            if result.get("kind") == "message":
                parts.extend(result.get("parts") or [])
        return parts


class A2AWireClient:
    """Speaks A2A JSON-RPC to one agent endpoint."""

    def __init__(self, client: httpx.AsyncClient, rpc_url: str, *, card_url: str | None = None):
        self._client = client
        self.rpc_url = rpc_url
        self.card_url = card_url or f"{rpc_url}/.well-known/agent-card.json"

    async def fetch_card(self) -> dict[str, Any]:
        response = await self._client.get(self.card_url)
        response.raise_for_status()
        return response.json()

    async def stream(self, message: dict[str, Any]) -> TurnResult:
        """Sends ``message/stream`` and collects the whole event stream."""
        turn = TurnResult()
        async with self._client.stream(
            "POST",
            self.rpc_url,
            json=rpc("message/stream", {"message": message}),
            headers={"Accept": "text/event-stream"},
        ) as response:
            response.raise_for_status()
            # A JSON-RPC error arrives as a plain JSON body with HTTP 200, not
            # as an event stream. Without this branch a rejected request reads
            # as a clean run that produced no events.
            if "text/event-stream" not in response.headers.get("content-type", ""):
                body = json.loads((await response.aread()).decode())
                turn.error = body.get("error") or body
                return turn
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    self._absorb(turn, json.loads(line[len("data: ") :]))
        return turn

    def _absorb(self, turn: TurnResult, frame: dict[str, Any]) -> None:
        if "error" in frame:
            turn.error = frame["error"]
            return
        result = frame.get("result") or {}
        # 0.3 frames are flat and self-describing via ``kind``; 1.x wraps the
        # payload in a one-key envelope. Normalise both to a flat dict.
        for key in ("task", "statusUpdate", "artifactUpdate", "message"):
            if isinstance(result.get(key), dict):
                result = {**result[key], "kind": key}
                break
        turn.frames.append({"result": result})

        turn.task_id = turn.task_id or result.get("id") or result.get("taskId")
        turn.context_id = turn.context_id or result.get("contextId")
        self._absorb_downstream_ids(turn, result.get("metadata") or {})

    @staticmethod
    def _absorb_downstream_ids(turn: TurnResult, metadata: dict[str, Any]) -> None:
        raw = metadata.get(ADK_CUSTOM_METADATA_KEY)
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                return
        if isinstance(raw, dict) and isinstance(raw.get(A2A_TASK_ID_KEY), str):
            turn.downstream_task_ids.add(raw[A2A_TASK_ID_KEY])

    async def get_task(self, task_id: str) -> dict[str, Any]:
        """Fetches a task, trying the 0.3 shape then the 1.x one."""
        response = await self._client.post(self.rpc_url, json=rpc("tasks/get", {"id": task_id}))
        response.raise_for_status()
        body = response.json()
        if "error" in body:
            response = await self._client.post(
                self.rpc_url, json=rpc("GetTask", {"name": task_id})
            )
            body = response.json()
        result = body.get("result") or {}
        return result.get("task") or result

    async def cancel_task(self, task_id: str) -> dict[str, Any]:
        response = await self._client.post(self.rpc_url, json=rpc("tasks/cancel", {"id": task_id}))
        response.raise_for_status()
        return response.json()


def card_summary(card: dict[str, Any]) -> dict[str, Any]:
    """Flattens the fields worth printing from a card of either generation."""
    interfaces = card.get("supportedInterfaces") or []
    urls = [i.get("url") for i in interfaces if i.get("url")]
    if not urls and card.get("url"):
        urls = [card["url"]]
    return {
        "name": card.get("name"),
        "description": card.get("description", ""),
        "version": card.get("version"),
        "urls": urls,
        "transports": [i.get("protocolBinding") for i in interfaces] or ["JSONRPC"],
        "streaming": (card.get("capabilities") or {}).get("streaming"),
        "skills": [(s.get("id"), s.get("name")) for s in card.get("skills") or []],
    }
