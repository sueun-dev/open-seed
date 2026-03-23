"""Body types."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class DeployTarget:
    """A deployment target channel."""
    channel: str  # "git", "npm", "docker", "webhook"
    config: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChannelResult:
    """Result from a single deploy channel."""
    channel: str
    success: bool
    message: str = ""
    url: str = ""
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class CronJob:
    """A scheduled recurring task."""
    id: str
    name: str
    schedule: str  # cron expression or "every(5m)"
    task: str  # The prompt/command to run
    enabled: bool = True
    last_run: datetime | None = None
    last_status: str = ""  # "success", "failed", "running"
    created_at: datetime = field(default_factory=datetime.now)
