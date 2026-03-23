"""
Open Seed v2 — SQLite memory backend.

Zero-dependency fallback when Qdrant is not available.
Uses FTS5 for text search (built into SQLite).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


class SQLiteMemoryBackend:
    """Simple SQLite-based memory store with FTS5 text search."""

    def __init__(self, db_path: str = "~/.openseed/memory.db") -> None:
        self._db_path = str(Path(db_path).expanduser())
        self._conn: sqlite3.Connection | None = None

    def initialize(self) -> None:
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                memory_type TEXT DEFAULT 'semantic',
                metadata TEXT DEFAULT '{}',
                user_id TEXT DEFAULT 'default',
                agent_id TEXT DEFAULT '',
                created_at TEXT,
                updated_at TEXT
            )
        """)
        # FTS5 for text search
        self._conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content, memory_type, user_id,
                content='memories',
                content_rowid='rowid'
            )
        """)
        # History table
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                memory_id TEXT,
                old_content TEXT,
                new_content TEXT,
                event TEXT,
                created_at TEXT
            )
        """)
        self._conn.commit()

    def add(self, content: str, user_id: str = "default", agent_id: str = "",
            memory_type: str = "semantic", metadata: dict[str, Any] | None = None) -> str:
        if not self._conn:
            self.initialize()
        assert self._conn
        mem_id = str(uuid.uuid4())[:12]
        now = datetime.now().isoformat()
        self._conn.execute(
            "INSERT INTO memories (id, content, memory_type, metadata, user_id, agent_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (mem_id, content, memory_type, json.dumps(metadata or {}), user_id, agent_id, now, now),
        )
        self._conn.execute(
            "INSERT INTO memories_fts (rowid, content, memory_type, user_id) SELECT rowid, content, memory_type, user_id FROM memories WHERE id = ?",
            (mem_id,),
        )
        self._conn.execute(
            "INSERT INTO history (id, memory_id, old_content, new_content, event, created_at) VALUES (?,?,?,?,?,?)",
            (str(uuid.uuid4())[:12], mem_id, "", content, "ADD", now),
        )
        self._conn.commit()
        return mem_id

    def search(self, query: str, user_id: str = "default", limit: int = 10) -> list[dict]:
        if not self._conn:
            self.initialize()
        assert self._conn
        results = []
        try:
            rows = self._conn.execute(
                """SELECT m.id, m.content, m.memory_type, m.metadata, rank
                   FROM memories_fts f
                   JOIN memories m ON m.rowid = f.rowid
                   WHERE memories_fts MATCH ? AND m.user_id = ?
                   ORDER BY rank LIMIT ?""",
                (query, user_id, limit),
            ).fetchall()
            for row in rows:
                results.append({
                    "id": row[0],
                    "memory": row[1],
                    "memory_type": row[2],
                    "metadata": json.loads(row[3] or "{}"),
                    "score": abs(row[4]) if row[4] else 0.0,
                })
        except sqlite3.OperationalError:
            # FTS query syntax error — fallback to LIKE
            rows = self._conn.execute(
                "SELECT id, content, memory_type, metadata FROM memories WHERE user_id = ? AND content LIKE ? LIMIT ?",
                (user_id, f"%{query}%", limit),
            ).fetchall()
            for row in rows:
                results.append({
                    "id": row[0], "memory": row[1], "memory_type": row[2],
                    "metadata": json.loads(row[3] or "{}"), "score": 0.5,
                })
        return results

    def get_all(self, user_id: str = "default", limit: int = 100) -> list[dict]:
        if not self._conn:
            self.initialize()
        assert self._conn
        rows = self._conn.execute(
            "SELECT id, content, memory_type, metadata FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [{"id": r[0], "memory": r[1], "memory_type": r[2], "metadata": json.loads(r[3] or "{}")} for r in rows]

    def delete(self, memory_id: str) -> bool:
        if not self._conn:
            return False
        self._conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        self._conn.commit()
        return True

    def history(self, memory_id: str) -> list[dict]:
        if not self._conn:
            return []
        rows = self._conn.execute(
            "SELECT id, old_content, new_content, event, created_at FROM history WHERE memory_id = ? ORDER BY created_at",
            (memory_id,),
        ).fetchall()
        return [{"id": r[0], "old": r[1], "new": r[2], "event": r[3], "at": r[4]} for r in rows]
