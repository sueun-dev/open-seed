"""
Tests for conversation compression — OpenHands pattern integration.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_memory.condenser import (
    LLMSummaryCondenser,
    PipelineCondenser,
    RecentCondenser,
    condense_for_prompt,
)


class TestRecentCondenser:
    @pytest.mark.asyncio
    async def test_short_list_unchanged(self) -> None:
        c = RecentCondenser(keep_recent=10)
        messages = ["a", "b", "c"]
        result = await c.condense(messages)
        assert result == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_long_list_keeps_first_and_last(self) -> None:
        c = RecentCondenser(keep_recent=3)
        messages = [f"msg-{i}" for i in range(20)]
        result = await c.condense(messages)
        assert len(result) == 4  # first + last 3
        assert result[0] == "msg-0"
        assert result[-1] == "msg-19"
        assert result[-2] == "msg-18"
        assert result[-3] == "msg-17"

    @pytest.mark.asyncio
    async def test_exact_boundary(self) -> None:
        c = RecentCondenser(keep_recent=5)
        messages = [f"msg-{i}" for i in range(6)]
        result = await c.condense(messages)
        assert result == messages  # 6 <= 5+1

    @pytest.mark.asyncio
    async def test_empty_list(self) -> None:
        c = RecentCondenser(keep_recent=5)
        result = await c.condense([])
        assert result == []


class TestLLMSummaryCondenser:
    @pytest.mark.asyncio
    async def test_below_threshold_unchanged(self) -> None:
        c = LLMSummaryCondenser(threshold=20, keep_recent=5)
        messages = [f"msg-{i}" for i in range(10)]
        result = await c.condense(messages)
        assert result == messages

    @pytest.mark.asyncio
    async def test_above_threshold_summarizes(self) -> None:
        c = LLMSummaryCondenser(threshold=10, keep_recent=3)
        messages = [f"msg-{i}" for i in range(15)]

        mock_response = MagicMock()
        mock_response.text = "Summary of steps 1-11: various fixes attempted"

        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await c.condense(messages)

        assert len(result) == 5  # first + condensed + last 3
        assert result[0] == "msg-0"
        assert "CONDENSED" in result[1]
        assert result[-1] == "msg-14"

    @pytest.mark.asyncio
    async def test_llm_failure_fallback(self) -> None:
        c = LLMSummaryCondenser(threshold=10, keep_recent=3)
        messages = [f"msg-{i}" for i in range(15)]

        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(side_effect=Exception("LLM down"))
            result = await c.condense(messages)

        # Fallback: count-based summary
        assert len(result) == 5
        assert "CONDENSED" in result[1]
        assert "pipeline steps" in result[1]


class TestPipelineCondenser:
    @pytest.mark.asyncio
    async def test_delegates_to_llm_condenser(self) -> None:
        c = PipelineCondenser(llm_threshold=5, keep_recent=2)
        messages = [f"msg-{i}" for i in range(10)]

        mock_response = MagicMock()
        mock_response.text = "Summary"

        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await c.condense(messages)

        assert len(result) < len(messages)

    @pytest.mark.asyncio
    async def test_falls_back_to_recent(self) -> None:
        c = PipelineCondenser(llm_threshold=5, keep_recent=2)
        messages = [f"msg-{i}" for i in range(10)]

        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(side_effect=Exception("fail"))
            result = await c.condense(messages)

        # Falls back to RecentCondenser: first + last 2
        assert len(result) <= 4  # first + condensed/fallback + last 2
        assert result[0] == "msg-0"
        assert result[-1] == "msg-9"


class TestCondenseForPrompt:
    @pytest.mark.asyncio
    async def test_empty_returns_empty(self) -> None:
        result = await condense_for_prompt([])
        assert result == ""

    @pytest.mark.asyncio
    async def test_short_list_joined(self) -> None:
        result = await condense_for_prompt(["hello", "world"], max_messages=10)
        assert "hello" in result
        assert "world" in result
