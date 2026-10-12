#!/usr/bin/env python
"""Virtual on-call engineers using the support desk through the load balancer.

Each virtual user behaves like the CopilotKit page in ``agui/prodlike/web``, and
sends exactly what CopilotKit sends (the request shapes were captured from
CopilotKit 1.78 through the runtime's HttpAgent):

* the whole conversation on every run: user messages, assistant text, assistant
  tool-call messages, tool results;
* the shared state the agent last sent back (``STATE_SNAPSHOT``), plus the
  ``environment`` the user picked;
* after switching the environment, a re-run with nothing new
  (``useCoAgent().run()``): the trigger of ag-ui#2603;
* when a stream breaks, what CopilotKit does with the half-finished turn: keep
  the partial text, and give every tool call that has no result a synthetic
  one (``{"status":"error","reason":"missing_terminal_event"}``); then the
  app's Retry: the same conversation again.

The load balancer decides which replica serves each run; nothing here pins a
pod. At the end every thread is audited through the same load balancer: what
the shared session stored and which incidents were opened.

    python agui/prodlike/loadtest/virtual_users.py --lb http://adk-lb:8080 \\
        --users 40 --turns 6 --label 0.8.0 --out report-0.8.0.json
    python agui/prodlike/loadtest/virtual_users.py --compare report-0.8.0.json report-0.9.0.json

Exit code: 0 clean, 3 duplicated work found, 1 the test itself failed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

# httpx is imported where it is used, so --compare runs on a stock python3.
if TYPE_CHECKING:
    import httpx

TEXT_QUESTIONS = [
    "hello",
    "what can you do?",
    "thanks, that's all for now",
    "who is on call this week?",
    "ok, thanks",
    "can you explain the escalation policy?",
]
STATUS_QUESTIONS = [
    "how is checkout-api?",
    "what's the status of payments?",
    "is search healthy?",
    "how is auth doing?",
]
OUTAGE_REPORTS = [
    "checkout-api is down, open an incident",
    "auth outage in eu-west, open an incident",
    "payments is broken, please open an incident",
]

SYNTHETIC_TOOL_RESULT = json.dumps(
    {"status": "error", "reason": "missing_terminal_event", "message": "terminated"},
    separators=(",", ":"),
)


@dataclass
class RunRecord:
    user: int
    kind: str  # say | resync | retry
    served_by: str
    answered: bool  # the run produced assistant text or a tool call
    error: str | None
    seconds: float


@dataclass
class VirtualUser:
    index: int
    lb: str
    turns: int
    rng: random.Random
    thread: str = field(default_factory=lambda: "vu-" + uuid.uuid4().hex[:12])
    messages: list[dict[str, Any]] = field(default_factory=list)
    state: dict[str, Any] = field(default_factory=dict)
    runs: list[RunRecord] = field(default_factory=list)

    async def run_once(self, http: httpx.AsyncClient, kind: str) -> bool:
        """One AG-UI run. Returns False when the stream broke."""
        import httpx
        body = {
            "threadId": self.thread,
            "runId": str(uuid.uuid4()),
            "protocolVersion": "1.0",
            "state": self.state,
            "messages": self.messages,
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
        started = time.monotonic()
        served, answered, error = "?", False, None
        current_text: dict[str, Any] | None = None
        tool_msgs: dict[str, dict[str, Any]] = {}
        finished = False
        try:
            async with http.stream(
                "POST", f"{self.lb}/agui", json=body, headers={"Accept": "text/event-stream"}
            ) as resp:
                served = resp.headers.get("x-served-by", "?")
                if resp.status_code != 200:
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request, response=resp
                    )
                buf = ""
                async for chunk in resp.aiter_text():
                    buf += chunk.replace("\r\n", "\n")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        data = "\n".join(
                            line[5:].lstrip() for line in block.split("\n") if line.startswith("data:")
                        )
                        if not data:
                            continue
                        ev = json.loads(data)
                        t = ev.get("type")
                        if t == "TEXT_MESSAGE_START":
                            answered = True
                            current_text = {"id": ev["messageId"], "role": "assistant", "content": ""}
                            self.messages.append(current_text)
                        elif t == "TEXT_MESSAGE_CONTENT" and current_text is not None:
                            current_text["content"] += ev.get("delta", "")
                        elif t == "TOOL_CALL_START":
                            answered = True
                            call_id = ev["toolCallId"]
                            msg = {
                                "id": ev.get("parentMessageId") or call_id,
                                "role": "assistant",
                                "toolCalls": [
                                    {"id": call_id, "type": "function",
                                     "function": {"name": ev["toolCallName"], "arguments": ""}}
                                ],
                            }
                            tool_msgs[call_id] = msg
                            self.messages.append(msg)
                        elif t == "TOOL_CALL_ARGS" and ev.get("toolCallId") in tool_msgs:
                            tool_msgs[ev["toolCallId"]]["toolCalls"][0]["function"]["arguments"] += ev.get("delta", "")
                        elif t == "TOOL_CALL_RESULT":
                            self.messages.append(
                                {"id": ev["messageId"], "role": "tool",
                                 "toolCallId": ev["toolCallId"], "content": ev.get("content", "")}
                            )
                        elif t == "STATE_SNAPSHOT":
                            self.state = {**ev.get("snapshot", {}), "environment": self.state.get("environment", "production")}
                        elif t == "RUN_ERROR":
                            error = "RUN_ERROR " + str(ev.get("message"))[:80]
                        elif t == "RUN_FINISHED":
                            finished = True
            if not finished and error is None:
                error = "stream ended without RUN_FINISHED"
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            error = f"{type(e).__name__}: {e}"[:120]
        if error:
            # What CopilotKit leaves in its history after a broken run: every
            # tool call without a result gets a synthetic error result.
            answered_ids = {m.get("toolCallId") for m in self.messages if m.get("role") == "tool"}
            for call_id in tool_msgs:
                if call_id not in answered_ids:
                    self.messages.append(
                        {"id": f"{call_id}-result", "role": "tool",
                         "toolCallId": call_id, "content": SYNTHETIC_TOOL_RESULT}
                    )
        self.runs.append(RunRecord(self.index, kind, served, answered, error, time.monotonic() - started))
        return error is None

    async def act(self, http: httpx.AsyncClient, kind: str) -> None:
        ok = await self.run_once(http, kind)
        if not ok:
            await asyncio.sleep(self.rng.uniform(0.5, 1.5))
            await self.run_once(http, "retry")

    def pick(self, pool: list[str]) -> str:
        """A question this user has not asked yet: the audit counts any text
        stored twice in a thread as duplicated work, so a user never repeats
        one on purpose."""
        asked = {m["content"] for m in self.messages if m.get("role") == "user"}
        fresh = [q for q in pool if q not in asked]
        if fresh:
            return self.rng.choice(fresh)
        n = 2
        while (q := f"{self.rng.choice(pool)} (again, #{n})") in asked:
            n += 1
        return q

    async def session(self, http: httpx.AsyncClient, think: float) -> None:
        self.state = {"environment": "production"}
        for _ in range(self.turns):
            roll = self.rng.random()
            pool = TEXT_QUESTIONS if roll < 0.45 else STATUS_QUESTIONS if roll < 0.8 else OUTAGE_REPORTS
            text = self.pick(pool)
            self.messages.append({"id": str(uuid.uuid4()), "role": "user", "content": text})
            await self.act(http, "say")
            await asyncio.sleep(self.rng.uniform(0.2, 1.0) * think)
            if self.rng.random() < 0.4:
                # The engineer flips the environment selector; the page shares
                # it with the agent and re-runs it: the whole history, nothing new.
                env = "staging" if self.state.get("environment") == "production" else "production"
                self.state = {**self.state, "environment": env}
                await self.act(http, "resync")
                await asyncio.sleep(self.rng.uniform(0.2, 1.0) * think)


def lost_turns(messages: list[dict[str, Any]]) -> int:
    """User messages the client never saw any reply to (text or tool call)."""
    lost = 0
    for i, m in enumerate(messages):
        if m.get("role") != "user":
            continue
        nxt = messages[i + 1] if i + 1 < len(messages) else None
        if nxt is None or nxt.get("role") == "user":
            lost += 1
    return lost


async def audit(http: httpx.AsyncClient, lb: str, vu: VirtualUser) -> dict[str, Any]:
    import httpx
    for attempt in range(5):
        try:
            th = (await http.get(f"{lb}/debug/threads/{vu.thread}")).json()
            inc = (await http.get(f"{lb}/debug/incidents", params={"thread": vu.thread})).json()
            return {"thread": th, "incidents": inc["incidents"]}
        except (httpx.HTTPError, json.JSONDecodeError, KeyError):
            await asyncio.sleep(1 + attempt)
    return {"thread": {"duplicates": [], "user_turns": 0}, "incidents": [], "audit_failed": True}


def summarize(label: str, users: list[VirtualUser], audits: list[dict[str, Any]], seconds: float) -> dict[str, Any]:
    runs = [r for u in users for r in u.runs]
    kinds = Counter(r.kind for r in runs)
    resync_answered = sum(1 for r in runs if r.kind == "resync" and r.answered)
    retries = [r for r in runs if r.kind == "retry"]
    dup_turns = sum(d["times"] - 1 for a in audits for d in a["thread"].get("duplicates", []))
    repeated = sum(1 for a in audits for i in a["incidents"] if i.get("repeat"))
    threads_hit = sum(
        1 for a in audits
        if a["thread"].get("duplicates") or any(i.get("repeat") for i in a["incidents"])
    )
    pods = Counter(r.served_by for r in runs)
    switches = 0
    for u in users:
        for prev, cur in zip(u.runs, u.runs[1:]):
            switches += prev.served_by != cur.served_by
    return {
        "label": label,
        "ag_ui_adk": next((a["thread"].get("ag_ui_adk") for a in audits if a["thread"].get("ag_ui_adk")), "?"),
        "seconds": round(seconds, 1),
        "users": len(users),
        "runs": len(runs),
        "runs_by_kind": dict(kinds),
        "runs_failed": sum(1 for r in runs if r.error),
        "served_by": dict(pods),
        "pod_switches_within_thread": switches,
        "unrequested_answers": resync_answered,
        "retries_answered": sum(1 for r in retries if r.answered),
        "retries_silent": sum(1 for r in retries if not r.answered and not r.error),
        "duplicate_user_turns_stored": dup_turns,
        "repeated_incidents": repeated,
        "conversations_with_duplicated_work": threads_hit,
        "lost_turns": sum(lost_turns(u.messages) for u in users),
        "incidents": sum(len(a["incidents"]) for a in audits),
        "audits_failed": sum(1 for a in audits if a.get("audit_failed")),
    }


ROWS = [
    ("ag-ui-adk", "ag_ui_adk"),
    ("conversations", "users"),
    ("AG-UI runs", "runs"),
    ("  re-runs with nothing new (env switch)", None),
    ("  runs that broke (pod killed) and were retried", "runs_failed"),
    ("    retries the agent answered", "retries_answered"),
    ("    retries that got no answer", "retries_silent"),
    ("runs that changed pod within a conversation", "pod_switches_within_thread"),
    ("answers to re-runs with nothing new", "unrequested_answers"),
    ("user turns stored twice in the shared session", "duplicate_user_turns_stored"),
    ("incidents opened again (on-call paged twice)", "repeated_incidents"),
    ("conversations with duplicated work", "conversations_with_duplicated_work"),
    ("user messages that never got a reply", "lost_turns"),
    ("incidents opened", "incidents"),
]


def print_report(*reports: dict[str, Any]) -> None:
    width = max(len(r[0]) for r in ROWS) + 2
    head = "".join(f"{r['label']:>12}" for r in reports)
    print(f"\n{'':{width}}{head}")
    print("-" * (width + 12 * len(reports)))
    for name, key in ROWS:
        vals = []
        for r in reports:
            if key is None:
                vals.append(r["runs_by_kind"].get("resync", 0))
            else:
                vals.append(r.get(key, "?"))
        print(f"{name:{width}}" + "".join(f"{str(v):>12}" for v in vals))
    for r in reports:
        print(f"\n{r['label']}: runs per replica {json.dumps(r['served_by'])}, {r['seconds']}s")


async def main_async(args: argparse.Namespace) -> int:
    import httpx
    rng = random.Random(args.seed)
    users = [VirtualUser(i, args.lb.rstrip("/"), args.turns, random.Random(rng.random())) for i in range(args.users)]
    limits = httpx.Limits(max_connections=args.users * 2, max_keepalive_connections=0)
    started = time.monotonic()
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0), limits=limits) as http:
        async def staggered(u: VirtualUser) -> None:
            await asyncio.sleep(rng.uniform(0, args.ramp))
            await u.session(http, args.think)

        await asyncio.gather(*(staggered(u) for u in users))
        elapsed = time.monotonic() - started
        await asyncio.sleep(1.0)
        audits = await asyncio.gather(*(audit(http, args.lb.rstrip("/"), u) for u in users))
    report = summarize(args.label, users, list(audits), elapsed)
    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2)
    print_report(report)
    if args.print_json:
        print("REPORT_JSON " + json.dumps(report), flush=True)
    bad = report["duplicate_user_turns_stored"] or report["repeated_incidents"]
    return 3 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lb", default=os.environ.get("ADK_URL", "http://127.0.0.1:8300"),
                    help="the load balancer in front of the ADK replicas")
    ap.add_argument("--users", type=int, default=40)
    ap.add_argument("--turns", type=int, default=6, help="messages each user sends")
    ap.add_argument("--think", type=float, default=1.0, help="scale of the pause between actions")
    ap.add_argument("--ramp", type=float, default=5.0, help="seconds over which users arrive")
    ap.add_argument("--seed", type=int, default=2603)
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", help="write the report as JSON")
    ap.add_argument("--print-json", action="store_true",
                    help="also print the report as one REPORT_JSON line (for kubectl logs)")
    ap.add_argument("--compare", nargs="+", metavar="REPORT", help="print saved reports side by side")
    args = ap.parse_args()
    if args.compare:
        print_report(*(json.load(open(p)) for p in args.compare))
        return 0
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 1


if __name__ == "__main__":
    sys.exit(main())
