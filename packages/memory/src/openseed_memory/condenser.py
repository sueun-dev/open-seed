"""
Open Seed v2 — Conversation Compression (OpenHands pattern).

Prevents context window explosion by condensing message history.
Two strategies:
  - RecentCondenser: Keep first + last N messages (zero-cost)
  - LLMSummaryCondenser: Summarize older messages via Haiku

Pattern from: openhands/memory/condenser/condenser.py
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class Condenser(ABC):
    """Base class for conversation condensers."""

    @abstractmethod
    async def condense(self, messages: list[str]) -> list[str]:
        """Condense a list of messages into a shorter list."""
        ...


class RecentCondenser(Condenser):
    """
    Keep the first message (original task) and last N messages.
    Zero-cost, always works. Default strategy.
    """

    def __init__(self, keep_recent: int = 10) -> None:
        self.keep_recent = keep_recent

    async def condense(self, messages: list[str]) -> list[str]:
        if len(messages) <= self.keep_recent + 1:
            return messages
        # First message (task context) + last N
        return [messages[0]] + messages[-self.keep_recent :]


class LLMSummaryCondenser(Condenser):
    """
    When messages exceed threshold, summarize older messages via Claude Haiku.
    Keeps first message + LLM summary of middle + last N verbatim.
    """

    def __init__(
        self,
        threshold: int = 20,
        keep_recent: int = 8,
    ) -> None:
        self.threshold = threshold
        self.keep_recent = keep_recent

    async def condense(self, messages: list[str]) -> list[str]:
        if len(messages) <= self.threshold:
            return messages

        first = messages[0]
        middle = messages[1 : -self.keep_recent]
        recent = messages[-self.keep_recent :]

        # Summarize the middle section
        summary = await self._summarize(middle)
        return [first, f"[CONDENSED HISTORY: {summary}]"] + recent

    async def _summarize(self, messages: list[str]) -> str:
        """Use Haiku to summarize a batch of messages."""
        try:
            from openseed_claude.agent import ClaudeAgent

            agent = ClaudeAgent()
            joined = "\n".join(f"- {m[:300]}" for m in messages[:30])
            response = await agent.invoke(
                prompt=(
                    "Summarize the following pipeline history into a single paragraph. "
                    "Focus on: what was attempted, what failed, what succeeded, "
                    "and the current state. Be concise.\n\n"
                    f"{joined}"
                ),
                model="haiku",
                max_turns=1,
            )
            return response.text.strip()[:1000]
        except Exception:
            # Fallback: just count what happened
            return f"{len(messages)} pipeline steps. Last: {messages[-1][:200] if messages else 'none'}"


class PipelineCondenser(Condenser):
    """
    Two-stage pipeline: try LLM summary first, fall back to recent-only.
    This is the recommended condenser for production use.
    """

    def __init__(
        self,
        llm_threshold: int = 20,
        keep_recent: int = 8,
    ) -> None:
        self._llm = LLMSummaryCondenser(
            threshold=llm_threshold,
            keep_recent=keep_recent,
        )
        self._recent = RecentCondenser(keep_recent=keep_recent)

    async def condense(self, messages: list[str]) -> list[str]:
        try:
            return await self._llm.condense(messages)
        except Exception:
            return await self._recent.condense(messages)


# ── Convenience function for pipeline nodes ──────────────────────────────────


async def condense_for_prompt(
    messages: list[str],
    max_messages: int = 15,
) -> str:
    """
    Condense pipeline messages into a single prompt-ready string.

    This is the main entry point for pipeline nodes (fix_node, implement_node)
    that need to include message history in their prompts without blowing
    up the context window.

    Args:
        messages: Full message list from PipelineState
        max_messages: Target maximum messages after condensation

    Returns:
        A single string with condensed history, ready for prompt inclusion
    """
    if not messages:
        return ""

    condenser = PipelineCondenser(
        llm_threshold=max_messages + 5,
        keep_recent=min(max_messages, 8),
    )
    condensed = await condenser.condense(messages)
    return "\n".join(condensed)
