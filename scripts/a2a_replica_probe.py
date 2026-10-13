#!/usr/bin/env python
"""Lab 84: what a second replica does with a task the first one is running.

Both commands start a release on replica A (``SendStreamingMessage``, read in
the background) and then, while A is still working, send one call to replica
B. A and B share one task store, so B can find the task either way.

    subscribe   SubscribeToTask on B. Does B's stream follow the task live?
    cancel      CancelTask on B. Does the task end CANCELED and stay CANCELED?

    python scripts/a2a_replica_probe.py subscribe \\
        --a http://10.244.1.7:8001/a2a/deployment_agent \\
        --b http://10.244.2.9:8001/a2a/deployment_agent

Exit codes: 0 correct, 3 the replica problem showed up, 1 the probe failed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any

import httpx

H = {"A2A-Version": "1.0"}
COLOUR = not os.environ.get("NO_COLOR")
RELEASE = "deploy checkout-api 2.14.0 to production"


def c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if COLOUR else text


def rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}


def frame_state(frame: dict[str, Any]) -> tuple[str | None, str | None]:
    """(task id, state) from one streamed frame."""
    result = frame.get("result") or {}
    for key in ("task", "statusUpdate"):
        if key in result:
            body = result[key]
            state = (body.get("status") or {}).get("state", "")
            return body.get("id") or body.get("taskId"), state.replace("TASK_STATE_", "")
    return None, None


class Run:
    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.task_id: str | None = None
        self.a_states: list[str] = []

    def log(self, who: str, text: str) -> None:
        print(f"  {time.monotonic() - self.t0:5.1f}s  {who:<12} {text}", flush=True)


async def stream_states(
    http: httpx.AsyncClient,
    url: str,
    method: str,
    params: dict[str, Any],
    run: Run,
    who: str,
    sink: list[str],
    until: set[str],
) -> dict[str, str]:
    """Reads one SSE stream into ``sink``; returns the response headers."""
    async with http.stream(
        "POST", url, json=rpc(method, params), headers={**H, "Accept": "text/event-stream"}
    ) as resp:
        headers = dict(resp.headers)
        if "event-stream" not in resp.headers.get("content-type", ""):
            run.log(who, "answered " + (await resp.aread()).decode()[:160])
            return headers
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            frame = json.loads(line[5:])
            if "error" in frame:
                run.log(who, c("31", "error " + json.dumps(frame["error"])[:140]))
                return headers
            task_id, state = frame_state(frame)
            if task_id and run.task_id is None:
                run.task_id = task_id
            if state and (not sink or sink[-1] != state):
                sink.append(state)
                run.log(who, state)
            if state in until:
                return headers
    return headers


async def get_state(http: httpx.AsyncClient, url: str, task_id: str) -> str:
    body = (await http.post(url, json=rpc("GetTask", {"id": task_id}), headers=H)).json()
    return (
        ((body.get("result") or {}).get("status") or {})
        .get("state", "?")
        .replace("TASK_STATE_", "")
    )


async def start_on_a(http: httpx.AsyncClient, a: str, run: Run) -> asyncio.Task:
    message = {"messageId": uuid.uuid4().hex, "role": "ROLE_USER", "parts": [{"text": RELEASE}]}
    task = asyncio.create_task(
        stream_states(
            http,
            a,
            "SendStreamingMessage",
            {"message": message},
            run,
            "A send",
            run.a_states,
            {"INPUT_REQUIRED", "COMPLETED", "CANCELED", "FAILED", "REJECTED"},
        )
    )
    for _ in range(300):
        if run.task_id:
            break
        await asyncio.sleep(0.05)
    if not run.task_id:
        raise RuntimeError("replica A never reported a task id")
    await asyncio.sleep(1.0)  # well inside the compliance scan: A is busy
    return task


async def cmd_subscribe(args: argparse.Namespace) -> int:
    run = Run()
    print(c("1", "SubscribeToTask on the replica that is NOT running the task"))
    async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=None)) as http:
        a_task = await start_on_a(http, args.a, run)
        b_states: list[str] = []
        served_by: dict[str, str] = {}

        async def subscribe_b() -> None:
            served_by.update(
                await stream_states(
                    http,
                    args.b,
                    "SubscribeToTask",
                    {"id": run.task_id},
                    run,
                    "B subscribe",
                    b_states,
                    {"INPUT_REQUIRED", "COMPLETED", "CANCELED", "FAILED", "REJECTED"},
                )
            )

        b_task = asyncio.create_task(subscribe_b())
        await asyncio.wait_for(a_task, 120)
        try:
            await asyncio.wait_for(b_task, args.wait)
        except TimeoutError:
            run.log("B subscribe", f"nothing new for {args.wait:.0f}s after A finished; giving up")
    a_last = run.a_states[-1] if run.a_states else "?"
    b_last = b_states[-1] if b_states else "nothing"
    print()
    if b_last == a_last:
        via = served_by.get("x-a2a-served-by")
        print(
            c("32", f"✓ B's subscription followed the task live to {a_last}")
            + (f" (forwarded to {via}, which runs it)" if via else "")
        )
        return 0
    print(
        c(
            "31",
            f"✗ STUCK: the task reached {a_last} on A; B's subscriber saw {b_states or 'nothing'} "
            "and is still waiting.",
        )
    )
    print("  B found the task in the shared store and sent the stored snapshot, but the live")
    print("  events only exist in A's memory, so none will ever reach B's stream.")
    return 3


async def cmd_cancel(args: argparse.Namespace) -> int:
    run = Run()
    print(c("1", "CancelTask on the replica that is NOT running the task"))
    async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=None)) as http:
        a_task = await start_on_a(http, args.a, run)
        resp = await http.post(args.b, json=rpc("CancelTask", {"id": run.task_id}), headers=H)
        body = resp.json()
        answered = ((body.get("result") or {}).get("status") or {}).get("state", "")
        answered = answered.replace("TASK_STATE_", "") or json.dumps(body.get("error"))[:120]
        via = resp.headers.get("x-a2a-served-by")
        run.log("B cancel", f"answered {answered}" + (f" (forwarded to {via})" if via else ""))
        run.log("GetTask", await get_state(http, args.b, run.task_id))
        await asyncio.wait_for(a_task, 120)
        await asyncio.sleep(1.0)
        final = await get_state(http, args.b, run.task_id)
        run.log("GetTask", f"{final} (after A's stream ended)")
    print()
    if final == "CANCELED":
        print(c("32", "✓ canceled, and it stayed canceled: the work stopped where it ran"))
        return 0
    print(c("31", f"✗ RESURRECTED: B answered {answered}, then the task became {final}."))
    print("  B marked the task canceled in the shared store, but the work runs in A's memory.")
    print("  A never heard of the cancel, kept going, and overwrote a final state.")
    return 3


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("subscribe", "cancel"):
        p = sub.add_parser(name)
        p.add_argument("--a", required=True, help="A2A URL of the replica that will run the task")
        p.add_argument("--b", required=True, help="A2A URL of the other replica")
        p.add_argument(
            "--wait", type=float, default=15.0, help="how long to keep watching B after A is done"
        )
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(cmd_subscribe(args) if args.command == "subscribe" else cmd_cancel(args))
    except (httpx.HTTPError, RuntimeError) as exc:
        print(c("31", f"probe failed: {exc}"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
