"""
Open Seed v2 — Abstract deploy channel.

All deploy channels implement this interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openseed_deploy.types import ChannelResult


class DeployChannel(ABC):
    """Abstract base for deployment channels."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Channel identifier (e.g., 'git', 'npm', 'docker')."""

    @abstractmethod
    async def deploy(self, working_dir: str, message: str = "") -> ChannelResult:
        """Execute deployment. Returns result."""

    @abstractmethod
    async def check(self) -> bool:
        """Check if this channel is available/configured."""
