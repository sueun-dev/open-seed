"""
Open Seed v2 — Memory store.

Tries mem0 (Qdrant) first. Falls back to SQLite automatically.
Zero-config: works out of the box without Qdrant running.
"""

from __future__ import annotations

from typing import Any

from openseed_core.config import MemoryConfig
from openseed_core.events import EventBus, EventType
from openseed_memory.types import MemoryEntry, SearchResult, MemoryType


class MemoryStore:
    def __init__(self, config: MemoryConfig | None = None, event_bus: EventBus | None = None) -> None:
        self.config = config or MemoryConfig()
        self.event_bus = event_bus
        self._backend: Any = None
        self._backend_type: str = ""
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return

        # Try mem0 + Qdrant first
        if self.config.backend == "qdrant":
            try:
                from mem0 import Memory
                mem0_config = {
                    "embedder": {"provider": "openai", "config": {"model": self.config.embedding_model}},
                    "vector_store": {"provider": "qdrant", "config": {
                        "url": self.config.qdrant_url,
                        "collection_name": self.config.qdrant_collection,
                        "embedding_model_dims": self.config.embedding_dims,
                    }},
                }
                self._backend = Memory.from_config(config_dict=mem0_config)
                self._backend_type = "mem0"
                self._initialized = True
                return
            except Exception:
                pass  # Fall through to SQLite

        # Fallback: SQLite (always works, no deps)
        try:
            from openseed_memory.backends.sqlite import SQLiteMemoryBackend
            sqlite_path = str(self.config.sqlite_path)
            self._backend = SQLiteMemoryBackend(db_path=sqlite_path)
            self._backend.initialize()
            self._backend_type = "sqlite"
            self._initialized = True
        except Exception:
            self._initialized = True  # Mark as initialized but no backend

    async def add(self, content: str, user_id: str = "default", agent_id: str = "",
                  memory_type: MemoryType = MemoryType.SEMANTIC, metadata: dict[str, Any] | None = None) -> str | None:
        if not self._backend:
            return None

        extra = metadata or {}
        extra["memory_type"] = memory_type.value

        if self._backend_type == "mem0":
            result = self._backend.add(messages=[{"role": "user", "content": content}],
                                        user_id=user_id, agent_id=agent_id or None, metadata=extra)
            results = result.get("results", [])
            mem_id = results[0].get("id") if results else None
        else:
            mem_id = self._backend.add(content=content, user_id=user_id, agent_id=agent_id,
                                        memory_type=memory_type.value, metadata=extra)

        if self.event_bus:
            await self.event_bus.emit_simple(EventType.MEMORY_STORE, node="memory",
                                             content=content[:200], memory_type=memory_type.value)
        return mem_id

    async def search(self, query: str, user_id: str = "default", limit: int = 10) -> list[SearchResult]:
        if not self._backend:
            return []

        if self._backend_type == "mem0":
            results = self._backend.search(query=query, user_id=user_id, limit=limit)
            items = results.get("results", [])
        else:
            items = self._backend.search(query=query, user_id=user_id, limit=limit)

        if self.event_bus:
            await self.event_bus.emit_simple(EventType.MEMORY_RECALL, node="memory",
                                             query=query[:200], results_count=len(items))

        return [
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

    async def delete(self, memory_id: str) -> bool:
        if not self._backend:
            return False
        if self._backend_type == "mem0":
            self._backend.delete(memory_id)
            return True
        return self._backend.delete(memory_id)

    async def get_all(self, user_id: str = "default", limit: int = 100) -> list[MemoryEntry]:
        if not self._backend:
            return []
        if self._backend_type == "mem0":
            results = self._backend.get_all(user_id=user_id, limit=limit)
            items = results.get("results", [])
        else:
            items = self._backend.get_all(user_id=user_id, limit=limit)
        return [
            MemoryEntry(id=r.get("id", ""), content=r.get("memory", r.get("content", "")),
                        metadata=r.get("metadata", {}))
            for r in items
        ]

    async def history(self, memory_id: str) -> list[dict[str, Any]]:
        if not self._backend:
            return []
        if self._backend_type == "mem0":
            return self._backend.history(memory_id)
        return self._backend.history(memory_id)
