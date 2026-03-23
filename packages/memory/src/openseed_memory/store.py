"""
Open Seed v2 — Memory store.

Unified API over mem0 for long-term memory operations.
Pattern from: mem0 Memory class (research/mem0/mem0/memory/main.py)

Operations: add, search, update, delete, history
All fact extraction by LLM — no regex.
"""

from __future__ import annotations

from typing import Any

from openseed_core.config import MemoryConfig
from openseed_core.events import EventBus, EventType
from openseed_memory.types import MemoryEntry, SearchResult, MemoryType


class MemoryStore:
    """
    Long-term memory store wrapping mem0.

    Usage:
        store = MemoryStore(config)
        await store.initialize()
        await store.add("User prefers Python over JavaScript", user_id="user1")
        results = await store.search("What language does the user prefer?", user_id="user1")
    """

    def __init__(
        self,
        config: MemoryConfig | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.config = config or MemoryConfig()
        self.event_bus = event_bus
        self._mem0: Any = None
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the mem0 backend."""
        if self._initialized:
            return

        try:
            from mem0 import Memory

            mem0_config = {
                "embedder": {
                    "provider": "openai",
                    "config": {"model": self.config.embedding_model},
                },
                "vector_store": {
                    "provider": "qdrant",
                    "config": {
                        "url": self.config.qdrant_url,
                        "collection_name": self.config.qdrant_collection,
                        "embedding_model_dims": self.config.embedding_dims,
                    },
                },
            }
            self._mem0 = Memory.from_config(config_dict=mem0_config)
            self._initialized = True
        except ImportError:
            # mem0 not installed — fall back to no-op
            self._initialized = True

    async def add(
        self,
        content: str,
        user_id: str = "default",
        agent_id: str = "",
        memory_type: MemoryType = MemoryType.SEMANTIC,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        """
        Add a memory. LLM extracts facts and decides ADD/UPDATE/DELETE.

        Returns memory ID or None if mem0 not available.
        """
        if not self._mem0:
            return None

        messages = [{"role": "user", "content": content}]
        extra_metadata = metadata or {}
        extra_metadata["memory_type"] = memory_type.value

        result = self._mem0.add(
            messages=messages,
            user_id=user_id,
            agent_id=agent_id or None,
            metadata=extra_metadata,
        )

        if self.event_bus:
            await self.event_bus.emit_simple(
                EventType.MEMORY_STORE,
                node="memory",
                content=content[:200],
                memory_type=memory_type.value,
            )

        results = result.get("results", [])
        return results[0].get("id") if results else None

    async def search(
        self,
        query: str,
        user_id: str = "default",
        limit: int = 10,
    ) -> list[SearchResult]:
        """Semantic search across memories."""
        if not self._mem0:
            return []

        results = self._mem0.search(query=query, user_id=user_id, limit=limit)

        if self.event_bus:
            await self.event_bus.emit_simple(
                EventType.MEMORY_RECALL,
                node="memory",
                query=query[:200],
                results_count=len(results.get("results", [])),
            )

        return [
            SearchResult(
                entry=MemoryEntry(
                    id=r.get("id", ""),
                    content=r.get("memory", r.get("data", "")),
                    metadata=r.get("metadata", {}),
                ),
                score=r.get("score", 0.0),
            )
            for r in results.get("results", [])
        ]

    async def delete(self, memory_id: str) -> bool:
        """Delete a memory by ID."""
        if not self._mem0:
            return False
        try:
            self._mem0.delete(memory_id)
            return True
        except Exception:
            return False

    async def get_all(self, user_id: str = "default", limit: int = 100) -> list[MemoryEntry]:
        """Get all memories for a user."""
        if not self._mem0:
            return []

        results = self._mem0.get_all(user_id=user_id, limit=limit)
        return [
            MemoryEntry(
                id=r.get("id", ""),
                content=r.get("memory", r.get("data", "")),
                metadata=r.get("metadata", {}),
            )
            for r in results.get("results", [])
        ]

    async def history(self, memory_id: str) -> list[dict[str, Any]]:
        """Get change history for a memory."""
        if not self._mem0:
            return []
        try:
            return self._mem0.history(memory_id)
        except Exception:
            return []
