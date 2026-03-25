"""
Tests for LLM metrics aggregation — OpenHands pattern integration.
"""

from __future__ import annotations

from openseed_core.metrics import LLMCallMetric, Metrics


class TestMetrics:
    def test_initial_state(self) -> None:
        m = Metrics()
        assert m.total_cost_usd == 0.0
        assert m.prompt_tokens == 0
        assert m.completion_tokens == 0
        assert m.llm_calls == 0
        assert m.total_tokens == 0

    def test_add_single_call(self) -> None:
        m = Metrics()
        m.add(
            model="sonnet",
            prompt_tokens=1000,
            completion_tokens=500,
            cost_usd=0.0075,
            latency_ms=1500,
            node="implement",
        )
        assert m.llm_calls == 1
        assert m.prompt_tokens == 1000
        assert m.completion_tokens == 500
        assert m.total_tokens == 1500
        assert m.total_cost_usd == 0.0075
        assert m.total_latency_ms == 1500
        assert len(m.calls) == 1
        assert m.calls[0].node == "implement"

    def test_add_multiple_calls(self) -> None:
        m = Metrics()
        m.add(model="opus", prompt_tokens=2000, completion_tokens=1000, cost_usd=0.105, latency_ms=3000, node="plan")
        m.add(model="sonnet", prompt_tokens=1000, completion_tokens=500, cost_usd=0.0075, latency_ms=1000, node="fix")
        assert m.llm_calls == 2
        assert m.prompt_tokens == 3000
        assert m.completion_tokens == 1500
        assert m.total_cost_usd == pytest.approx(0.1125)

    def test_snapshot_is_independent(self) -> None:
        m = Metrics()
        m.add(model="haiku", prompt_tokens=100, completion_tokens=50, cost_usd=0.001, latency_ms=200, node="route")
        snap = m.snapshot()
        m.add(model="haiku", prompt_tokens=200, completion_tokens=100, cost_usd=0.002, latency_ms=300, node="route")
        assert snap.llm_calls == 1
        assert m.llm_calls == 2

    def test_diff(self) -> None:
        m = Metrics()
        m.add(model="sonnet", prompt_tokens=1000, completion_tokens=500, cost_usd=0.01, latency_ms=1000, node="a")
        before = m.snapshot()
        m.add(model="opus", prompt_tokens=2000, completion_tokens=1000, cost_usd=0.10, latency_ms=3000, node="b")
        diff = m.diff(before)
        assert diff.llm_calls == 1
        assert diff.prompt_tokens == 2000
        assert diff.total_cost_usd == pytest.approx(0.10)
        assert len(diff.calls) == 1
        assert diff.calls[0].node == "b"

    def test_merge(self) -> None:
        m1 = Metrics()
        m1.add(model="sonnet", prompt_tokens=1000, completion_tokens=500, cost_usd=0.01, latency_ms=1000, node="a")
        m2 = Metrics()
        m2.add(model="opus", prompt_tokens=2000, completion_tokens=1000, cost_usd=0.10, latency_ms=3000, node="b")
        merged = m1.merge(m2)
        assert merged.llm_calls == 2
        assert merged.prompt_tokens == 3000
        assert merged.total_cost_usd == pytest.approx(0.11)
        # Original unchanged
        assert m1.llm_calls == 1

    def test_summary_string(self) -> None:
        m = Metrics()
        m.add(model="sonnet", prompt_tokens=10000, completion_tokens=5000, cost_usd=0.045, latency_ms=2000, node="x")
        s = m.summary()
        assert "1 LLM calls" in s
        assert "15,000 tokens" in s
        assert "$0.0450" in s

    def test_cost_per_node(self) -> None:
        m = Metrics()
        m.add(model="sonnet", prompt_tokens=100, completion_tokens=50, cost_usd=0.01, latency_ms=100, node="plan")
        m.add(model="sonnet", prompt_tokens=100, completion_tokens=50, cost_usd=0.02, latency_ms=100, node="fix")
        m.add(model="opus", prompt_tokens=200, completion_tokens=100, cost_usd=0.05, latency_ms=200, node="plan")
        by_node = m.cost_per_node()
        assert by_node["plan"] == pytest.approx(0.06)
        assert by_node["fix"] == pytest.approx(0.02)

    def test_cache_tokens(self) -> None:
        m = Metrics()
        m.add(model="sonnet", prompt_tokens=100, completion_tokens=50, cache_read_tokens=80, cache_write_tokens=20, cost_usd=0.001, latency_ms=100, node="x")
        assert m.cache_read_tokens == 80
        assert m.cache_write_tokens == 20


# Need pytest import for approx
import pytest
