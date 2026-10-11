#!/usr/bin/env python
"""Reproduce ag-ui-protocol/ag-ui#2603 against two agui-server pods.

Behaves like any AG-UI front end: it keeps the conversation on the client and
sends the WHOLE history with every run. It just chooses which pod serves each
run, instead of leaving it to a load balancer:

    run 1  → pod A   [Q1]                    pod A answers Q1
    run 2  → pod B   [Q1, A1, Q2]            pod B answers Q2
    run 3  → pod A   [Q1, A1, Q2, A2]        a reconnect: nothing new to answer

Then it reads the shared session and counts how many times each question was
stored. With ag-ui-adk 0.8.0, pod A has never processed Q2 (pod B did), so in
run 3 it treats Q2 as new and answers it again: Q2 is stored twice. With 0.9.0
the ledger of processed message ids lives in the shared session, so pod A
skips it. This is the upstream regression test
test_live_replica_that_missed_a_turn_does_not_answer_it_again.

    python agui/scripts/repro.py --a http://10.244.1.7:8080 --b http://10.244.2.9:8080

Exit 0 = no duplicate, 3 = duplicate (the bug), 1 = something else failed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from typing import Any

import httpx

BOLD, DIM, GREEN, RED, YELLOW, RESET = (
    "\033[1m",
    "\033[2m",
    "\033[32m",
    "\033[31m",
    "\033[33m",
    "\033[0m",
)
if os.environ.get("NO_COLOR"):
    BOLD = DIM = GREEN = RED = YELLOW = RESET = ""


def run(base: str, thread: str, messages: list[dict[str, Any]]) -> tuple[str, str, list[str], str]:
    """One AG-UI run. Returns (served_by, assistant_text, event_types, version)."""
    body = {
        "threadId": thread,
        "runId": "run-" + uuid.uuid4().hex[:8],
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    text, types = "", []
    # A fresh connection per run, as two separate browser requests would be.
    with httpx.Client(timeout=120.0) as http:
        with http.stream(
            "POST", f"{base}/agui", json=body, headers={"Accept": "text/event-stream"}
        ) as resp:
            resp.raise_for_status()
            served = resp.headers.get("x-served-by", "?")
            version = resp.headers.get("x-ag-ui-adk", "?")
            buf = ""
            for chunk in resp.iter_text():
                buf += chunk.replace("\r\n", "\n")
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    data = "\n".join(
                        line[5:].lstrip() for line in block.split("\n") if line.startswith("data:")
                    )
                    if not data:
                        continue
                    event = json.loads(data)
                    types.append(event.get("type", "?"))
                    if event.get("type") == "TEXT_MESSAGE_CONTENT":
                        text += event.get("delta", "")
                    if event.get("type") == "RUN_ERROR":
                        text += f"[RUN_ERROR {event.get('message')}]"
    return served, text, types, version


def _show(n: int, served: str, sent: str, text: str, version: str = "") -> None:
    extra = f"  {DIM}(ag-ui-adk {version}){RESET}" if version else ""
    print(f"\n{BOLD}run {n} → {served}{RESET}{extra}")
    print(f"  sent     {sent}")
    print(f"  answer   {(text or '(no new answer)')[:110]!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--a", required=True, help="base URL of pod A, e.g. http://10.244.1.7:8080")
    ap.add_argument("--b", required=True, help="base URL of pod B")
    ap.add_argument("--q1", default="What can you do?")
    ap.add_argument("--q2", default="Thanks. Is there anything else you can help with?")
    args = ap.parse_args()

    thread = "thread-" + uuid.uuid4().hex[:10]
    q1 = {"id": "u-" + uuid.uuid4().hex[:8], "role": "user", "content": args.q1}
    q2 = {"id": "u-" + uuid.uuid4().hex[:8], "role": "user", "content": args.q2}
    print(f"{BOLD}thread {thread}{RESET}")

    # Turn 1 on pod A.
    pod_a, text, _, version = run(args.a, thread, [q1])
    _show(1, pod_a, "[Q1]  — a new question", text, version)
    a1 = {"id": "a-" + uuid.uuid4().hex[:8], "role": "assistant", "content": text}

    # Turn 2 lands on pod B (round-robin), with the whole history.
    pod_b, text, _, _ = run(args.b, thread, [q1, a1, q2])
    _show(2, pod_b, "[Q1, A1, Q2]  — the whole history plus a new question", text)
    a2 = {"id": "a-" + uuid.uuid4().hex[:8], "role": "assistant", "content": text}
    if pod_a == pod_b:
        print(
            f"{YELLOW}  both runs hit the same pod — pass two different pods to see the bug{RESET}"
        )

    # The page reconnects (refresh, network blip, a state sync) and re-runs with
    # the history it has — nothing new in it — and pod A serves it. Pod A never
    # processed Q2: it was pod B's turn.
    pod_c, text, _, _ = run(args.a, thread, [q1, a1, q2, a2])
    _show(3, pod_c, "[Q1, A1, Q2, A2]  — a reconnect: the history, nothing new", text)

    with httpx.Client(timeout=30.0) as http:
        stored = http.get(f"{args.a}/debug/threads/{thread}").json()
    print(f"\n{BOLD}what the shared session holds{RESET}  ({stored['events']} events)")
    for t in stored["turns"]:
        who = "user " if t["author"] == "user" else "agent"
        print(f"  {who}  {t['text'][:100]}")

    if stored["duplicates"]:
        for d in stored["duplicates"]:
            print(f"\n{RED}✗ DUPLICATE: {d['text']!r} was stored {d['times']} times.{RESET}")
        print(f"{DIM}  {pod_c} had not processed that question itself (another pod had), so it")
        print("  treated the re-sent question as new and answered it again.")
        print(f"  This is ag-ui-protocol/ag-ui#2603.{RESET}")
        return 3
    if stored["user_turns"] != 2:
        print(f"\n{YELLOW}? expected 2 user turns, found {stored['user_turns']}{RESET}")
        return 1
    print(f"\n{GREEN}✓ each question stored once, though two pods served the thread{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
