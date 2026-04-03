"""
Open Seed v2 — Structured message types for Left Hand (Claude Agent).

Mirrors the Claude Code SDK message types from research/claude-code-sdk-python.
Used for parsing Claude CLI output into typed dataclasses, and for cost tracking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ─── Content Block Types ─────────────────────────────────────────────────────


@dataclass
class TextBlock:
    """Plain text content from the assistant."""

    text: str


@dataclass
class ThinkingBlock:
    """Extended thinking content (requires thinking_budget > 0)."""

    thinking: str


@dataclass
class ToolUseBlock:
    """A tool invocation by the assistant."""

    tool_id: str
    tool_name: str
    input: dict[str, Any]


@dataclass
class ToolResultBlock:
    """The result returned from a tool call."""

    tool_use_id: str
    content: str
    is_error: bool = False


ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock


# ─── Usage & Cost Types ───────────────────────────────────────────────────────


@dataclass
class UsageStats:
    """Token usage statistics from a Claude invocation."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class CostEstimate:
    """Estimated USD cost for a Claude invocation.

    Note: When using OAuth (Pro/Team/Enterprise plan), the actual cost is $0
    within your included usage. These estimates are for budget awareness only.
    """

    input_cost: float = 0.0
    output_cost: float = 0.0
    total_cost: float = 0.0
    model: str = ""


# Model pricing per 1M tokens (for budget awareness; OAuth is $0 within limits)
MODEL_PRICING: dict[str, dict[str, float]] = {
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5": {"input": 0.80, "output": 4.0},
    # Aliases used internally
    "opus": {"input": 15.0, "output": 75.0},
    "sonnet": {"input": 3.0, "output": 15.0},
    "haiku": {"input": 0.80, "output": 4.0},
}

_DEFAULT_PRICING = MODEL_PRICING["claude-sonnet-4-6"]


def estimate_cost(usage: UsageStats, model: str) -> CostEstimate:
    """Estimate USD cost for a given usage and model.

    Uses model pricing table; falls back to sonnet pricing for unknown models.
    For partial model ID matching (e.g. "claude-sonnet-4-5"), tries prefix match.
    """
    pricing = MODEL_PRICING.get(model)
    if pricing is None:
        # Try partial match on known model families
        model_lower = model.lower()
        for key, val in MODEL_PRICING.items():
            if key in model_lower or model_lower.startswith(key):
                pricing = val
                break
        if pricing is None:
            pricing = _DEFAULT_PRICING

    input_cost = (usage.input_tokens / 1_000_000) * pricing["input"]
    output_cost = (usage.output_tokens / 1_000_000) * pricing["output"]
    return CostEstimate(
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=input_cost + output_cost,
        model=model,
    )


# ─── Structured Response ─────────────────────────────────────────────────────


@dataclass
class StructuredResponse:
    """Parsed, structured output from a Claude CLI invocation."""

    text: str = ""
    thinking: str = ""
    tool_uses: list[ToolUseBlock] = field(default_factory=list)
    tool_results: list[ToolResultBlock] = field(default_factory=list)
    usage: UsageStats = field(default_factory=UsageStats)
    model: str = ""
    session_id: str = ""
    duration_ms: int = 0
    num_turns: int = 0
    is_error: bool = False
    raw_json: dict[str, Any] | None = None
