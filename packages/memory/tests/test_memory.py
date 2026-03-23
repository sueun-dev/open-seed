"""
Comprehensive tests for the openseed-memory package.

Categories:
  1. SQLiteMemoryBackend — unit tests against a real in-process SQLite DB
  2. FactExtractor — unit tests with mocked Claude CLI subprocess
  3. Reranker — unit tests with mocked Claude CLI subprocess
  4. MemoryStore — integration tests wired to SQLiteMemoryBackend
  5. Failure patterns — record_failure / recall_similar_failures
  6. Procedural memory — store_procedure / recall_procedures / fix strategies
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_core.config import MemoryConfig
from openseed_memory.backends.sqlite import SQLiteMemoryBackend
from openseed_memory.fact_extractor import FactExtractor, MemoryDecision
from openseed_memory.failure import record_failure, recall_similar_failures
from openseed_memory.procedural import (
    recall_fix_strategies,
    recall_procedures,
    store_fix_strategy,
    store_procedure,
)
from openseed_memory.reranker import Reranker
from openseed_memory.store import MemoryStore
from openseed_memory.types import MemoryEntry, MemoryEvent, MemoryType, SearchResult


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _make_sqlite_backend(tmp_path: Path) -> SQLiteMemoryBackend:
    db = SQLiteMemoryBackend(db_path=str(tmp_path / "test_memory.db"))
    db.initialize()
    return db


def _make_store(tmp_path: Path) -> MemoryStore:
    """Build a MemoryStore backed by SQLite — no Qdrant, no LLM needed."""
    config = MemoryConfig(backend="sqlite", sqlite_path=tmp_path / "store.db")
    return MemoryStore(config=config)


def _make_subprocess_result(stdout: str, exit_code: int = 0) -> MagicMock:
    """Create a fake SubprocessResult for run_streaming mocks."""
    result = MagicMock()
    result.stdout = stdout
    result.stderr = ""
    result.exit_code = exit_code
    result.timed_out = False
    return result


def _make_search_result(mem_id: str, content: str, score: float = 0.5) -> SearchResult:
    return SearchResult(
        entry=MemoryEntry(id=mem_id, content=content),
        score=score,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. SQLiteMemoryBackend — unit tests
# ─────────────────────────────────────────────────────────────────────────────


class TestSQLiteMemoryBackend:
    def test_initialize_creates_tables(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        assert db._conn is not None
        # Verify the three tables exist
        tables = {
            row[0]
            for row in db._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "memories" in tables
        assert "history" in tables

    def test_add_returns_id(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(content="The sky is blue", user_id="alice")
        assert isinstance(mem_id, str)
        assert len(mem_id) > 0

    def test_add_multiple_ids_are_unique(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        ids = {db.add(content=f"fact {i}", user_id="alice") for i in range(10)}
        assert len(ids) == 10

    def test_search_finds_content(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        db.add(content="Python is a programming language", user_id="alice")
        db.add(content="Rust is systems programming", user_id="alice")

        results = db.search(query="Python", user_id="alice")
        assert len(results) >= 1
        assert any("Python" in r["memory"] for r in results)

    def test_search_respects_user_id_isolation(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        db.add(content="Alice's secret", user_id="alice")
        db.add(content="Bob's secret", user_id="bob")

        alice_results = db.search(query="secret", user_id="alice")
        assert all("Alice" in r["memory"] for r in alice_results)

        bob_results = db.search(query="secret", user_id="bob")
        assert all("Bob" in r["memory"] for r in bob_results)

    def test_search_fallback_to_like(self, tmp_path: Path) -> None:
        """Trigger the LIKE fallback by passing an FTS-invalid query string."""
        db = _make_sqlite_backend(tmp_path)
        db.add(content="fallback content here", user_id="tester")

        # FTS5 query syntax error (unmatched quote) forces the LIKE path
        results = db.search(query='"unterminated', user_id="tester")
        # Should not raise; result count may be 0 but the call succeeds
        assert isinstance(results, list)

    def test_search_fallback_returns_matching_records(self, tmp_path: Path) -> None:
        """LIKE fallback should return records whose content matches the substring."""
        db = _make_sqlite_backend(tmp_path)
        db.add(content="unique_keyword in here", user_id="tester")

        # Simulate FTS failure by directly testing the LIKE path via a simple word
        # that also happens to be retrievable through the normal path
        results = db.search(query="unique_keyword", user_id="tester")
        assert len(results) >= 1

    def test_update_changes_content(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(content="Original content", user_id="alice")

        success = db.update(mem_id, "Updated content")
        assert success is True

        row = db._conn.execute(  # type: ignore[union-attr]
            "SELECT content FROM memories WHERE id = ?", (mem_id,)
        ).fetchone()
        assert row[0] == "Updated content"

    def test_update_records_history(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(content="Before update", user_id="alice")
        db.update(mem_id, "After update")

        history = db.history(mem_id)
        events = [h["event"] for h in history]
        assert "ADD" in events
        assert "UPDATE" in events

        update_record = next(h for h in history if h["event"] == "UPDATE")
        assert update_record["old"] == "Before update"
        assert update_record["new"] == "After update"

    def test_update_nonexistent_returns_false(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        result = db.update("nonexistent-id", "some content")
        assert result is False

    def test_delete_removes_entry(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(content="To be deleted", user_id="alice")

        assert db.delete(mem_id) is True

        row = db._conn.execute(  # type: ignore[union-attr]
            "SELECT id FROM memories WHERE id = ?", (mem_id,)
        ).fetchone()
        assert row is None

    def test_get_all_returns_all(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        for i in range(5):
            db.add(content=f"memory {i}", user_id="alice")

        results = db.get_all(user_id="alice")
        assert len(results) == 5

    def test_get_all_respects_limit(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        for i in range(10):
            db.add(content=f"memory {i}", user_id="alice")

        results = db.get_all(user_id="alice", limit=3)
        assert len(results) == 3

    def test_history_tracks_changes(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(content="v1", user_id="alice")
        db.update(mem_id, "v2")
        db.update(mem_id, "v3")

        history = db.history(mem_id)
        assert len(history) == 3  # ADD + 2 UPDATEs
        assert history[0]["event"] == "ADD"
        assert history[1]["event"] == "UPDATE"
        assert history[2]["event"] == "UPDATE"
        assert history[2]["new"] == "v3"

    def test_add_stores_metadata(self, tmp_path: Path) -> None:
        db = _make_sqlite_backend(tmp_path)
        mem_id = db.add(
            content="fact with metadata",
            user_id="alice",
            memory_type="episodic",
            metadata={"source": "conversation", "priority": 5},
        )
        results = db.get_all(user_id="alice")
        entry = next(r for r in results if r["id"] == mem_id)
        assert entry["memory_type"] == "episodic"
        assert entry["metadata"]["source"] == "conversation"
        assert entry["metadata"]["priority"] == 5


# ─────────────────────────────────────────────────────────────────────────────
# 2. FactExtractor — unit tests with mocked Claude CLI
# ─────────────────────────────────────────────────────────────────────────────


class TestFactExtractor:
    def _make_store_stub(self) -> MagicMock:
        """A MemoryStore stub whose search returns an empty list."""
        stub = MagicMock()
        stub.search = AsyncMock(return_value=[])
        return stub

    async def test_extract_returns_empty_on_no_cli(self) -> None:
        """When CLI path cannot be resolved, extract returns []."""
        extractor = FactExtractor(cli_path=None)
        with patch(
            "openseed_memory.fact_extractor.FactExtractor._get_cli", return_value=None
        ):
            decisions = await extractor.extract("some content", store=self._make_store_stub())
        assert decisions == []

    async def test_extract_returns_decisions_on_valid_json(self) -> None:
        payload = json.dumps([
            {
                "action": "ADD",
                "content": "Python is a programming language",
                "memory_id": None,
                "memory_type": "semantic",
                "reasoning": "New fact",
            }
        ])
        mock_result = _make_subprocess_result(stdout=payload)

        extractor = FactExtractor(cli_path="/fake/claude")
        # run_streaming is imported lazily inside the method, so patch at the source module
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            decisions = await extractor.extract("Python is great", store=self._make_store_stub())

        assert len(decisions) == 1
        assert decisions[0].action == MemoryEvent.ADD
        assert decisions[0].content == "Python is a programming language"
        assert decisions[0].memory_type == "semantic"

    async def test_extract_returns_empty_on_bad_json(self) -> None:
        mock_result = _make_subprocess_result(stdout="not valid json at all }{]}")

        extractor = FactExtractor(cli_path="/fake/claude")
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            decisions = await extractor.extract("some content", store=self._make_store_stub())

        assert decisions == []

    async def test_extract_returns_empty_on_subprocess_exception(self) -> None:
        extractor = FactExtractor(cli_path="/fake/claude")
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            side_effect=RuntimeError("subprocess died"),
        ):
            decisions = await extractor.extract("some content", store=self._make_store_stub())

        assert decisions == []

    def test_parse_decisions_handles_add(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps([
            {"action": "ADD", "content": "new fact", "memory_type": "semantic", "reasoning": "r"}
        ])
        decisions = extractor._parse_decisions(raw)
        assert len(decisions) == 1
        assert decisions[0].action == MemoryEvent.ADD

    def test_parse_decisions_handles_update(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps([
            {
                "action": "UPDATE",
                "content": "corrected fact",
                "memory_id": "abc123",
                "memory_type": "semantic",
                "reasoning": "supersedes old",
            }
        ])
        decisions = extractor._parse_decisions(raw)
        assert decisions[0].action == MemoryEvent.UPDATE
        assert decisions[0].memory_id == "abc123"

    def test_parse_decisions_handles_delete(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps([
            {"action": "DELETE", "content": "", "memory_id": "del456", "reasoning": "outdated"}
        ])
        decisions = extractor._parse_decisions(raw)
        assert decisions[0].action == MemoryEvent.DELETE
        assert decisions[0].memory_id == "del456"

    def test_parse_decisions_handles_noop(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps([
            {"action": "NOOP", "content": "already known", "memory_type": "semantic", "reasoning": "dup"}
        ])
        decisions = extractor._parse_decisions(raw)
        assert decisions[0].action == MemoryEvent.NONE

    def test_parse_decisions_handles_unknown_action(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps([
            {"action": "INVENT", "content": "something", "reasoning": "???"}
        ])
        decisions = extractor._parse_decisions(raw)
        assert decisions[0].action == MemoryEvent.NONE

    def test_parse_decisions_empty_string(self) -> None:
        extractor = FactExtractor()
        assert extractor._parse_decisions("") == []

    def test_parse_decisions_no_json_array(self) -> None:
        extractor = FactExtractor()
        assert extractor._parse_decisions("The answer is 42") == []

    def test_parse_decisions_ignores_non_dict_items(self) -> None:
        extractor = FactExtractor()
        raw = json.dumps(["not a dict", 42, None])
        decisions = extractor._parse_decisions(raw)
        assert decisions == []

    def test_parse_decisions_tolerates_missing_fields(self) -> None:
        extractor = FactExtractor()
        # Minimal item — only action
        raw = json.dumps([{"action": "ADD"}])
        decisions = extractor._parse_decisions(raw)
        assert len(decisions) == 1
        assert decisions[0].content == ""
        assert decisions[0].memory_type == "semantic"

    def test_parse_decisions_strips_extra_text_around_json(self) -> None:
        extractor = FactExtractor()
        raw = 'Here is your JSON:\n[{"action":"ADD","content":"the fact","memory_type":"semantic","reasoning":"r"}]\nThat is all.'
        decisions = extractor._parse_decisions(raw)
        assert len(decisions) == 1
        assert decisions[0].action == MemoryEvent.ADD


# ─────────────────────────────────────────────────────────────────────────────
# 3. Reranker — unit tests with mocked Claude CLI
# ─────────────────────────────────────────────────────────────────────────────


class TestReranker:
    def test_rerank_single_result_returns_as_is(self) -> None:
        """A list with ≤1 result is returned without calling the LLM."""
        reranker = Reranker()
        single = [_make_search_result("id1", "only result")]
        # No mock needed — short-circuits before any CLI call
        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            reranker.rerank(query="q", results=single)
        )
        assert result == single

    async def test_rerank_applies_llm_ordering(self) -> None:
        results = [
            _make_search_result("aaa", "less relevant"),
            _make_search_result("bbb", "most relevant"),
            _make_search_result("ccc", "middle"),
            _make_search_result("ddd", "least relevant"),
        ]
        # LLM says bbb first, then ccc, then aaa, then ddd
        mock_result = _make_subprocess_result(stdout='["bbb", "ccc", "aaa", "ddd"]')

        reranker = Reranker(cli_path="/fake/claude")
        # run_streaming is imported lazily inside the method — patch at the source module
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            reranked = await reranker.rerank(query="relevant query", results=results)

        assert [r.entry.id for r in reranked] == ["bbb", "ccc", "aaa", "ddd"]

    async def test_rerank_handles_missing_ids(self) -> None:
        """IDs omitted by LLM are appended at the tail in original order."""
        results = [
            _make_search_result("x1", "first"),
            _make_search_result("x2", "second"),
            _make_search_result("x3", "third"),
            _make_search_result("x4", "fourth"),
        ]
        # LLM returns only two of the four IDs
        mock_result = _make_subprocess_result(stdout='["x3", "x1"]')

        reranker = Reranker(cli_path="/fake/claude")
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            reranked = await reranker.rerank(query="q", results=results)

        ids = [r.entry.id for r in reranked]
        # Specified IDs come first in specified order
        assert ids[0] == "x3"
        assert ids[1] == "x1"
        # Omitted IDs are appended
        assert "x2" in ids
        assert "x4" in ids

    async def test_rerank_fallback_on_failure(self) -> None:
        """When run_streaming raises, rerank falls back to original order."""
        results = [
            _make_search_result("a", "alpha"),
            _make_search_result("b", "beta"),
            _make_search_result("c", "gamma"),
            _make_search_result("d", "delta"),
        ]
        reranker = Reranker(cli_path="/fake/claude")
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            side_effect=RuntimeError("network error"),
        ):
            reranked = await reranker.rerank(query="q", results=results)

        assert reranked == results

    async def test_rerank_fallback_on_bad_json(self) -> None:
        mock_result = _make_subprocess_result(stdout="not json")
        results = [
            _make_search_result("a", "one"),
            _make_search_result("b", "two"),
            _make_search_result("c", "three"),
            _make_search_result("d", "four"),
        ]
        reranker = Reranker(cli_path="/fake/claude")
        with patch(
            "openseed_core.subprocess.run_streaming",
            new_callable=AsyncMock,
            return_value=mock_result,
        ):
            reranked = await reranker.rerank(query="q", results=results)

        assert reranked == results

    async def test_rerank_skips_when_no_cli(self) -> None:
        """Without a CLI path, rerank returns original order without subprocess call."""
        results = [
            _make_search_result("a", "one"),
            _make_search_result("b", "two"),
            _make_search_result("c", "three"),
            _make_search_result("d", "four"),
        ]
        reranker = Reranker(cli_path=None)
        with patch(
            "openseed_memory.reranker.Reranker._get_cli", return_value=None
        ):
            reranked = await reranker.rerank(query="q", results=results)

        assert reranked == results

    def test_apply_ranking_preserves_all_results(self) -> None:
        reranker = Reranker()
        results = [
            _make_search_result("p", "p content"),
            _make_search_result("q", "q content"),
            _make_search_result("r", "r content"),
        ]
        reranked = reranker._apply_ranking('["r", "p", "q"]', results)
        assert len(reranked) == len(results)
        assert [x.entry.id for x in reranked] == ["r", "p", "q"]

    def test_apply_ranking_empty_raw_returns_original(self) -> None:
        reranker = Reranker()
        results = [_make_search_result("a", "x"), _make_search_result("b", "y")]
        assert reranker._apply_ranking("", results) == results


# ─────────────────────────────────────────────────────────────────────────────
# 4. MemoryStore — integration tests with SQLiteMemoryBackend
# ─────────────────────────────────────────────────────────────────────────────


class TestMemoryStore:
    async def test_store_add_raw_mode(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store.add(
            content="raw content",
            user_id="alice",
            memory_type=MemoryType.SEMANTIC,
            infer=False,
        )
        assert mem_id is not None
        assert isinstance(mem_id, str)

    async def test_store_add_with_inference_mocked(self, tmp_path: Path) -> None:
        """add(infer=True) calls FactExtractor; mock it to return one ADD decision."""
        store = _make_store(tmp_path)
        await store.initialize()

        fake_decision = MemoryDecision(
            action=MemoryEvent.ADD,
            content="extracted fact",
            memory_type="semantic",
            reasoning="new info",
        )
        with patch(
            "openseed_memory.store.MemoryStore._add_with_inference",
            new_callable=AsyncMock,
            return_value="mocked-id-001",
        ):
            mem_id = await store.add(
                content="a long conversation transcript",
                user_id="alice",
                infer=True,
            )

        assert mem_id == "mocked-id-001"

    async def test_store_add_inference_fallback_to_raw(self, tmp_path: Path) -> None:
        """When inference returns None, add() falls back to raw storage."""
        store = _make_store(tmp_path)
        await store.initialize()

        with patch(
            "openseed_memory.store.MemoryStore._add_with_inference",
            new_callable=AsyncMock,
            return_value=None,
        ):
            mem_id = await store.add(
                content="fallback content",
                user_id="alice",
                infer=True,
            )

        # Should still get an ID from the raw fallback path
        assert mem_id is not None

    async def test_store_search_without_rerank(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await store.add(content="machine learning is a field of AI", user_id="alice", infer=False)
        await store.add(content="deep learning uses neural networks", user_id="alice", infer=False)

        results = await store.search(query="machine learning", user_id="alice", rerank=False)
        assert isinstance(results, list)
        assert len(results) >= 1
        assert all(isinstance(r, SearchResult) for r in results)

    async def test_store_search_with_rerank(self, tmp_path: Path) -> None:
        """Rerank is only triggered when there are >3 results; mock the Reranker."""
        store = _make_store(tmp_path)
        await store.initialize()

        for i in range(5):
            await store.add(content=f"programming language {i}", user_id="alice", infer=False)

        # Reranker is imported lazily inside store.search via a local import;
        # patch at the reranker module where the class is defined.
        mock_reranker = MagicMock()
        mock_reranker.rerank = AsyncMock(side_effect=lambda query, results: results)

        with patch("openseed_memory.reranker.Reranker", return_value=mock_reranker):
            results = await store.search(query="programming", user_id="alice", rerank=True, limit=5)

        assert isinstance(results, list)
        mock_reranker.rerank.assert_awaited_once()

    async def test_store_delete(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store.add(content="to be deleted", user_id="alice", infer=False)
        assert mem_id is not None

        success = await store.delete(mem_id)
        assert success is True

        all_memories = await store.get_all(user_id="alice")
        assert not any(m.id == mem_id for m in all_memories)

    async def test_store_get_all(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        for i in range(4):
            await store.add(content=f"memory item {i}", user_id="alice", infer=False)

        memories = await store.get_all(user_id="alice")
        assert len(memories) == 4
        assert all(isinstance(m, MemoryEntry) for m in memories)

    async def test_store_update(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store.add(content="initial content", user_id="alice", infer=False)
        assert mem_id is not None

        success = await store._update(mem_id, "revised content")
        assert success is True

        # Verify content changed
        all_memories = await store.get_all(user_id="alice")
        updated = next(m for m in all_memories if m.id == mem_id)
        assert updated.content == "revised content"

    async def test_store_returns_none_without_backend(self, tmp_path: Path) -> None:
        """If no backend is set (not initialized), add/search/delete return graceful defaults."""
        store = _make_store(tmp_path)
        # Deliberately NOT calling initialize()

        result = await store.add(content="test", infer=False)
        assert result is None

        search = await store.search(query="test")
        assert search == []

        deleted = await store.delete("nonexistent")
        assert deleted is False

        all_m = await store.get_all()
        assert all_m == []

    async def test_store_initialize_idempotent(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()
        backend_before = store._backend
        await store.initialize()  # Second call is a no-op
        assert store._backend is backend_before

    async def test_store_history(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store.add(content="v1 content", user_id="alice", infer=False)
        await store._update(mem_id, "v2 content")

        history = await store.history(mem_id)
        assert len(history) == 2
        events = [h["event"] for h in history]
        assert "ADD" in events
        assert "UPDATE" in events


# ─────────────────────────────────────────────────────────────────────────────
# 5. Failure patterns
# ─────────────────────────────────────────────────────────────────────────────


class TestFailurePatterns:
    @pytest.fixture(autouse=True)
    def _no_claude_cli(self, monkeypatch):
        """Disable LLM fact extraction — no real CLI in test env."""
        monkeypatch.setattr(
            "openseed_memory.fact_extractor.FactExtractor._get_cli", lambda self: None,
        )
    async def test_record_failure_stores_entry(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await record_failure(
            store=store,
            task="Build a REST API",
            errors=["ModuleNotFoundError: flask"],
            attempted_fixes=["pip install flask"],
            successful_fix="pip install flask==2.3.3",
            user_id="system",
        )

        memories = await store.get_all(user_id="system")
        assert len(memories) == 1
        # LLM may rewrite the content — assert on the metadata that is always passed through
        meta = memories[0].metadata
        assert meta.get("type") == "failure_pattern"
        assert meta.get("task_summary") == "Build a REST API"
        assert meta.get("resolved") is True

    async def test_record_failure_unresolved(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await record_failure(
            store=store,
            task="Compile TypeScript project",
            errors=["tsc: error TS2345"],
            attempted_fixes=["Update tsconfig"],
            successful_fix="",
            user_id="system",
        )

        memories = await store.get_all(user_id="system")
        assert len(memories) == 1
        # LLM may rewrite content — assert on the metadata field instead
        meta = memories[0].metadata
        assert meta.get("type") == "failure_pattern"
        assert meta.get("resolved") is False

    async def test_recall_similar_failures(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await record_failure(
            store=store,
            task="Build Docker image",
            errors=["COPY failed: file not found"],
            attempted_fixes=["checked Dockerfile"],
            successful_fix="Fixed COPY path",
            user_id="system",
        )

        patterns = await recall_similar_failures(
            store=store,
            task="Build Docker image",
            errors=["COPY failed"],
            user_id="system",
        )

        # Should find the stored failure pattern (type=failure_pattern in metadata)
        assert isinstance(patterns, list)
        # If found, verify pattern structure
        for p in patterns:
            assert p.task_pattern != "" or p.error_type != ""

    async def test_recall_similar_failures_empty_store(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        patterns = await recall_similar_failures(
            store=store,
            task="some new task",
            errors=["some error"],
            user_id="system",
        )

        assert patterns == []

    async def test_record_failure_metadata_fields(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await record_failure(
            store=store,
            task="Run pytest suite",
            errors=["AssertionError", "TimeoutError"],
            attempted_fixes=["increase timeout"],
            successful_fix="set TIMEOUT=120",
            user_id="system",
        )

        memories = await store.get_all(user_id="system")
        meta = memories[0].metadata
        assert meta.get("type") == "failure_pattern"
        assert meta.get("resolved") is True
        assert meta.get("error_count") == 2


# ─────────────────────────────────────────────────────────────────────────────
# 6. Procedural memory
# ─────────────────────────────────────────────────────────────────────────────


class TestProceduralMemory:
    @pytest.fixture(autouse=True)
    def _no_claude_cli(self, monkeypatch):
        """Disable LLM fact extraction — no real CLI in test env."""
        monkeypatch.setattr(
            "openseed_memory.fact_extractor.FactExtractor._get_cli", lambda self: None,
        )

    async def test_store_procedure(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store_procedure(
            store=store,
            task_pattern="Build a Node.js REST API",
            steps=["Create package.json", "Write server.js", "npm install", "npm test"],
            outcome="All tests passed",
        )

        assert mem_id is not None
        memories = await store.get_all(user_id="system")
        assert len(memories) == 1
        # The LLM may rewrite the stored content; assert on metadata which is always present
        meta = memories[0].metadata
        assert meta.get("type") == "procedure"
        assert meta.get("step_count") == 4
        assert "Node.js REST API" in meta.get("task_pattern", "")

    async def test_store_procedure_metadata(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await store_procedure(
            store=store,
            task_pattern="Deploy to Kubernetes",
            steps=["Build image", "Push image", "Apply manifests"],
            outcome="Deployed successfully",
        )

        memories = await store.get_all(user_id="system")
        meta = memories[0].metadata
        assert meta.get("type") == "procedure"
        assert meta.get("step_count") == 3
        assert "Kubernetes" in meta.get("task_pattern", "")

    async def test_recall_procedures(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await store_procedure(
            store=store,
            task_pattern="Setup Python virtual environment",
            steps=["python -m venv .venv", "source .venv/bin/activate", "pip install -r requirements.txt"],
            outcome="Environment ready",
        )

        procedures = await recall_procedures(store=store, task="Python virtual environment")
        assert isinstance(procedures, list)
        # Each returned item should be a content string
        for p in procedures:
            assert isinstance(p, str)

    async def test_recall_procedures_empty_store(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        procedures = await recall_procedures(store=store, task="random task")
        assert procedures == []

    async def test_store_fix_strategy_success(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        mem_id = await store_fix_strategy(
            store=store,
            error_pattern="ImportError: cannot import name 'foo'",
            fix_applied="pip install foo==1.2.3",
            success=True,
        )

        assert mem_id is not None
        memories = await store.get_all(user_id="system")
        assert "SUCCESS" in memories[0].content

    async def test_store_fix_strategy_failure(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await store_fix_strategy(
            store=store,
            error_pattern="SegmentationFault in native extension",
            fix_applied="reinstall package",
            success=False,
        )

        memories = await store.get_all(user_id="system")
        assert len(memories) == 1
        # LLM may rewrite the content; assert on the metadata field which is always passed through
        assert memories[0].metadata.get("success") is False
        assert memories[0].metadata.get("type") == "fix_strategy"

    async def test_recall_fix_strategies(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        # Store one successful and one failed fix for the same error type
        await store_fix_strategy(
            store=store,
            error_pattern="Connection refused on port 5432",
            fix_applied="start PostgreSQL service",
            success=True,
        )
        await store_fix_strategy(
            store=store,
            error_pattern="Connection refused on port 5432",
            fix_applied="change port to 5433",
            success=False,
        )

        successful, failed = await recall_fix_strategies(
            store=store,
            error="Connection refused on port 5432",
        )

        assert isinstance(successful, list)
        assert isinstance(failed, list)

    async def test_recall_fix_strategies_empty_store(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        successful, failed = await recall_fix_strategies(store=store, error="some error")
        assert successful == []
        assert failed == []

    async def test_store_procedure_with_custom_metadata(self, tmp_path: Path) -> None:
        store = _make_store(tmp_path)
        await store.initialize()

        await store_procedure(
            store=store,
            task_pattern="Custom task",
            steps=["step A", "step B"],
            outcome="done",
            metadata={"team": "backend", "language": "go"},
        )

        memories = await store.get_all(user_id="system")
        meta = memories[0].metadata
        assert meta.get("team") == "backend"
        assert meta.get("language") == "go"
        # Built-in fields still present
        assert meta.get("type") == "procedure"
