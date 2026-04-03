"""
Open Seed v2 — Memory store.

Uses the backend factory to select the best available store:
    qdrant (mem0)  →  pgvector  →  sqlite  (always works, zero-config).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from openseed_core.config import MemoryConfig

logger = logging.getLogger(__name__)
from openseed_core.events import EventBus, EventType

from openseed_memory.types import MemoryEntry, MemoryEvent, MemoryType, SearchResult

if TYPE_CHECKING:
    from openseed_memory.backends.base import MemoryBackend


class MemoryStore:
    def __init__(self, config: MemoryConfig | None = None, event_bus: EventBus | None = None) -> None:
        self.config = config or MemoryConfig()
        self.event_bus = event_bus
        self._backend: MemoryBackend | None = None
        self._backend_type: str = ""
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return

        try:
            from openseed_memory.backends.factory import create_backend

            self._backend = create_backend(self.config)
            self._backend_type = type(self._backend).__name__
        except Exception as exc:
            logger.debug("Memory backend unavailable — all operations will be no-ops: %s", exc)

        self._initialized = True

    async def add(
        self,
        content: str,
        user_id: str = "default",
        agent_id: str = "",
        memory_type: MemoryType = MemoryType.SEMANTIC,
        metadata: dict[str, Any] | None = None,
        infer: bool = True,
    ) -> str | None:
        """
        Store content in memory.

        Args:
            content: Raw text to store.
            user_id: User namespace.
            agent_id: Optional agent namespace.
            memory_type: Semantic / episodic / procedural hint (used in raw mode).
            metadata: Extra metadata dict.
            infer: When True, run LLM fact extraction to decompose content into
                   discrete facts and apply ADD / UPDATE / DELETE decisions.
                   When False, store raw content directly (legacy behaviour).

        Returns:
            Primary memory_id of the added entry (or None on failure).
        """
        if not self._backend:
            return None

        if infer:
            primary_id = await self._add_with_inference(content, user_id, agent_id, metadata)
            if primary_id is not None:
                return primary_id
            # Fallback to raw if inference fails

        return await self._add_raw(content, user_id, agent_id, memory_type, metadata)

    async def _add_raw(
        self, content: str, user_id: str, agent_id: str, memory_type: MemoryType, metadata: dict[str, Any] | None
    ) -> str | None:
        """Store content directly without LLM processing."""
        assert self._backend is not None
        extra = dict(metadata or {})
        extra["memory_type"] = memory_type.value

        mem_id = self._backend.add(
            content=content,
            user_id=user_id,
            agent_id=agent_id,
            memory_type=memory_type.value,
            metadata=extra,
        )

        if self.event_bus:
            await self.event_bus.emit_simple(
                EventType.MEMORY_STORE, node="memory", content=content[:200], memory_type=memory_type.value
            )
        return mem_id or None

    async def _add_with_inference(
        self, content: str, user_id: str, agent_id: str, metadata: dict[str, Any] | None
    ) -> str | None:
        """Run LLM fact extraction and apply decisions. Returns primary id or None."""
        try:
            from openseed_memory.fact_extractor import FactExtractor

            extractor = FactExtractor()
            decisions = await extractor.extract(content=content, store=self, user_id=user_id)
        except Exception as exc:
            logger.debug("Fact extraction failed, falling back to raw store: %s", exc)
            return None

        if not decisions:
            return None

        primary_id: str | None = None

        for decision in decisions:
            if decision.action == MemoryEvent.NONE:
                continue

            extra = dict(metadata or {})
            extra.update(decision.metadata)
            extra["memory_type"] = decision.memory_type
            if decision.reasoning:
                extra["reasoning"] = decision.reasoning

            if decision.action == MemoryEvent.ADD and decision.content:
                mem_type = (
                    MemoryType(decision.memory_type)
                    if decision.memory_type in MemoryType._value2member_map_
                    else MemoryType.SEMANTIC
                )
                mem_id = await self._add_raw(decision.content, user_id, agent_id, mem_type, extra)
                if primary_id is None:
                    primary_id = mem_id

            elif decision.action == MemoryEvent.UPDATE and decision.memory_id and decision.content:
                await self._update(decision.memory_id, decision.content, extra)
                if primary_id is None:
                    primary_id = decision.memory_id

            elif decision.action == MemoryEvent.DELETE and decision.memory_id:
                await self.delete(decision.memory_id)

        return primary_id

    async def _update(self, memory_id: str, content: str, metadata: dict[str, Any] | None = None) -> bool:
        """Update an existing memory entry."""
        if not self._backend:
            return False
        return self._backend.update(memory_id, content, metadata)

    async def search(
        self,
        query: str,
        user_id: str = "default",
        limit: int = 10,
        rerank: bool = True,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchResult]:
        if not self._backend:
            return []

        items = self._backend.search(query=query, user_id=user_id, limit=limit, filters=filters)

        if self.event_bus:
            await self.event_bus.emit_simple(
                EventType.MEMORY_RECALL, node="memory", query=query[:200], results_count=len(items)
            )

        search_results = [
            SearchResult(
                entry=MemoryEntry(
                    id=r.get("id", ""),
                    content=r.get("memory", r.get("data", r.get("content", ""))),
                    metadata=r.get("metadata", {}),
                ),
                score=r.get("score", 0.0),
            )
            for r in items
        ]

        # LLM reranking when there are enough results to benefit from it
        if rerank and len(search_results) > 3:
            try:
                from openseed_memory.reranker import Reranker

                reranker = Reranker()
                search_results = await reranker.rerank(query=query, results=search_results)
            except Exception as exc:
                logger.debug("Reranking failed, keeping original order: %s", exc)

        return search_results

    async def delete(self, memory_id: str) -> bool:
        if not self._backend:
            return False
        return self._backend.delete(memory_id)

    async def get_all(
        self,
        user_id: str = "default",
        limit: int = 100,
        filters: dict[str, Any] | None = None,
    ) -> list[MemoryEntry]:
        if not self._backend:
            return []
        items = self._backend.get_all(user_id=user_id, limit=limit, filters=filters)
        return [
            MemoryEntry(
                id=r.get("id", ""),
                content=r.get("memory", r.get("content", "")),
                metadata=r.get("metadata", {}),
            )
            for r in items
        ]

    async def history(self, memory_id: str) -> list[dict[str, Any]]:
        if not self._backend:
            return []
        return self._backend.history(memory_id)
