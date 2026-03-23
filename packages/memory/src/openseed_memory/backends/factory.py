"""
Open Seed v2 — Vector store / memory backend factory.

Pattern from: research/mem0/mem0/utils/factory.py (VectorStoreFactory)

Selects the best available backend in priority order:

    qdrant  →  pgvector  →  sqlite  (always succeeds)

Each tier is attempted inside a try/except so a missing dependency or an
unreachable server silently falls through to the next option.
"""

from __future__ import annotations

import logging
from typing import Any

from openseed_core.config import MemoryConfig
from openseed_memory.backends.base import MemoryBackend

logger = logging.getLogger(__name__)


def create_backend(config: MemoryConfig) -> MemoryBackend:
    """Instantiate and initialise the best available backend for *config*.

    Always returns a usable ``MemoryBackend`` — SQLite is the guaranteed
    fallback that requires no external services or optional packages.

    Priority: qdrant  >  pgvector  >  sqlite
    """

    # ── 1. Qdrant via mem0 ────────────────────────────────────────────────
    if config.backend == "qdrant":
        try:
            from mem0 import Memory  # type: ignore[import]

            mem0_config = {
                "embedder": {
                    "provider": "openai",
                    "config": {"model": config.embedding_model},
                },
                "vector_store": {
                    "provider": "qdrant",
                    "config": {
                        "url": config.qdrant_url,
                        "collection_name": config.qdrant_collection,
                        "embedding_model_dims": config.embedding_dims,
                    },
                },
            }
            backend = Memory.from_config(config_dict=mem0_config)
            logger.info("memory backend: qdrant (via mem0)")
            # mem0 Memory is not a MemoryBackend subclass — wrap it so the
            # store can still detect the type via isinstance checks if needed.
            return _Mem0Wrapper(backend)
        except Exception as exc:
            logger.debug("qdrant backend unavailable: %s", exc)

    # ── 2. PostgreSQL + pgvector ──────────────────────────────────────────
    if config.backend in ("qdrant", "pgvector"):
        # Also try pgvector as qdrant fallback when Qdrant is down.
        try:
            from openseed_memory.backends.pgvector import PgVectorMemoryBackend

            backend = PgVectorMemoryBackend(
                connection_url=config.pgvector_url,
                collection=config.pgvector_collection,
                embedding_dims=config.embedding_dims,
                embedding_model=config.embedding_model,
            )
            backend.initialize()
            logger.info("memory backend: pgvector (%s)", config.pgvector_url)
            return backend
        except Exception as exc:
            logger.debug("pgvector backend unavailable: %s", exc)

    # ── 3. SQLite (always available, zero deps) ────────────────────────────
    from openseed_memory.backends.sqlite import SQLiteMemoryBackend

    backend = SQLiteMemoryBackend(db_path=str(config.sqlite_path))
    backend.initialize()
    logger.info("memory backend: sqlite (%s)", config.sqlite_path)
    return backend


# ---------------------------------------------------------------------------
# Thin wrapper so mem0.Memory objects satisfy the MemoryBackend interface
# ---------------------------------------------------------------------------

class _Mem0Wrapper(MemoryBackend):
    """Adapts a ``mem0.Memory`` instance to the ``MemoryBackend`` protocol."""

    def __init__(self, mem0: Any) -> None:  # noqa: F821
        self._m = mem0

    def initialize(self) -> None:
        pass  # mem0 initialises itself in from_config

    def add(self, content: str, user_id: str = "default", agent_id: str = "",
            memory_type: str = "semantic", metadata: dict | None = None) -> str:
        result = self._m.add(
            messages=[{"role": "user", "content": content}],
            user_id=user_id,
            agent_id=agent_id or None,
            metadata={**(metadata or {}), "memory_type": memory_type},
        )
        results = result.get("results", [])
        return results[0].get("id", "") if results else ""

    def search(
        self,
        query: str,
        user_id: str = "default",
        limit: int = 10,
        filters: dict | None = None,
    ) -> list[dict]:
        result = self._m.search(query=query, user_id=user_id, limit=limit)
        items = result.get("results", [])
        if filters:
            from openseed_memory.filters import matches_filter
            items = [r for r in items if matches_filter(r.get("metadata", {}), filters)]
        return items

    def update(self, memory_id: str, content: str, metadata: dict | None = None,
               user_id: str = "default") -> bool:
        self._m.delete(memory_id)
        result = self._m.add(
            messages=[{"role": "user", "content": content}],
            user_id=user_id,
            metadata=metadata or {},
        )
        return bool(result.get("results"))

    def delete(self, memory_id: str) -> bool:
        self._m.delete(memory_id)
        return True

    def get_all(
        self,
        user_id: str = "default",
        limit: int = 100,
        filters: dict | None = None,
    ) -> list[dict]:
        result = self._m.get_all(user_id=user_id, limit=limit)
        items = result.get("results", [])
        if filters:
            from openseed_memory.filters import matches_filter
            items = [r for r in items if matches_filter(r.get("metadata", {}), filters)]
        return items

    def history(self, memory_id: str) -> list[dict]:
        return self._m.history(memory_id)
