"""
Open Seed v2 — LLM Metrics Aggregation (OpenHands pattern).

Structured per-call and cumulative cost/token/latency tracking.
Enables budget awareness, per-fix-attempt cost diff, and abort-on-budget.

Pattern from: openhands/llm/metrics.py
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class LLMCallMetric:
    """A single LLM invocation metric."""

    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    timestamp: datetime = field(default_factory=datetime.now)
    node: str = ""  # Which pipeline node made this call


@dataclass
class Metrics:
    """
    Aggregated LLM metrics for a pipeline run.

    Tracks cumulative cost, tokens, and latency across all LLM calls.
    Supports snapshot/diff for measuring per-phase cost.
    """

    total_cost_usd: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    llm_calls: int = 0
    total_latency_ms: int = 0
    calls: list[LLMCallMetric] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def add(
        self,
        *,
        model: str = "",
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        cost_usd: float = 0.0,
        latency_ms: int = 0,
        node: str = "",
    ) -> None:
        """Record a single LLM call."""
        self.prompt_tokens += prompt_tokens
        self.completion_tokens += completion_tokens
        self.cache_read_tokens += cache_read_tokens
        self.cache_write_tokens += cache_write_tokens
        self.total_cost_usd += cost_usd
        self.total_latency_ms += latency_ms
        self.llm_calls += 1
        self.calls.append(
            LLMCallMetric(
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cost_usd=cost_usd,
                latency_ms=latency_ms,
                node=node,
            )
        )

    def merge(self, other: Metrics) -> Metrics:
        """Merge another Metrics into a new combined Metrics (non-mutating)."""
        merged = self.snapshot()
        merged.total_cost_usd += other.total_cost_usd
        merged.prompt_tokens += other.prompt_tokens
        merged.completion_tokens += other.completion_tokens
        merged.cache_read_tokens += other.cache_read_tokens
        merged.cache_write_tokens += other.cache_write_tokens
        merged.llm_calls += other.llm_calls
        merged.total_latency_ms += other.total_latency_ms
        merged.calls.extend(other.calls)
        return merged

    def snapshot(self) -> Metrics:
        """Create a deep copy for before/after diffing."""
        return copy.deepcopy(self)

    def diff(self, before: Metrics) -> Metrics:
        """Compute the difference between current state and a previous snapshot."""
        return Metrics(
            total_cost_usd=self.total_cost_usd - before.total_cost_usd,
            prompt_tokens=self.prompt_tokens - before.prompt_tokens,
            completion_tokens=self.completion_tokens - before.completion_tokens,
            cache_read_tokens=self.cache_read_tokens - before.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens - before.cache_write_tokens,
            llm_calls=self.llm_calls - before.llm_calls,
            total_latency_ms=self.total_latency_ms - before.total_latency_ms,
            calls=self.calls[len(before.calls) :],
        )

    def summary(self) -> str:
        """Human-readable summary."""
        return (
            f"Metrics: {self.llm_calls} LLM calls, "
            f"{self.total_tokens:,} tokens "
            f"({self.prompt_tokens:,} in / {self.completion_tokens:,} out), "
            f"${self.total_cost_usd:.4f}, "
            f"{self.total_latency_ms:,}ms"
        )

    def cost_per_node(self) -> dict[str, float]:
        """Aggregate cost by pipeline node."""
        by_node: dict[str, float] = {}
        for call in self.calls:
            by_node[call.node] = by_node.get(call.node, 0.0) + call.cost_usd
        return by_node
