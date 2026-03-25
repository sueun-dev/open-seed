"""
Open Seed v2 — Cron scheduler for recurring tasks.

Pattern from: OpenClaw cron/service.ts
Simple JSON-file-based job store with heartbeat tracking.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path

from openseed_core.config import CronConfig
from openseed_deploy.types import CronJob


class CronStore:
    """Persistent cron job store (JSON file)."""

    def __init__(self, config: CronConfig | None = None) -> None:
        self.config = config or CronConfig()
        self._store_path = Path(self.config.store_path).expanduser()

    def _load(self) -> list[CronJob]:
        if not self._store_path.exists():
            return []
        try:
            data = json.loads(self._store_path.read_text())
            return [CronJob(**j) for j in data]
        except (json.JSONDecodeError, TypeError):
            return []

    def _save(self, jobs: list[CronJob]) -> None:
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        data = []
        for j in jobs:
            d = {
                "id": j.id, "name": j.name, "schedule": j.schedule,
                "task": j.task, "enabled": j.enabled,
                "last_status": j.last_status,
                "created_at": j.created_at.isoformat() if j.created_at else None,
                "last_run": j.last_run.isoformat() if j.last_run else None,
            }
            data.append(d)
        self._store_path.write_text(json.dumps(data, indent=2))

    def list_jobs(self) -> list[CronJob]:
        return self._load()

    def add_job(self, name: str, schedule: str, task: str) -> CronJob:
        jobs = self._load()
        job = CronJob(id=str(uuid.uuid4())[:8], name=name, schedule=schedule, task=task)
        jobs.append(job)
        self._save(jobs)
        return job

    def remove_job(self, job_id: str) -> bool:
        jobs = self._load()
        before = len(jobs)
        jobs = [j for j in jobs if j.id != job_id]
        self._save(jobs)
        return len(jobs) < before

    def update_job_status(self, job_id: str, status: str) -> None:
        jobs = self._load()
        for j in jobs:
            if j.id == job_id:
                j.last_status = status
                j.last_run = datetime.now()
        self._save(jobs)
