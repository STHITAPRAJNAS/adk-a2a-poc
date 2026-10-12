#!/usr/bin/env python
"""Which client behaviours duplicate work across replicas: one scenario per row.

Where virtual_users.py lets the load balancer choose, this sends each run to a
chosen pod, so every scenario is deterministic. Each scenario is a fresh
thread; the result columns come from the shared store afterwards.

    A  text turn, then a re-run with nothing new on another pod
    B  tool turn (incident), then a re-run with nothing new on another pod
    C  the same re-run, but on the pod that answered (sticky routing)
    D  stream breaks mid-incident; client keeps the tool call (CopilotKit), retries on another pod
    E  stream breaks mid-incident; client keeps only the user message, retries on another pod
    F  a new message on a third pod (the normal case)

    python agui/prodlike/loadtest/client_matrix.py --pods http://10.244.1.7:8080 http://10.244.2.9:8080 http://10.244.1.8:8080

agui/prodlike/scripts/matrix.sh runs it inside the cluster against the
support-desk pod IPs. Exit 0 always; read the table.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from typing import Any

import httpx

SYNTHETIC = json.dumps({"status": "error", "reason": "missing_terminal_event", "message": "terminated"},
                       separators=(",", ":"))


def run(base: str, thread: str, messages: list[dict[str, Any]], drop_after_tool_call: bool = False
        ) -> tuple[list[dict[str, Any]], bool, bool, str]:
    """One AG-UI run. Returns (messages the client would add, answered, dropped, pod)."""
    body = {"threadId": thread, "runId": str(uuid.uuid4()), "protocolVersion": "1.0",
            "state": {"environment": "production"}, "messages": messages,
            "tools": [], "context": [], "forwardedProps": {}}
    added: list[dict[str, Any]] = []
    calls: dict[str, dict[str, Any]] = {}
    text: dict[str, Any] | None = None
    answered = False
    with httpx.Client(timeout=120) as http:
        with http.stream("POST", f"{base}/agui", json=body, headers={"Accept": "text/event-stream"}) as r:
            pod = r.headers.get("x-served-by", "?")
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:])
                t = ev["type"]
                if t == "TEXT_MESSAGE_START":
                    answered = True
                    text = {"id": ev["messageId"], "role": "assistant", "content": ""}
                    added.append(text)
                elif t == "TEXT_MESSAGE_CONTENT" and text is not None:
                    text["content"] += ev["delta"]
                elif t == "TOOL_CALL_START":
                    answered = True
                    msg = {"id": ev.get("parentMessageId") or ev["toolCallId"], "role": "assistant",
                           "toolCalls": [{"id": ev["toolCallId"], "type": "function",
                                          "function": {"name": ev["toolCallName"], "arguments": ""}}]}
                    calls[ev["toolCallId"]] = msg
                    added.append(msg)
                elif t == "TOOL_CALL_ARGS":
                    calls[ev["toolCallId"]]["toolCalls"][0]["function"]["arguments"] += ev["delta"]
                elif t == "TOOL_CALL_END" and drop_after_tool_call:
                    return added, answered, True, pod  # the connection breaks here
                elif t == "TOOL_CALL_RESULT":
                    added.append({"id": ev["messageId"], "role": "tool",
                                  "toolCallId": ev["toolCallId"], "content": ev["content"]})
    return added, answered, False, pod


def user(text: str) -> dict[str, Any]:
    return {"id": str(uuid.uuid4()), "role": "user", "content": text}


def scenario(pods: list[str], label: str, steps: list[tuple[str, int, str | None]]) -> None:
    thread = "matrix-" + uuid.uuid4().hex[:10]
    history: list[dict[str, Any]] = []
    log = []
    for kind, p, text in steps:
        base = pods[p % len(pods)]
        if kind == "say":
            history.append(user(text or ""))
            added, answered, _, pod = run(base, thread, history)
            history += added
        elif kind == "rerun":
            added, answered, _, pod = run(base, thread, history)
            history += added
        elif kind in ("say-drop-keep", "say-drop-forget"):
            history.append(user(text or ""))
            added, answered, _, pod = run(base, thread, history, drop_after_tool_call=True)
            if kind == "say-drop-keep":
                # CopilotKit keeps the tool call and fills in a synthetic result.
                history += added
                for m in added:
                    for c in m.get("toolCalls", []):
                        history.append({"id": f"{c['id']}-result", "role": "tool",
                                        "toolCallId": c["id"], "content": SYNTHETIC})
        log.append(f"{kind}→{pod.rsplit('-', 1)[-1]}:{'answer' if answered else '—'}")
    time.sleep(5)  # let a run whose client went away finish on its pod
    th = httpx.get(f"{pods[0]}/debug/threads/{thread}", timeout=30).json()
    inc = httpx.get(f"{pods[0]}/debug/incidents", params={"thread": thread}, timeout=30).json()
    dups = sum(d["times"] - 1 for d in th["duplicates"])
    print(f"{label:<66} {dups:>6} {len(inc['incidents']):>9}   {' '.join(log)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pods", nargs="+", required=True, help="base URLs of 2–3 support-desk pods")
    args = ap.parse_args()
    pods = [p.rstrip("/") for p in args.pods]
    version = httpx.get(f"{pods[0]}/health", timeout=10).json().get("ag_ui_adk", "?")
    print(f"ag-ui-adk {version}, pods: {', '.join(pods)}\n")
    print(f"{'scenario':<66} {'dup':>6} {'incidents':>9}   runs (→pod:answered?)")
    print("-" * 114)
    outage = "checkout-api is down, open an incident"
    scenario(pods, "A text turn, re-run with nothing new on another pod",
             [("say", 0, "hello"), ("say", 1, "thanks, that's all"), ("rerun", 0, None)])
    scenario(pods, "B incident turn, re-run with nothing new on another pod",
             [("say", 0, "hello"), ("say", 1, outage), ("rerun", 0, None)])
    scenario(pods, "C text turn, re-run on the pod that answered (sticky)",
             [("say", 0, "hello"), ("say", 1, "thanks, that's all"), ("rerun", 1, None)])
    scenario(pods, "D drop mid-incident, keep tool call (CopilotKit), retry elsewhere",
             [("say", 0, "hello"), ("say-drop-keep", 1, outage), ("rerun", 2, None)])
    scenario(pods, "E drop mid-incident, keep only the user message, retry elsewhere",
             [("say", 0, "hello"), ("say-drop-forget", 1, outage), ("rerun", 2, None)])
    scenario(pods, "F a new message on a third pod",
             [("say", 0, "hello"), ("say", 1, "thanks, that's all"), ("say", 2, "how is search?")])
    print("\ndup = user turns stored more than once; incidents = rows opened for one outage report")
    return 0


if __name__ == "__main__":
    sys.exit(main())
