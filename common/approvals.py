"""Change-approval tickets raised by the human-in-the-loop tool.

The *decision* never travels through this store — it comes back to the agent as
an A2A function response, which is the whole point of the HITL demonstration.
The store exists so the pending gate is inspectable over plain HTTP while the
A2A task sits in ``TASK_STATE_INPUT_REQUIRED``.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ApprovalState = Literal["pending", "approved", "rejected", "voided"]


@dataclass
class ApprovalTicket:
    id: str
    service: str
    version: str
    environment: str
    summary: str
    risk: str
    state: ApprovalState = "pending"
    decided_by: str | None = None
    decision_note: str | None = None
    #: Who asked for the change, as the verified principal saw it (lab 82):
    #: "alice via ops_concierge". None when the A2A endpoint is unauthenticated.
    requested_by: str | None = None
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ApprovalRegistry:
    def __init__(self) -> None:
        self._tickets: dict[str, ApprovalTicket] = {}

    def open(
        self,
        *,
        service: str,
        version: str,
        environment: str,
        summary: str,
        risk: str,
        requested_by: str | None = None,
    ) -> ApprovalTicket:
        ticket = ApprovalTicket(
            id=f"CHG-{uuid.uuid4().hex[:8].upper()}",
            service=service,
            version=version,
            environment=environment,
            summary=summary,
            risk=risk,
            requested_by=requested_by,
        )
        self._tickets[ticket.id] = ticket
        return ticket

    def record_decision(
        self,
        ticket_id: str,
        *,
        approved: bool,
        decided_by: str | None = None,
        note: str | None = None,
    ) -> ApprovalTicket | None:
        ticket = self._tickets.get(ticket_id)
        if ticket is None:
            return None
        ticket.state = "approved" if approved else "rejected"
        ticket.decided_by = decided_by
        ticket.decision_note = note
        return ticket

    def void(self, ticket_id: str, *, note: str) -> ApprovalTicket | None:
        """Withdraws a pending ticket because the task behind it is gone.

        A decided ticket is history and is left alone. A pending one would
        otherwise sit in an approver's queue asking for a decision nobody is
        waiting for — the human cost of an orphaned task.
        """
        ticket = self._tickets.get(ticket_id)
        if ticket is None or ticket.state != "pending":
            return ticket
        ticket.state = "voided"
        ticket.decision_note = note
        return ticket

    def get(self, ticket_id: str) -> ApprovalTicket | None:
        return self._tickets.get(ticket_id)

    def list(self) -> list[ApprovalTicket]:
        return sorted(self._tickets.values(), key=lambda t: t.created_at, reverse=True)


#: Process-wide registry, read by the remote server's ``/ops/approvals`` routes.
APPROVALS = ApprovalRegistry()
