#!/usr/bin/env python
"""Lab 85: send one release request into a pair of agents that delegate to each other.

Sends ``deploy checkout-api 2.14.0 to production`` to the first agent and
watches for up to ``--deadline`` seconds. Before and after, it counts the tasks
every agent listed in ``--agents`` holds (``ListTasks``), so you see how many
hops one request turned into.

    python scripts/a2a_loop_probe.py \\
        --entry http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge \\
        --agents http://loop-a.agents.svc.cluster.local:8000/a2a/ops_concierge \\
                 http://loop-b.agents.svc.cluster.local:8000/a2a/ops_concierge

Exit codes: 0 the request ended with an answer (a refusal counts), 3 it was
still bouncing at the deadline, 1 the probe failed.
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


def c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if COLOUR else text


def rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}


async def count_tasks(http: httpx.AsyncClient, url: str) -> int:
    body = (await http.post(url, json=rpc("ListTasks", {"pageSize": 100}), headers=H)).json()
    result = body.get("result") or {}
    return int(result.get("totalSize") or len(result.get("tasks") or []))


def texts(frame: dict[str, Any]) -> list[str]:
    result = frame.get("result") or {}
    out = []
    for key in ("task", "statusUpdate", "message"):
        body = result.get(key) or {}
        msg = (body.get("status") or {}).get("message") if key != "message" else body
        for part in (msg or {}).get("parts") or []:
            if part.get("text"):
                out.append(part["text"])
    # ADK streams the final answer as an artifact.
    for part in ((result.get("artifactUpdate") or {}).get("artifact") or {}).get("parts") or []:
        if part.get("text"):
            out.append(part["text"])
    return out


async def main_async(args: argparse.Namespace) -> int:
    async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=None)) as http:
        before = {u: await count_tasks(http, u) for u in args.agents}
        message = {
            "messageId": uuid.uuid4().hex,
            "role": "ROLE_USER",
            "parts": [{"text": "deploy checkout-api 2.14.0 to production"}],
        }
        t0 = time.monotonic()
        last_state, said = "?", []

        async def read() -> None:
            nonlocal last_state
            async with http.stream(
                "POST",
                args.entry,
                json=rpc("SendStreamingMessage", {"message": message}),
                headers={**H, "Accept": "text/event-stream"},
            ) as resp:
                if "event-stream" not in resp.headers.get("content-type", ""):
                    said.append((await resp.aread()).decode()[:300])
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    frame = json.loads(line[5:])
                    if "error" in frame:
                        said.append("error: " + json.dumps(frame["error"])[:300])
                        return
                    result = frame.get("result") or {}
                    for key in ("task", "statusUpdate"):
                        if key in result:
                            last_state = (
                                (result[key].get("status") or {})
                                .get("state", "?")
                                .replace("TASK_STATE_", "")
                            )
                    said.extend(texts(frame))

        print(c("1", "one release request into the pair"))
        try:
            await asyncio.wait_for(read(), args.deadline)
            finished = True
        except TimeoutError:
            finished = False
        elapsed = time.monotonic() - t0
        await asyncio.sleep(0.5)
        after = {u: await count_tasks(http, u) for u in args.agents}

    print()
    for url in args.agents:
        print(
            f"  tasks opened on {url.split('//', 1)[-1].split('/', 1)[0]:<40} "
            f"{after[url] - before[url]}"
        )
    total = sum(after[u] - before[u] for u in args.agents)
    if said:
        print(f"  the entry agent said: {said[-1][:220]}")
    print()
    if finished:
        print(
            c(
                "32",
                f"✓ the request ended after {elapsed:.1f}s and {total} task(s), state {last_state}",
            )
        )
        return 0
    print(
        c(
            "31",
            f"✗ LOOP: still bouncing after {elapsed:.0f}s; "
            f"{total} tasks opened so far for ONE request.",
        )
    )
    print(
        "  Every hop is a valid A2A call: the agents delegate to each other and nothing stops it."
    )
    return 3


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--entry", required=True, help="A2A URL of the agent the request goes to")
    ap.add_argument("--agents", nargs="+", required=True, help="A2A URLs whose tasks to count")
    ap.add_argument("--deadline", type=float, default=30.0)
    args = ap.parse_args()
    try:
        return asyncio.run(main_async(args))
    except httpx.HTTPError as exc:
        print(c("31", f"probe failed: {exc}"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
