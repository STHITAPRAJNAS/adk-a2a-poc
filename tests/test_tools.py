"""Unit tests for the release-operations agent's tools."""

from __future__ import annotations

import asyncio

import pytest

from common.approvals import ApprovalRegistry
from common.jobs import JobRegistry
from remote_agents.deployment_agent import tools


class TestReleaseReadiness:
    def test_clean_production_release_needs_human_approval(self):
        result = tools.check_release_readiness("checkout-api", "2.14.0", "production")
        assert result["ready"] is True
        assert result["blockers"] == []
        assert result["requires_human_approval"] is True
        assert result["risk"] == "high"
        assert result["owning_team"] == "payments"

    def test_staging_release_is_low_risk_and_needs_no_approval(self):
        result = tools.check_release_readiness("checkout-api", "2.14.0", "staging")
        assert result["requires_human_approval"] is False
        assert result["risk"] == "low"

    def test_open_incident_blocks_the_release(self):
        result = tools.check_release_readiness("search-indexer", "0.9.1", "production")
        assert result["ready"] is False
        assert any("open incident" in blocker for blocker in result["blockers"])

    def test_unknown_service_blocks_the_release(self):
        result = tools.check_release_readiness("not-a-service", "1.0.0", "production")
        assert result["ready"] is False
        assert any("unknown service" in blocker for blocker in result["blockers"])

    def test_unknown_environment_blocks_the_release(self):
        result = tools.check_release_readiness("checkout-api", "2.14.0", "moon-base")
        assert result["ready"] is False
        assert any("unknown environment" in blocker for blocker in result["blockers"])


class TestLongRunningToolWiring:
    """The A2A behaviour under test hangs entirely off these two flags."""

    def test_hitl_and_job_tools_are_long_running(self):
        assert tools.request_change_approval_tool.is_long_running is True
        assert tools.start_deployment_tool.is_long_running is True

    def test_tool_names_are_the_public_function_names(self):
        assert tools.HITL_TOOL_NAME == "request_change_approval"
        assert tools.LONG_RUNNING_JOB_TOOL_NAME == "start_deployment"

    def test_every_tool_is_registered_under_its_public_name(self):
        # Plain callables are wrapped by ADK at agent-construction time and take
        # their name from the function; the two long-running tools are already
        # FunctionTool instances and carry a .name.
        registered = {
            getattr(tool, "name", None) or tool.__name__ for tool in tools.ALL_TOOLS
        }
        assert registered == {
            "check_release_readiness",
            "run_compliance_scan",
            "request_change_approval",
            "start_deployment",
        }


class TestApprovalRegistry:
    def test_open_ticket_starts_pending(self):
        registry = ApprovalRegistry()
        ticket = registry.open(
            service="checkout-api",
            version="2.14.0",
            environment="production",
            summary="release",
            risk="high",
        )
        assert ticket.state == "pending"
        assert ticket.id.startswith("CHG-")
        assert registry.get(ticket.id) is ticket

    def test_decision_is_recorded(self):
        registry = ApprovalRegistry()
        ticket = registry.open(
            service="s", version="1", environment="production", summary="x", risk="low"
        )
        updated = registry.record_decision(ticket.id, approved=False, decided_by="ops", note="no")
        assert updated is not None
        assert updated.state == "rejected"
        assert updated.decided_by == "ops"

    def test_decision_on_unknown_ticket_returns_none(self):
        assert ApprovalRegistry().record_decision("CHG-NOPE", approved=True) is None


class TestJobRegistry:
    @pytest.mark.asyncio
    async def test_job_runs_through_every_stage_and_succeeds(self):
        registry = JobRegistry()
        job = registry.start_deployment(
            params={"service": "checkout-api", "version": "2.14.0", "environment": "production"},
            duration_seconds=1,
        )
        assert job.state in ("queued", "running")

        for _ in range(200):
            if job.is_terminal:
                break
            await asyncio.sleep(0.05)

        assert job.state == "succeeded"
        assert job.progress == 100
        assert job.result is not None
        assert job.result["status"] == "succeeded"
        assert len(job.log) == 6
        await registry.aclose()

    @pytest.mark.asyncio
    async def test_cancelling_a_job_marks_it_failed(self):
        registry = JobRegistry()
        job = registry.start_deployment(params={"service": "s"}, duration_seconds=30)
        await asyncio.sleep(0.1)
        assert await registry.cancel(job.id) is True
        assert job.state == "failed"
        assert job.error == "cancelled"

    def test_job_started_without_a_loop_stays_queued(self):
        """Tool functions are sometimes called outside a loop; that must not crash."""
        registry = JobRegistry()
        job = registry.start_deployment(params={}, duration_seconds=1)
        assert job.state == "queued"
