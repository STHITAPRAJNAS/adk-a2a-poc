"""Drive lab 93's event queue: publish events, read results, inject a crash.

    python scripts/event_probe.py publish   REDIS_URL [--service S --version V --environment E]
                                                      [--id ID] [--note TEXT] [--type T]
    python scripts/event_probe.py approve   REDIS_URL [TICKET|latest] [--reject] [--by NAME]
    python scripts/event_probe.py crash-next REDIS_URL
    python scripts/event_probe.py wait      REDIS_URL TYPE [--count N] [--timeout S]
    python scripts/event_probe.py results   REDIS_URL
    python scripts/event_probe.py dead      REDIS_URL
    python scripts/event_probe.py state     REDIS_URL [--agent BASE_URL]
    python scripts/event_probe.py reset     REDIS_URL

Exit codes: 0 fine, 3 Redis unreachable, 4 timed out waiting,
6 the agent holds more approval tickets than there were release events.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import redis  # noqa: E402

from common import events  # noqa: E402

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def _results(r) -> list[dict]:
    return [json.loads(f["result"]) for _, f in r.xrange(events.RESULTS)]


def cmd_publish(r, a) -> int:
    if a.type == events.RELEASE_REQUESTED:
        data = {"service": a.service, "version": a.version, "environment": a.environment}
        if a.note:
            data["note"] = a.note
        doc = events.make(a.type, data, subject=a.service, source=f"ci/{a.service}", event_id=a.id)
    else:
        doc = events.make(a.type, {"note": a.note or ""}, subject="?", source="lab", event_id=a.id)
    entry = r.xadd(events.STREAM, {"event": json.dumps(doc)})
    print(f"published {doc['id']} ({doc['type']}) as stream entry {entry}")
    return 0


def cmd_approve(r, a) -> int:
    ticket = a.ticket
    if ticket == "latest":
        waiting = [x for x in _results(r) if x["type"] == "release.awaiting_approval"]
        decided = {
            x.get("ticket")
            for x in _results(r)
            if x["type"] in ("release.moved_on", "release.finished")
        }
        open_ = [x["ticket"] for x in waiting if x["ticket"] not in decided]
        if not open_:
            print(_c("31", "✗ no release is waiting for approval"))
            return 4
        ticket = open_[-1]
    doc = events.make(
        events.CHANGE_APPROVED,
        {"ticket_id": ticket, "approved": not a.reject, "decided_by": a.by},
        subject=ticket,
        source="approvals-ui",
    )
    r.xadd(events.STREAM, {"event": json.dumps(doc)})
    print(f"published {doc['id']}: {'reject' if a.reject else 'approve'} {ticket} as {a.by}")
    return 0


def cmd_crash_next(r, a) -> int:
    r.set("bridge:fault:crash-after-send", "1")
    print("the bridge will exit right after its next send, before recording or acknowledging it")
    return 0


def cmd_wait(r, a) -> int:
    deadline = time.time() + a.timeout
    while time.time() < deadline:
        n = sum(1 for x in _results(r) if x["type"] == a.kind)
        if n >= a.count:
            print(f"✓ {n} × {a.kind}")
            return 0
        time.sleep(0.5)
    print(_c("31", f"✗ timed out after {a.timeout:.0f}s waiting for {a.count} × {a.kind}"))
    return 4


def cmd_results(r, a) -> int:
    rows = _results(r)
    print(f"results: {len(rows)}")
    for x in rows:
        rest = {k: v for k, v in x.items() if k not in ("type", "event_id")}
        print(f"  {x['type']:<26} {x.get('event_id', ''):<18} {json.dumps(rest)[:150]}")
    return 0


def cmd_dead(r, a) -> int:
    rows = r.xrange(events.DEAD)
    print(f"dead-lettered: {len(rows)}")
    for entry, f in rows:
        print(f"  {entry}  after {f.get('deliveries')} delivery(ies): {f.get('reason')}")
    return 0


def _agent_tickets(agent: str, since: float) -> list[dict] | None:
    """Approval tickets the agent opened since ``since`` (its /ops surface)."""
    import httpx

    try:
        rows = httpx.get(f"{agent.rstrip('/')}/ops/approvals", timeout=10).json()["tickets"]
    except (httpx.HTTPError, ValueError, KeyError):
        return None
    return [t for t in rows if t.get("created_at", 0) >= since and t.get("state") != "voided"]


def cmd_state(r, a) -> int:
    entries = r.xrange(events.STREAM)
    try:
        group = next(g for g in r.xinfo_groups(events.STREAM) if g["name"] == events.GROUP)
        pending, lag = group.get("pending", 0), group.get("lag")
    except (StopIteration, redis.ResponseError):
        pending, lag = 0, None
    releases = 0
    for _, f in entries:
        try:
            releases += json.loads(f.get("event", "{}")).get("type") == events.RELEASE_REQUESTED
        except ValueError:
            pass
    print(f"events in the stream   {len(entries)} ({releases} release request(s))")
    print(f"read, not yet acked    {pending}")
    print(f"not yet read (lag)     {lag if lag is not None else '?'}")
    print(f"dead-lettered          {r.xlen(events.DEAD)}")
    rows = _results(r)
    recorded = sum(1 for x in rows if x["type"] == "release.awaiting_approval")
    print(f"tickets the bridge saw {recorded}")
    if not a.agent:
        return 0
    # Stream entry ids start with their time in milliseconds.
    since = int(entries[0][0].split("-")[0]) / 1000 - 1 if entries else time.time()
    tickets = _agent_tickets(a.agent, since)
    if tickets is None:
        print(_c("31", f"✗ could not read approval tickets from {a.agent}"))
        return 3
    print(
        f"tickets the agent has  {len(tickets)}  ({', '.join(t['id'] for t in tickets) or 'none'})"
    )
    dead_releases = sum(
        1 for _, f in r.xrange(events.DEAD) if events.RELEASE_REQUESTED in f.get("event", "")
    )
    expected = releases - dead_releases
    if len(tickets) > expected:
        print(
            _c(
                "31",
                f"\n✗ {len(tickets)} APPROVAL TICKETS FOR {expected} RELEASE EVENT(S): "
                "the agent was sent the same event more than once",
            )
        )
        return 6
    if tickets:
        print(_c("32", "\n✓ one approval ticket per release event"))
    return 0


def cmd_reset(r, a) -> int:
    r.delete(
        events.STREAM,
        events.RESULTS,
        events.DEAD,
        "bridge:handled",
        "bridge:fault:crash-after-send",
        *r.keys("bridge:ticket:*"),
    )
    r.xgroup_create(events.STREAM, events.GROUP, id="0", mkstream=True)
    print("streams emptied; consumer group recreated")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("publish")
    s.add_argument("url")
    s.add_argument("--service", default="checkout-api")
    s.add_argument("--version", default="2.14.0")
    s.add_argument("--environment", default="production")
    s.add_argument("--id")
    s.add_argument("--note")
    s.add_argument("--type", default=events.RELEASE_REQUESTED)
    s.set_defaults(fn=cmd_publish)
    s = sub.add_parser("approve")
    s.add_argument("url")
    s.add_argument("ticket", nargs="?", default="latest")
    s.add_argument("--reject", action="store_true")
    s.add_argument("--by", default="alice")
    s.set_defaults(fn=cmd_approve)
    s = sub.add_parser("wait")
    s.add_argument("url")
    s.add_argument("kind")
    s.add_argument("--count", type=int, default=1)
    s.add_argument("--timeout", type=float, default=60)
    s.set_defaults(fn=cmd_wait)
    s = sub.add_parser("state")
    s.add_argument("url")
    s.add_argument("--agent", help="the release agent's base URL, to count its approval tickets")
    s.set_defaults(fn=cmd_state)
    for name, fn in (
        ("crash-next", cmd_crash_next),
        ("results", cmd_results),
        ("dead", cmd_dead),
        ("reset", cmd_reset),
    ):
        s = sub.add_parser(name)
        s.add_argument("url")
        s.set_defaults(fn=fn)
    a = p.parse_args()
    r = redis.Redis.from_url(a.url, decode_responses=True, socket_connect_timeout=5)
    try:
        r.ping()
    except redis.ConnectionError as exc:
        print(_c("31", f"✗ could not reach Redis at {a.url}: {exc}"))
        return 3
    return a.fn(r, a)


if __name__ == "__main__":
    sys.exit(main())
