"""
Open Seed v2 — Cron scheduler.

Async loop that checks due jobs and triggers pipeline runs.
Pattern from: OpenClaw cron/service.ts
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Callable, Awaitable

from openseed_body.cron import CronStore


def _is_due(schedule: str, last_run: datetime | None) -> bool:
    """Simple schedule check. Supports: every(Nm), every(Nh), cron expressions."""
    now = datetime.now()

    # every(Nm) — every N minutes
    if schedule.startswith("every(") and schedule.endswith("m)"):
        try:
            minutes = int(schedule[6:-2])
            if last_run is None:
                return True
            elapsed = (now - last_run).total_seconds() / 60
            return elapsed >= minutes
        except ValueError:
            return False

    # every(Nh) — every N hours
    if schedule.startswith("every(") and schedule.endswith("h)"):
        try:
            hours = int(schedule[6:-2])
            if last_run is None:
                return True
            elapsed = (now - last_run).total_seconds() / 3600
            return elapsed >= hours
        except ValueError:
            return False

    # TODO: full cron expression parsing (croniter)
    return False


async def run_scheduler(
    store: CronStore,
    on_task: Callable[[str, str], Awaitable[None]],  # (job_id, task) → run pipeline
    check_interval: int = 60,
) -> None:
    """
    Main scheduler loop. Checks for due jobs every interval.

    Args:
        store: CronStore for job persistence
        on_task: Async callback to trigger a pipeline run
        check_interval: Seconds between checks
    """
    while True:
        try:
            jobs = store.list_jobs()
            for job in jobs:
                if not job.enabled:
                    continue
                last = job.last_run
                if isinstance(last, str):
                    try:
                        last = datetime.fromisoformat(last)
                    except (ValueError, TypeError):
                        last = None

                if _is_due(job.schedule, last):
                    store.update_job_status(job.id, "running")
                    try:
                        await on_task(job.id, job.task)
                        store.update_job_status(job.id, "success")
                    except Exception as e:
                        store.update_job_status(job.id, f"failed: {str(e)[:100]}")
        except Exception:
            pass

        await asyncio.sleep(check_interval)
