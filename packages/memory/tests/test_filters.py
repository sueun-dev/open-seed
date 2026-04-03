"""
Tests for advanced memory filters — AND/OR/NOT with comparison operators.
"""

from __future__ import annotations

import asyncio

from openseed_memory.filters import build_sql_where, matches_filter

# ===========================================================================
# matches_filter — pure Python
# ===========================================================================


class TestMatchesFilterEquality:
    def test_matches_filter_equality_match(self):
        meta = {"memory_type": "procedural", "resolved": True}
        assert matches_filter(meta, {"memory_type": "procedural"}) is True

    def test_matches_filter_equality_no_match(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"memory_type": "procedural"}) is False

    def test_matches_filter_equality_missing_key(self):
        meta = {"other": "value"}
        assert matches_filter(meta, {"memory_type": "procedural"}) is False

    def test_matches_filter_boolean_value(self):
        meta = {"resolved": True}
        assert matches_filter(meta, {"resolved": True}) is True
        assert matches_filter(meta, {"resolved": False}) is False


class TestMatchesFilterNe:
    def test_matches_filter_ne_match(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"memory_type": {"$ne": "procedural"}}) is True

    def test_matches_filter_ne_no_match(self):
        meta = {"memory_type": "procedural"}
        assert matches_filter(meta, {"memory_type": {"$ne": "procedural"}}) is False


class TestMatchesFilterGtLt:
    def test_matches_filter_gt_match(self):
        meta = {"score": 0.9}
        assert matches_filter(meta, {"score": {"$gt": 0.8}}) is True

    def test_matches_filter_gt_no_match(self):
        meta = {"score": 0.7}
        assert matches_filter(meta, {"score": {"$gt": 0.8}}) is False

    def test_matches_filter_lt_match(self):
        meta = {"priority": 2}
        assert matches_filter(meta, {"priority": {"$lt": 5}}) is True

    def test_matches_filter_lt_no_match(self):
        meta = {"priority": 7}
        assert matches_filter(meta, {"priority": {"$lt": 5}}) is False

    def test_matches_filter_gt_non_comparable(self):
        meta = {"label": "abc"}
        # Strings are comparable in Python but let's check numeric intent
        assert matches_filter(meta, {"label": {"$gt": "aaa"}}) is True

    def test_matches_filter_gt_type_mismatch_returns_false(self):
        meta = {"val": "text"}
        # Comparing str > int raises TypeError → returns False
        assert matches_filter(meta, {"val": {"$gt": 10}}) is False


class TestMatchesFilterGteLte:
    def test_matches_filter_gte_equal(self):
        meta = {"score": 0.8}
        assert matches_filter(meta, {"score": {"$gte": 0.8}}) is True

    def test_matches_filter_gte_greater(self):
        meta = {"score": 0.9}
        assert matches_filter(meta, {"score": {"$gte": 0.8}}) is True

    def test_matches_filter_gte_less(self):
        meta = {"score": 0.7}
        assert matches_filter(meta, {"score": {"$gte": 0.8}}) is False

    def test_matches_filter_lte_equal(self):
        meta = {"count": 5}
        assert matches_filter(meta, {"count": {"$lte": 5}}) is True

    def test_matches_filter_lte_less(self):
        meta = {"count": 3}
        assert matches_filter(meta, {"count": {"$lte": 5}}) is True

    def test_matches_filter_lte_greater(self):
        meta = {"count": 7}
        assert matches_filter(meta, {"count": {"$lte": 5}}) is False


class TestMatchesFilterIn:
    def test_matches_filter_in_match(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"memory_type": {"$in": ["semantic", "episodic"]}}) is True

    def test_matches_filter_in_no_match(self):
        meta = {"memory_type": "procedural"}
        assert matches_filter(meta, {"memory_type": {"$in": ["semantic", "episodic"]}}) is False

    def test_matches_filter_in_empty_list(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"memory_type": {"$in": []}}) is False


class TestMatchesFilterNin:
    def test_matches_filter_nin_match(self):
        meta = {"memory_type": "procedural"}
        assert matches_filter(meta, {"memory_type": {"$nin": ["semantic", "episodic"]}}) is True

    def test_matches_filter_nin_no_match(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"memory_type": {"$nin": ["semantic", "episodic"]}}) is False


class TestMatchesFilterAnd:
    def test_matches_filter_and_all_match(self):
        meta = {"memory_type": "procedural", "resolved": True}
        assert (
            matches_filter(
                meta,
                {
                    "$and": [
                        {"memory_type": "procedural"},
                        {"resolved": True},
                    ]
                },
            )
            is True
        )

    def test_matches_filter_and_one_fails(self):
        meta = {"memory_type": "procedural", "resolved": False}
        assert (
            matches_filter(
                meta,
                {
                    "$and": [
                        {"memory_type": "procedural"},
                        {"resolved": True},
                    ]
                },
            )
            is False
        )

    def test_matches_filter_and_empty_list(self):
        meta = {"x": 1}
        # All of [] is vacuously True
        assert matches_filter(meta, {"$and": []}) is True


class TestMatchesFilterOr:
    def test_matches_filter_or_first_matches(self):
        meta = {"memory_type": "semantic"}
        assert (
            matches_filter(
                meta,
                {
                    "$or": [
                        {"memory_type": "semantic"},
                        {"memory_type": "procedural"},
                    ]
                },
            )
            is True
        )

    def test_matches_filter_or_second_matches(self):
        meta = {"memory_type": "procedural"}
        assert (
            matches_filter(
                meta,
                {
                    "$or": [
                        {"memory_type": "semantic"},
                        {"memory_type": "procedural"},
                    ]
                },
            )
            is True
        )

    def test_matches_filter_or_none_match(self):
        meta = {"memory_type": "episodic"}
        assert (
            matches_filter(
                meta,
                {
                    "$or": [
                        {"memory_type": "semantic"},
                        {"memory_type": "procedural"},
                    ]
                },
            )
            is False
        )


class TestMatchesFilterNot:
    def test_matches_filter_not_negates(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {"$not": {"memory_type": "procedural"}}) is True

    def test_matches_filter_not_when_inner_matches(self):
        meta = {"memory_type": "procedural"}
        assert matches_filter(meta, {"$not": {"memory_type": "procedural"}}) is False


class TestMatchesFilterNested:
    def test_matches_filter_nested_or_inside_and(self):
        meta = {"memory_type": "procedural", "resolved": True}
        assert (
            matches_filter(
                meta,
                {
                    "$and": [
                        {
                            "$or": [
                                {"memory_type": "semantic"},
                                {"memory_type": "procedural"},
                            ]
                        },
                        {"resolved": True},
                    ]
                },
            )
            is True
        )

    def test_matches_filter_nested_or_inside_and_fails(self):
        meta = {"memory_type": "episodic", "resolved": True}
        assert (
            matches_filter(
                meta,
                {
                    "$and": [
                        {
                            "$or": [
                                {"memory_type": "semantic"},
                                {"memory_type": "procedural"},
                            ]
                        },
                        {"resolved": True},
                    ]
                },
            )
            is False
        )

    def test_matches_filter_deep_nesting(self):
        meta = {"a": 1, "b": "x", "c": True}
        f = {
            "$or": [
                {"a": {"$gt": 10}},
                {
                    "$and": [
                        {"b": "x"},
                        {"$not": {"c": False}},
                    ]
                },
            ]
        }
        assert matches_filter(meta, f) is True


class TestMatchesFilterEmpty:
    def test_matches_filter_empty_filters(self):
        meta = {"memory_type": "semantic"}
        assert matches_filter(meta, {}) is True

    def test_matches_filter_empty_metadata(self):
        # Non-existent key → value is None → None != "semantic" → False
        assert matches_filter({}, {"memory_type": "semantic"}) is False

    def test_matches_filter_both_empty(self):
        assert matches_filter({}, {}) is True

    def test_matches_filter_multiple_top_level_keys_all_must_match(self):
        meta = {"memory_type": "semantic", "resolved": True}
        assert matches_filter(meta, {"memory_type": "semantic", "resolved": True}) is True
        assert matches_filter(meta, {"memory_type": "semantic", "resolved": False}) is False


# ===========================================================================
# build_sql_where
# ===========================================================================


class TestBuildSqlWhere:
    def test_empty_filters(self):
        sql, params = build_sql_where({})
        assert sql == "1"
        assert params == {}

    def test_simple_equality(self):
        sql, params = build_sql_where({"memory_type": "procedural"})
        assert "json_extract" in sql
        assert "memory_type" in sql
        assert "procedural" in params.values()

    def test_gt_operator(self):
        sql, params = build_sql_where({"score": {"$gt": 0.8}})
        assert ">" in sql
        assert 0.8 in params.values()

    def test_in_operator(self):
        sql, params = build_sql_where({"memory_type": {"$in": ["semantic", "procedural"]}})
        assert "IN" in sql
        assert "semantic" in params.values()
        assert "procedural" in params.values()

    def test_and_operator(self):
        sql, params = build_sql_where(
            {
                "$and": [
                    {"memory_type": "procedural"},
                    {"resolved": True},
                ]
            }
        )
        assert "AND" in sql
        assert "procedural" in params.values()

    def test_or_operator(self):
        sql, params = build_sql_where(
            {
                "$or": [
                    {"memory_type": "semantic"},
                    {"memory_type": "procedural"},
                ]
            }
        )
        assert "OR" in sql

    def test_not_operator(self):
        sql, params = build_sql_where({"$not": {"memory_type": "procedural"}})
        assert "NOT" in sql


# ===========================================================================
# SQLite backend with filters
# ===========================================================================


class TestSQLiteSearchWithFilters:
    def _make_backend(self):
        from openseed_memory.backends.sqlite import SQLiteMemoryBackend

        backend = SQLiteMemoryBackend(db_path=":memory:")
        backend.initialize()
        return backend

    def test_sqlite_search_with_filters_match(self):
        backend = self._make_backend()
        backend.add(
            "Python facts", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic", "lang": "python"}
        )
        backend.add(
            "Workflow steps",
            user_id="u1",
            memory_type="procedural",
            metadata={"memory_type": "procedural", "lang": "go"},
        )

        results = backend.search("facts", user_id="u1", limit=10, filters={"memory_type": "semantic"})
        assert all(r["metadata"].get("memory_type") == "semantic" for r in results)

    def test_sqlite_search_with_filters_no_match(self):
        backend = self._make_backend()
        backend.add("Python facts", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic"})

        results = backend.search("facts", user_id="u1", limit=10, filters={"memory_type": "procedural"})
        assert results == []

    def test_sqlite_search_with_filters_operator(self):
        backend = self._make_backend()
        backend.add(
            "High score item",
            user_id="u1",
            memory_type="semantic",
            metadata={"memory_type": "semantic", "importance": 9},
        )
        backend.add(
            "Low score item",
            user_id="u1",
            memory_type="semantic",
            metadata={"memory_type": "semantic", "importance": 2},
        )

        results = backend.search("item", user_id="u1", limit=10, filters={"importance": {"$gt": 5}})
        assert len(results) == 1
        assert results[0]["metadata"]["importance"] == 9

    def test_sqlite_search_without_filters(self):
        backend = self._make_backend()
        backend.add("Alpha", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic"})
        backend.add("Beta", user_id="u1", memory_type="procedural", metadata={"memory_type": "procedural"})

        results = backend.search("alpha", user_id="u1", limit=10)
        assert len(results) >= 1


class TestSQLiteGetAllWithFilters:
    def _make_backend(self):
        from openseed_memory.backends.sqlite import SQLiteMemoryBackend

        backend = SQLiteMemoryBackend(db_path=":memory:")
        backend.initialize()
        return backend

    def test_sqlite_get_all_with_filters_single_field(self):
        backend = self._make_backend()
        backend.add("Fact A", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic"})
        backend.add("Procedure B", user_id="u1", memory_type="procedural", metadata={"memory_type": "procedural"})
        backend.add("Episode C", user_id="u1", memory_type="episodic", metadata={"memory_type": "episodic"})

        results = backend.get_all(user_id="u1", filters={"memory_type": "procedural"})
        assert len(results) == 1
        assert results[0]["memory_type"] == "procedural"

    def test_sqlite_get_all_with_filters_and(self):
        backend = self._make_backend()
        backend.add(
            "Done procedure",
            user_id="u1",
            memory_type="procedural",
            metadata={"memory_type": "procedural", "done": True},
        )
        backend.add(
            "Undone procedure",
            user_id="u1",
            memory_type="procedural",
            metadata={"memory_type": "procedural", "done": False},
        )

        results = backend.get_all(
            user_id="u1",
            filters={
                "$and": [
                    {"memory_type": "procedural"},
                    {"done": True},
                ]
            },
        )
        assert len(results) == 1
        assert results[0]["metadata"]["done"] is True

    def test_sqlite_get_all_with_filters_in(self):
        backend = self._make_backend()
        backend.add("Sem", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic"})
        backend.add("Proc", user_id="u1", memory_type="procedural", metadata={"memory_type": "procedural"})
        backend.add("Epis", user_id="u1", memory_type="episodic", metadata={"memory_type": "episodic"})

        results = backend.get_all(user_id="u1", filters={"memory_type": {"$in": ["semantic", "procedural"]}})
        types = {r["memory_type"] for r in results}
        assert "episodic" not in types
        assert types == {"semantic", "procedural"}

    def test_sqlite_get_all_no_filters(self):
        backend = self._make_backend()
        backend.add("A", user_id="u1", memory_type="semantic", metadata={})
        backend.add("B", user_id="u1", memory_type="procedural", metadata={})

        results = backend.get_all(user_id="u1")
        assert len(results) == 2

    def test_sqlite_get_all_filters_different_users(self):
        backend = self._make_backend()
        backend.add("U1 item", user_id="u1", memory_type="semantic", metadata={"memory_type": "semantic"})
        backend.add("U2 item", user_id="u2", memory_type="semantic", metadata={"memory_type": "semantic"})

        results = backend.get_all(user_id="u1", filters={"memory_type": "semantic"})
        assert len(results) == 1
        assert "U1 item" in results[0]["memory"]


# ===========================================================================
# MemoryStore with filters (integration)
# ===========================================================================


class TestStoreSearchWithFilters:
    def _make_store(self):
        import tempfile

        from openseed_core.config import MemoryConfig  # type: ignore[import]
        from openseed_memory.store import MemoryStore

        tmp = tempfile.mktemp(suffix=".db")
        cfg = MemoryConfig(backend="sqlite", sqlite_path=tmp)
        store = MemoryStore(config=cfg)
        asyncio.get_event_loop().run_until_complete(store.initialize())
        return store

    def test_store_search_with_filters(self):
        store = self._make_store()
        loop = asyncio.get_event_loop()

        loop.run_until_complete(
            store.add(
                "Python best practices",
                user_id="u1",
                memory_type=__import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType.SEMANTIC,
                metadata={"memory_type": "semantic", "lang": "python"},
                infer=False,
            )
        )
        loop.run_until_complete(
            store.add(
                "Deploy workflow",
                user_id="u1",
                memory_type=__import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType.PROCEDURAL,
                metadata={"memory_type": "procedural", "lang": "bash"},
                infer=False,
            )
        )

        results = loop.run_until_complete(
            store.search("workflow", user_id="u1", limit=10, filters={"memory_type": "procedural"}, rerank=False)
        )
        assert all(r.entry.metadata.get("memory_type") == "procedural" for r in results)

    def test_store_search_no_filters(self):
        store = self._make_store()
        loop = asyncio.get_event_loop()
        MemoryType = __import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType

        loop.run_until_complete(
            store.add(
                "Alpha content",
                user_id="u1",
                memory_type=MemoryType.SEMANTIC,
                metadata={},
                infer=False,
            )
        )
        results = loop.run_until_complete(store.search("alpha", user_id="u1", limit=10, rerank=False))
        assert len(results) >= 1


class TestStoreGetAllWithFilters:
    def _make_store(self):
        import tempfile

        from openseed_core.config import MemoryConfig  # type: ignore[import]
        from openseed_memory.store import MemoryStore

        tmp = tempfile.mktemp(suffix=".db")
        cfg = MemoryConfig(backend="sqlite", sqlite_path=tmp)
        store = MemoryStore(config=cfg)
        asyncio.get_event_loop().run_until_complete(store.initialize())
        return store

    def test_store_get_all_with_filters(self):
        store = self._make_store()
        loop = asyncio.get_event_loop()
        MemoryType = __import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType

        loop.run_until_complete(
            store.add(
                "Semantic fact",
                user_id="u1",
                memory_type=MemoryType.SEMANTIC,
                metadata={"memory_type": "semantic"},
                infer=False,
            )
        )
        loop.run_until_complete(
            store.add(
                "Procedural step",
                user_id="u1",
                memory_type=MemoryType.PROCEDURAL,
                metadata={"memory_type": "procedural"},
                infer=False,
            )
        )

        entries = loop.run_until_complete(store.get_all(user_id="u1", filters={"memory_type": "semantic"}))
        assert len(entries) == 1
        assert entries[0].metadata.get("memory_type") == "semantic"

    def test_store_get_all_no_filters(self):
        store = self._make_store()
        loop = asyncio.get_event_loop()
        MemoryType = __import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType

        for content in ("A", "B", "C"):
            loop.run_until_complete(
                store.add(
                    content,
                    user_id="u1",
                    memory_type=MemoryType.SEMANTIC,
                    metadata={},
                    infer=False,
                )
            )

        entries = loop.run_until_complete(store.get_all(user_id="u1"))
        assert len(entries) == 3

    def test_store_get_all_with_or_filter(self):
        store = self._make_store()
        loop = asyncio.get_event_loop()
        MemoryType = __import__("openseed_memory.types", fromlist=["MemoryType"]).MemoryType

        loop.run_until_complete(
            store.add(
                "Semantic",
                user_id="u1",
                memory_type=MemoryType.SEMANTIC,
                metadata={"memory_type": "semantic"},
                infer=False,
            )
        )
        loop.run_until_complete(
            store.add(
                "Episodic",
                user_id="u1",
                memory_type=MemoryType.EPISODIC,
                metadata={"memory_type": "episodic"},
                infer=False,
            )
        )
        loop.run_until_complete(
            store.add(
                "Procedural",
                user_id="u1",
                memory_type=MemoryType.PROCEDURAL,
                metadata={"memory_type": "procedural"},
                infer=False,
            )
        )

        entries = loop.run_until_complete(
            store.get_all(
                user_id="u1",
                filters={
                    "$or": [
                        {"memory_type": "semantic"},
                        {"memory_type": "episodic"},
                    ]
                },
            )
        )
        types = {e.metadata.get("memory_type") for e in entries}
        assert "procedural" not in types
        assert types == {"semantic", "episodic"}
