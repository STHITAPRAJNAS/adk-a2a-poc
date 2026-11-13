"""Events (lab 93): what the event bridge reads, and what counts as valid.

Work reaches the release agent here as events on a Redis Stream, not as an
HTTP request someone is waiting on. Each event is a CloudEvents-shaped JSON
document in the stream entry's ``event`` field:

    {"specversion": "1.0", "id": "evt-…", "type": "release.requested",
     "source": "ci/checkout-api", "subject": "checkout-api", "time": "…",
     "data": {"service": "checkout-api", "version": "2.14.0", "environment": "production"}}

    {"specversion": "1.0", "id": "evt-…", "type": "change.approved",
     "source": "approvals-ui", "subject": "CHG-…",
     "data": {"ticket_id": "CHG-…", "approved": true, "decided_by": "alice"}}

Only these two types are accepted, and only the listed fields, each checked
against a pattern. The agent never sees the event itself: the bridge builds
the agent's message from validated fields, so anything else an event carries
(a ``note``, a log line, an instruction) cannot reach the model.

Streams (names overridable with EVENTS_*):

    release-events        incoming work (consumer group "bridge")
    release-results       what happened: awaiting approval, moved on, rejected, dead
    release-events-dead   events the bridge gave up on, with the reason
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any

STREAM = os.environ.get("EVENTS_STREAM", "release-events")
RESULTS = os.environ.get("EVENTS_RESULTS", "release-results")
DEAD = os.environ.get("EVENTS_DEAD", "release-events-dead")
GROUP = os.environ.get("EVENTS_GROUP", "bridge")

RELEASE_REQUESTED = "release.requested"
CHANGE_APPROVED = "change.approved"

_PATTERNS = {
    "service": re.compile(r"^[a-z][a-z0-9-]{1,39}$"),
    "version": re.compile(r"^\d+\.\d+\.\d+$"),
    "environment": re.compile(r"^(dev|staging|production)$"),
    "ticket_id": re.compile(r"^CHG-[0-9A-F]{8}$"),
    "decided_by": re.compile(r"^[a-z][a-z0-9._-]{0,39}$"),
    "id": re.compile(r"^[A-Za-z0-9._-]{1,80}$"),
}


class InvalidEvent(ValueError):
    """Not retryable: the same event will fail the same way every time."""


@dataclass(frozen=True)
class Event:
    id: str
    type: str
    data: dict[str, Any]
    traceparent: str | None = None

    @property
    def context_id(self) -> str:
        """One A2A conversation per event: the key the bridge looks tasks up by."""
        return f"evt-{self.id}"


def _check(name: str, value: Any) -> str:
    if not isinstance(value, str) or not _PATTERNS[name].match(value):
        raise InvalidEvent(f"{name} {value!r:.60} is not valid")
    return value


def parse(raw: str) -> Event:
    try:
        doc = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise InvalidEvent("not JSON") from exc
    if not isinstance(doc, dict):
        raise InvalidEvent("not a JSON object")
    event_id = _check("id", doc.get("id"))
    kind = doc.get("type")
    data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    if kind == RELEASE_REQUESTED:
        clean = {k: _check(k, data.get(k)) for k in ("service", "version", "environment")}
    elif kind == CHANGE_APPROVED:
        clean = {k: _check(k, data.get(k)) for k in ("ticket_id", "decided_by")}
        if not isinstance(data.get("approved"), bool):
            raise InvalidEvent("approved must be true or false")
        clean["approved"] = data["approved"]
    else:
        raise InvalidEvent(f"unknown event type {kind!r:.40}")
    trace = doc.get("traceparent")
    trace = trace if isinstance(trace, str) and re.match(r"^[0-9a-f-]{55}$", trace) else None
    return Event(id=event_id, type=kind, data=clean, traceparent=trace)


def make(
    kind: str, data: dict[str, Any], *, subject: str, source: str, event_id: str | None = None
):
    return {
        "specversion": "1.0",
        "id": event_id or f"evt-{uuid.uuid4().hex[:12]}",
        "type": kind,
        "source": source,
        "subject": subject,
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data": data,
    }


def release_prompt(event: Event) -> str:
    """The only text the agent gets for a release event: built, not copied."""
    d = event.data
    return f"Please deploy {d['service']} {d['version']} to {d['environment']}."
