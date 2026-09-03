"""A tiny in-process registry for work that outlives a single agent turn.

The point of this module in the PoC is to be *honest* about what a long-running
tool actually is: the tool call returns immediately with a handle, the real work
carries on somewhere else, and something outside the agent turn eventually
posts the result back in as a function response.

In production this would be a queue plus a durable store. Here it is a dict and
an ``asyncio.Task``, which is enough to watch the protocol behave.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)

JobState = Literal["queued", "running", "succeeded", "failed"]

#: Ordered stages the simulated deployment walks through.
_STAGES: tuple[str, ...] = (
    "provisioning canary",
    "shifting 10% traffic",
    "running smoke tests",
    "shifting 50% traffic",
    "shifting 100% traffic",
    "retiring previous revision",
)


@dataclass
class Job:
    """A unit of background work started by a long-running tool call."""

    id: str
    kind: str
    params: dict[str, Any]
    state: JobState = "queued"
    progress: int = 0
    stage: str = "queued"
    log: list[str] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["age_seconds"] = round(time.time() - self.created_at, 1)
        return data

    @property
    def is_terminal(self) -> bool:
        return self.state in ("succeeded", "failed")


class JobRegistry:
    """Stores jobs and drives the simulated deployment pipeline."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def start_deployment(self, *, params: dict[str, Any], duration_seconds: int) -> Job:
        """Registers a deployment job and schedules the simulated pipeline.

        Args:
          params: Free-form job parameters echoed back to pollers (service,
            version, environment, approval ticket).
          duration_seconds: Total wall-clock time the simulated pipeline takes.

        Returns:
          The freshly created :class:`Job`, already in ``queued`` state.
        """
        job = Job(id=f"job-{uuid.uuid4().hex[:10]}", kind="deployment", params=dict(params))
        self._jobs[job.id] = job
        # A tool call may run outside a loop in unit tests; only schedule the
        # simulated pipeline when there is a loop to schedule it on.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.debug("No running loop; job %s stays queued for manual driving", job.id)
            return job
        self._tasks[job.id] = loop.create_task(self._run(job, duration_seconds))
        return job

    async def _run(self, job: Job, duration_seconds: int) -> None:
        step = max(duration_seconds, len(_STAGES)) / len(_STAGES)
        job.state = "running"
        try:
            for index, stage in enumerate(_STAGES, start=1):
                await asyncio.sleep(step)
                job.stage = stage
                job.progress = int(index / len(_STAGES) * 100)
                job.log.append(f"[{time.strftime('%H:%M:%S')}] {stage}")
                job.updated_at = time.time()
            job.state = "succeeded"
            job.stage = "complete"
            job.result = {
                "status": "succeeded",
                "job_id": job.id,
                "service": job.params.get("service"),
                "version": job.params.get("version"),
                "environment": job.params.get("environment"),
                "stages_completed": list(_STAGES),
                "rollback_performed": False,
            }
        except asyncio.CancelledError:
            job.state = "failed"
            job.error = "cancelled"
            job.result = {"status": "failed", "job_id": job.id, "error": "cancelled"}
            job.updated_at = time.time()
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("Deployment job %s blew up", job.id)
            job.state = "failed"
            job.error = str(exc)
            job.result = {"status": "failed", "job_id": job.id, "error": str(exc)}
        finally:
            job.updated_at = time.time()

    async def cancel(self, job_id: str) -> bool:
        task = self._tasks.get(job_id)
        if task is None or task.done():
            return False
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return True

    async def aclose(self) -> None:
        """Cancels every in-flight job. Called from the server lifespan."""
        for job_id in list(self._tasks):
            await self.cancel(job_id)
        self._tasks.clear()


#: Process-wide registry. The remote agent's tools write to it and the server's
#: ``/ops/jobs`` routes read from it, which is what lets an external watcher
#: poll a job the agent turn has already returned from.
JOBS = JobRegistry()
