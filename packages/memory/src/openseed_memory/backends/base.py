"""Abstract base class for memory backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class MemoryBackend(ABC):
    """Common interface every memory backend must implement."""

    @abstractmethod
    def initialize(self) -> None:
        """Set up tables / indexes / connections. Called once before use."""
        ...

    @abstractmethod
    def add(
        self,
        content: str,
        user_id: str = "default",
        agent_id: str = "",
        memory_type: str = "semantic",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Persist content and return the new memory_id."""
        ...

    @abstractmethod
    def search(
        self,
        query: str,
        user_id: str = "default",
        limit: int = 10,
        filters: dict | None = None,
    ) -> list[dict]:
        """Return up to *limit* records relevant to *query* for *user_id*.

        Each dict must contain at least: ``id``, ``memory`` (content), ``score``.

        Args:
            filters: Optional advanced filter dict.  Supports equality, comparison
                operators ($gt, $lte, …) and boolean operators ($and, $or, $not).
                See ``openseed_memory.filters`` for the full syntax.
        """
        ...

    @abstractmethod
    def update(self, memory_id: str, content: str, metadata: dict[str, Any] | None = None) -> bool:
        """Replace the content (and optionally metadata) of an existing entry."""
        ...

    @abstractmethod
    def delete(self, memory_id: str) -> bool:
        """Remove a memory entry. Returns True if the entry was found and deleted."""
        ...

    @abstractmethod
    def get_all(
        self,
        user_id: str = "default",
        limit: int = 100,
        filters: dict | None = None,
    ) -> list[dict]:
        """Return the most-recent *limit* entries for *user_id*.

        Args:
            filters: Optional advanced filter dict (same syntax as ``search``).
        """
        ...

    @abstractmethod
    def history(self, memory_id: str) -> list[dict]:
        """Return the change history for a single memory entry (oldest first)."""
        ...
