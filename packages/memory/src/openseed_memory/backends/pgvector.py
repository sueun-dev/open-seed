"""
Open Seed v2 — PostgreSQL + pgvector memory backend.

Pattern from: research/mem0/mem0/vector_stores/pgvector.py

Requires:
    psycopg2-binary  (or psycopg[pool] for psycopg3)
    pgvector Python adapter  (pip install pgvector)

If those packages are absent this module is importable but instantiating
PgVectorMemoryBackend will raise ``ImportError`` at construction time so the
factory can fall through to SQLite gracefully.

Embeddings are generated via OpenAI text-embedding-3-small (OAuth, no API key).
If the OpenAI client is unavailable a deterministic hash-based pseudo-embedding
is used instead — enough to demonstrate the schema; swap in a real embedder as
desired.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime
from typing import Any

from openseed_memory.backends.base import MemoryBackend
from openseed_memory.filters import matches_filter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency guards
# ---------------------------------------------------------------------------

_PSYCOPG_VERSION: int | None = None
_ConnectionPool: Any = None
_Json: Any = None

try:
    from psycopg.types.json import Json as _Json3
    from psycopg_pool import ConnectionPool as _CP3

    _Json = _Json3
    _ConnectionPool = _CP3
    _PSYCOPG_VERSION = 3
    logger.debug("pgvector backend: using psycopg (v3) + psycopg_pool")
except ImportError:
    try:
        from psycopg2.extras import Json as _Json2
        from psycopg2.pool import ThreadedConnectionPool as _CP2

        _Json = _Json2
        _ConnectionPool = _CP2
        _PSYCOPG_VERSION = 2
        logger.debug("pgvector backend: using psycopg2")
    except ImportError:
        pass  # Both unavailable — constructor will raise

try:
    from pgvector.psycopg2 import register_vector as _register_vector_v2
    _HAS_PGVECTOR = True
except ImportError:
    try:
        from pgvector.psycopg import register_vector as _register_vector_v3  # noqa: F401
        _HAS_PGVECTOR = True
    except ImportError:
        _HAS_PGVECTOR = False


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------

def _pseudo_embedding(text: str, dims: int) -> list[float]:
    """Deterministic hash-based pseudo-embedding (dims floats in [-1, 1]).

    Used when no real embedding provider is available.  Not semantically
    meaningful but preserves the correct schema for testing.
    """
    digest = hashlib.sha256(text.encode()).digest()
    # Repeat digest to fill dims floats
    raw: list[float] = []
    for i in range(dims):
        byte_val = digest[i % len(digest)]
        raw.append((byte_val / 127.5) - 1.0)
    # L2-normalise
    norm = sum(v * v for v in raw) ** 0.5 or 1.0
    return [v / norm for v in raw]


def _openai_embedding(text: str, model: str, dims: int) -> list[float]:
    """Generate an embedding via the OpenAI client (OAuth, no API key needed).

    Falls back to pseudo-embedding if the client is not configured.
    """
    try:
        from openseed_providers.openai import get_openai_client  # type: ignore[import]
        client = get_openai_client()
        response = client.embeddings.create(input=text, model=model)
        return response.data[0].embedding
    except Exception as exc:
        logger.debug("pgvector: OpenAI embedding unavailable (%s), using pseudo-embedding", exc)
        return _pseudo_embedding(text, dims)


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------


class PgVectorMemoryBackend(MemoryBackend):
    """PostgreSQL + pgvector memory backend.

    Args:
        connection_url: Full libpq connection string, e.g.
            ``postgresql://user:pass@localhost/openseed``
        collection: Table name for memories (default ``openseed_memories``).
        embedding_dims: Dimensionality of embedding vectors (default 1536 for
            text-embedding-3-small).
        embedding_model: OpenAI embedding model name.
        pool_min: Minimum DB connections in the pool.
        pool_max: Maximum DB connections in the pool.
    """

    def __init__(
        self,
        connection_url: str,
        collection: str = "openseed_memories",
        embedding_dims: int = 1536,
        embedding_model: str = "text-embedding-3-small",
        pool_min: int = 1,
        pool_max: int = 5,
    ) -> None:
        if _PSYCOPG_VERSION is None:
            raise ImportError(
                "Neither 'psycopg' (v3) nor 'psycopg2' is installed. "
                "Run: pip install psycopg[pool] pgvector  "
                "or:  pip install psycopg2-binary pgvector"
            )
        if not _HAS_PGVECTOR:
            raise ImportError(
                "The 'pgvector' Python adapter is not installed. "
                "Run: pip install pgvector"
            )

        self._url = connection_url
        self._collection = collection
        self._dims = embedding_dims
        self._embedding_model = embedding_model
        self._pool_min = pool_min
        self._pool_max = pool_max
        self._pool: Any = None

    # ------------------------------------------------------------------
    # Connection pool helpers
    # ------------------------------------------------------------------

    def _make_pool(self) -> Any:
        if _PSYCOPG_VERSION == 3:
            pool = _ConnectionPool(
                self._url,
                min_size=self._pool_min,
                max_size=self._pool_max,
                open=True,
            )
        else:
            pool = _ConnectionPool(
                minconn=self._pool_min,
                maxconn=self._pool_max,
                dsn=self._url,
            )
        return pool

    def _get_conn(self) -> Any:
        assert self._pool is not None, "Backend not initialised — call initialize() first"
        if _PSYCOPG_VERSION == 3:
            return self._pool.getconn()
        return self._pool.getconn()

    def _put_conn(self, conn: Any, close: bool = False) -> None:
        if _PSYCOPG_VERSION == 3:
            self._pool.putconn(conn)
        else:
            self._pool.putconn(conn, close=close)

    # ------------------------------------------------------------------
    # MemoryBackend interface
    # ------------------------------------------------------------------

    def initialize(self) -> None:
        """Create the pool, enable pgvector extension, create tables + index."""
        self._pool = self._make_pool()
        conn = self._get_conn()
        try:
            # Register vector type for this connection
            if _PSYCOPG_VERSION == 2:
                _register_vector_v2(conn)  # type: ignore[name-defined]

            with conn.cursor() as cur:
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")

                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self._collection} (
                        id           TEXT PRIMARY KEY,
                        content      TEXT        NOT NULL,
                        memory_type  TEXT        NOT NULL DEFAULT 'semantic',
                        metadata     JSONB       NOT NULL DEFAULT '{{}}',
                        user_id      TEXT        NOT NULL DEFAULT 'default',
                        agent_id     TEXT        NOT NULL DEFAULT '',
                        embedding    vector({self._dims}),
                        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """)

                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self._collection}_history (
                        id          TEXT PRIMARY KEY,
                        memory_id   TEXT NOT NULL,
                        old_content TEXT,
                        new_content TEXT,
                        event       TEXT NOT NULL,
                        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """)

                # HNSW index for fast approximate nearest-neighbour search
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS {self._collection}_embedding_hnsw
                    ON {self._collection}
                    USING hnsw (embedding vector_cosine_ops)
                """)

                # B-tree index for user scoping
                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS {self._collection}_user_idx
                    ON {self._collection} (user_id)
                """)

            conn.commit()
            logger.info("pgvector backend initialised (table=%s, dims=%d)", self._collection, self._dims)
        finally:
            self._put_conn(conn)

    def _embed(self, text: str) -> list[float]:
        return _openai_embedding(text, self._embedding_model, self._dims)

    def add(
        self,
        content: str,
        user_id: str = "default",
        agent_id: str = "",
        memory_type: str = "semantic",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        mem_id = str(uuid.uuid4())[:12]
        now = datetime.utcnow().isoformat()
        embedding = self._embed(content)
        meta_json = json.dumps(metadata or {})

        conn = self._get_conn()
        try:
            if _PSYCOPG_VERSION == 2:
                _register_vector_v2(conn)  # type: ignore[name-defined]
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO {self._collection}
                        (id, content, memory_type, metadata, user_id, agent_id, embedding, created_at, updated_at)
                    VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s::vector, %s, %s)
                    """,
                    (mem_id, content, memory_type, meta_json, user_id, agent_id,
                     str(embedding), now, now),
                )
                cur.execute(
                    f"""
                    INSERT INTO {self._collection}_history
                        (id, memory_id, old_content, new_content, event, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (str(uuid.uuid4())[:12], mem_id, "", content, "ADD", now),
                )
            conn.commit()
        finally:
            self._put_conn(conn)

        return mem_id

    def search(
        self,
        query: str,
        user_id: str = "default",
        limit: int = 10,
        filters: dict | None = None,
    ) -> list[dict]:
        embedding = self._embed(query)
        # Fetch extra rows to allow for Python-side filtering when filters are set.
        fetch_limit = limit * 3 if filters else limit
        conn = self._get_conn()
        try:
            if _PSYCOPG_VERSION == 2:
                _register_vector_v2(conn)  # type: ignore[name-defined]
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, content, memory_type, metadata,
                           1 - (embedding <=> %s::vector) AS score
                    FROM {self._collection}
                    WHERE user_id = %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                    """,
                    (str(embedding), user_id, str(embedding), fetch_limit),
                )
                rows = cur.fetchall()
        finally:
            self._put_conn(conn)

        results = []
        for row in rows:
            meta = row[3] if isinstance(row[3], dict) else json.loads(row[3] or "{}")
            if filters and not matches_filter(meta, filters):
                continue
            results.append({
                "id": row[0],
                "memory": row[1],
                "memory_type": row[2],
                "metadata": meta,
                "score": float(row[4]) if row[4] is not None else 0.0,
            })
            if len(results) >= limit:
                break
        return results

    def update(self, memory_id: str, content: str, metadata: dict[str, Any] | None = None) -> bool:
        conn = self._get_conn()
        try:
            if _PSYCOPG_VERSION == 2:
                _register_vector_v2(conn)  # type: ignore[name-defined]
            with conn.cursor() as cur:
                # Fetch old content for history
                cur.execute(
                    f"SELECT content FROM {self._collection} WHERE id = %s",
                    (memory_id,),
                )
                row = cur.fetchone()
                if not row:
                    return False
                old_content = row[0]

                now = datetime.utcnow().isoformat()
                embedding = self._embed(content)

                if metadata is not None:
                    cur.execute(
                        f"""
                        UPDATE {self._collection}
                        SET content = %s, metadata = %s::jsonb,
                            embedding = %s::vector, updated_at = %s
                        WHERE id = %s
                        """,
                        (content, json.dumps(metadata), str(embedding), now, memory_id),
                    )
                else:
                    cur.execute(
                        f"""
                        UPDATE {self._collection}
                        SET content = %s, embedding = %s::vector, updated_at = %s
                        WHERE id = %s
                        """,
                        (content, str(embedding), now, memory_id),
                    )

                cur.execute(
                    f"""
                    INSERT INTO {self._collection}_history
                        (id, memory_id, old_content, new_content, event, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (str(uuid.uuid4())[:12], memory_id, old_content, content, "UPDATE", now),
                )
            conn.commit()
        finally:
            self._put_conn(conn)

        return True

    def delete(self, memory_id: str) -> bool:
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"DELETE FROM {self._collection} WHERE id = %s",
                    (memory_id,),
                )
                deleted = cur.rowcount > 0
            conn.commit()
        finally:
            self._put_conn(conn)
        return deleted

    def get_all(
        self,
        user_id: str = "default",
        limit: int = 100,
        filters: dict | None = None,
    ) -> list[dict]:
        # Fetch extra rows to allow for Python-side filtering when filters are set.
        fetch_limit = limit * 3 if filters else limit
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, content, memory_type, metadata
                    FROM {self._collection}
                    WHERE user_id = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                    """,
                    (user_id, fetch_limit),
                )
                rows = cur.fetchall()
        finally:
            self._put_conn(conn)

        result = []
        for row in rows:
            meta = row[3] if isinstance(row[3], dict) else json.loads(row[3] or "{}")
            if filters and not matches_filter(meta, filters):
                continue
            result.append({"id": row[0], "memory": row[1], "memory_type": row[2], "metadata": meta})
            if len(result) >= limit:
                break
        return result

    def history(self, memory_id: str) -> list[dict]:
        conn = self._get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT id, old_content, new_content, event, created_at
                    FROM {self._collection}_history
                    WHERE memory_id = %s
                    ORDER BY created_at
                    """,
                    (memory_id,),
                )
                rows = cur.fetchall()
        finally:
            self._put_conn(conn)

        return [{"id": r[0], "old": r[1], "new": r[2], "event": r[3], "at": str(r[4])} for r in rows]
