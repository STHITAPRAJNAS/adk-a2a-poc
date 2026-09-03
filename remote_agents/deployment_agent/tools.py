"""Tools for the release-operations agent.

Three shapes of tool live here on purpose, because each one produces a
different A2A task state on the wire:

===========================  ==========================  =========================
Tool                         ADK shape                   A2A effect
===========================  ==========================  =========================
``check_release_readiness``  plain ``FunctionTool``      task stays ``WORKING``
``run_compliance_scan``      plain async FunctionTool    task stays ``WORKING`` for
                                                         the duration of the await
``request_change_approval``  ``LongRunningFunctionTool`` task ends ``INPUT_REQUIRED``
``start_deployment``         ``LongRunningFunctionTool`` task ends ``INPUT_REQUIRED``
===========================  ==========================  =========================

ADK maps *any* unresolved long-running function call onto
``TASK_STATE_INPUT_REQUIRED`` and attaches the function call itself as an A2A
DataPart flagged ``adk_is_long_running: true``. Whoever is driving the task —
a human for the approval gate, a poller for the deployment job — resumes it by
sending a matching function *response* back on the same task id.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from google.adk.tools import LongRunningFunctionTool, ToolContext

from common.approvals import APPROVALS
from common.config import get_settings
from common.jobs import JOBS

logger = logging.getLogger(__name__)

_KNOWN_SERVICES: dict[str, dict[str, Any]] = {
    "checkout-api": {"owner": "payments", "tier": "tier-1", "open_incidents": 0},
    "search-indexer": {"owner": "discovery", "tier": "tier-2", "open_incidents": 1},
    "billing-worker": {"owner": "payments", "tier": "tier-1", "open_incidents": 0},
}


def check_release_readiness(service: str, version: str, environment: str) -> dict[str, Any]:
    """Checks whether a service version is safe to release into an environment.

    This is an ordinary fast tool. It resolves inside a single agent turn, so
    from the A2A caller's point of view the task simply stays in the WORKING
    state while it runs.

    Args:
      service: Service name, e.g. 'checkout-api'.
      version: Version or tag to release, e.g. '2.14.0'.
      environment: Target environment, one of 'staging' or 'production'.

    Returns:
      A dict with 'ready' (bool), 'service', 'version', 'environment',
      'blockers' (list of strings), 'risk' ('low'|'medium'|'high') and
      'requires_human_approval' (bool).
    """
    meta = _KNOWN_SERVICES.get(service)
    blockers: list[str] = []
    if meta is None:
        blockers.append(f"unknown service {service!r}; not in the service catalogue")
    elif meta["open_incidents"]:
        blockers.append(f"{meta['open_incidents']} open incident(s) against {service}")

    if environment not in ("staging", "production"):
        blockers.append(f"unknown environment {environment!r}")

    tier = (meta or {}).get("tier", "unknown")
    risk = "high" if environment == "production" and tier == "tier-1" else "medium"
    if environment == "staging":
        risk = "low"

    return {
        "ready": not blockers,
        "service": service,
        "version": version,
        "environment": environment,
        "owning_team": (meta or {}).get("owner", "unknown"),
        "tier": tier,
        "blockers": blockers,
        "risk": risk,
        # Anything reaching production needs a human on the change ticket.
        "requires_human_approval": environment == "production",
    }


async def run_compliance_scan(service: str, environment: str) -> dict[str, Any]:
    """Runs the pre-release compliance scan and waits for it to finish.

    This tool deliberately blocks for a configurable number of seconds
    (COMPLIANCE_SCAN_SECONDS). It is the 'slow but synchronous' case: the A2A
    task remains in the WORKING state for the whole duration and the caller
    keeps its stream open, as opposed to the long-running tools below which
    hand control back to the caller.

    Args:
      service: Service name being scanned.
      environment: Environment the release targets.

    Returns:
      A dict with 'passed' (bool), 'findings' (list of strings), 'duration_seconds'
      and 'scanned_service'.
    """
    seconds = get_settings().compliance_scan_seconds
    logger.info("Compliance scan for %s/%s: sleeping %ss", service, environment, seconds)
    await asyncio.sleep(seconds)
    return {
        "passed": True,
        "scanned_service": service,
        "environment": environment,
        "duration_seconds": seconds,
        "findings": [],
        "controls_checked": ["SOC2-CC7.2", "SOC2-CC8.1", "PCI-6.4.2"],
    }


def request_change_approval(
    service: str,
    version: str,
    environment: str,
    summary: str,
    risk: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Opens a change-approval ticket and pauses until a human decides.

    Call this before any production release. The call returns immediately with a
    'pending' status and a ticket id; it does NOT mean the change was approved.
    Do not call it again for the same change while a ticket is pending.

    Args:
      service: Service name being released.
      version: Version or tag being released.
      environment: Target environment.
      summary: One-line plain-English summary of the change for the approver.
      risk: Assessed risk, one of 'low', 'medium' or 'high'.

    Returns:
      A dict with 'status' ('pending_human_approval'), 'ticket_id',
      'awaiting' describing the shape of the expected decision, and the echoed
      change details.
    """
    ticket = APPROVALS.open(
        service=service,
        version=version,
        environment=environment,
        summary=summary,
        risk=risk,
    )
    # Stash the ticket on session state so the agent (and the Dev UI state tab)
    # can see which gate the conversation is parked on.
    tool_context.state["pending_approval_ticket"] = ticket.id
    logger.info("Opened approval ticket %s for %s@%s", ticket.id, service, version)
    return {
        "status": "pending_human_approval",
        "ticket_id": ticket.id,
        "service": service,
        "version": version,
        "environment": environment,
        "risk": risk,
        "summary": summary,
        "awaiting": {
            "approved": "bool - true to proceed with the release, false to abort",
            "decided_by": "str - who made the call",
            "note": "str - optional rationale",
        },
    }


def start_deployment(
    service: str,
    version: str,
    environment: str,
    approval_ticket: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """Starts the deployment pipeline and returns immediately with a job handle.

    Only call this after request_change_approval has come back approved. The
    pipeline outlives this agent turn: the returned job id is polled out of
    band, and the final outcome is delivered back as the response to this call.

    Args:
      service: Service name being deployed.
      version: Version or tag being deployed.
      environment: Target environment.
      approval_ticket: The ticket id returned by request_change_approval.

    Returns:
      A dict with 'status' ('running'), 'job_id', 'poll_url' and the echoed
      deployment details.
    """
    settings = get_settings()
    job = JOBS.start_deployment(
        params={
            "service": service,
            "version": version,
            "environment": environment,
            "approval_ticket": approval_ticket,
        },
        duration_seconds=settings.deployment_job_seconds,
    )
    tool_context.state["deployment_job_id"] = job.id
    logger.info("Started deployment job %s for %s@%s", job.id, service, version)
    return {
        "status": "running",
        "job_id": job.id,
        "service": service,
        "version": version,
        "environment": environment,
        "approval_ticket": approval_ticket,
        "estimated_seconds": settings.deployment_job_seconds,
        "poll_url": f"{settings.remote_agent_base_url}/ops/jobs/{job.id}",
        "awaiting": "the terminal job result, delivered as the response to this call",
    }


#: HITL gate — resolved by a human decision arriving as a function response.
request_change_approval_tool = LongRunningFunctionTool(func=request_change_approval)

#: Long-running work — resolved by a poller once the background job finishes.
start_deployment_tool = LongRunningFunctionTool(func=start_deployment)

#: Names the demo client and the tests match on when they see a pending
#: long-running function call come back over A2A.
HITL_TOOL_NAME = request_change_approval_tool.name
LONG_RUNNING_JOB_TOOL_NAME = start_deployment_tool.name

ALL_TOOLS = [
    check_release_readiness,
    run_compliance_scan,
    request_change_approval_tool,
    start_deployment_tool,
]
