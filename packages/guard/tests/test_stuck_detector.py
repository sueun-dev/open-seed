"""
Tests for stuck detection — OpenHands pattern integration.

Covers all 5 stuck patterns without requiring LLM calls (mocked).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_guard.stuck_detector import (
    StuckAnalysis,
    _has_alternating_pattern,
    detect_stuck,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _step(summary: str) -> MagicMock:
    s = MagicMock()
    s.summary = summary
    return s


def _error(message: str) -> MagicMock:
    e = MagicMock()
    e.message = message
    return e


# ─── Pattern 1: Repeating Output ─────────────────────────────────────────────


class TestRepeatingOutput:
    @pytest.mark.asyncio
    async def test_exact_repeating_steps_detected(self) -> None:
        steps = [_step("Fix applied successfully")] * 4
        result = await detect_stuck(steps, [], [], retry_count=4)
        assert result.is_stuck
        assert result.pattern == "repeating_output"

    @pytest.mark.asyncio
    async def test_fewer_than_4_steps_not_stuck(self) -> None:
        steps = [_step("same")] * 3
        result = await detect_stuck(steps, [], [])
        assert not result.is_stuck

    @pytest.mark.asyncio
    async def test_different_steps_not_stuck(self) -> None:
        steps = [_step(f"step {i}") for i in range(4)]
        result = await detect_stuck(steps, [], [])
        assert not result.is_stuck


# ─── Pattern 2: Repeating Errors ─────────────────────────────────────────────


class TestRepeatingErrors:
    @pytest.mark.asyncio
    async def test_exact_repeating_errors_detected(self) -> None:
        errors = [_error("ModuleNotFoundError: foo")] * 3
        result = await detect_stuck([], [], errors)
        assert result.is_stuck
        assert result.pattern == "repeating_errors"

    @pytest.mark.asyncio
    async def test_different_errors_not_stuck(self) -> None:
        errors = [_error(f"Error {i}") for i in range(3)]
        result = await detect_stuck([], [], errors)
        assert not result.is_stuck

    @pytest.mark.asyncio
    async def test_semantic_match_via_llm(self) -> None:
        """Semantically identical errors detected via LLM."""
        errors = [
            _error("Cannot find module 'react'"),
            _error("Module 'react' not found"),
            _error("react module is missing"),
        ]
        with patch(
            "openseed_guard.stuck_detector._are_semantically_identical",
            new_callable=AsyncMock,
            return_value=True,
        ):
            result = await detect_stuck([], [], errors)
        assert result.is_stuck
        assert result.pattern == "repeating_errors"


# ─── Pattern 3: No-op Loop ──────────────────────────────────────────────────


class TestNoopLoop:
    @pytest.mark.asyncio
    async def test_noop_messages_detected(self) -> None:
        messages = [
            "Fix: NO files changed after 2 invocations",
            "Fix: NO files changed after 2 invocations",
            "Fix: NO files changed after 2 invocations",
        ]
        result = await detect_stuck([], messages, [])
        assert result.is_stuck
        assert result.pattern == "noop_loop"

    @pytest.mark.asyncio
    async def test_normal_messages_not_stuck(self) -> None:
        messages = ["Fix: 3 files changed", "Fix: 1 file changed"]
        result = await detect_stuck([], messages, [])
        assert not result.is_stuck


# ─── Pattern 4: Alternating Pattern ──────────────────────────────────────────


class TestAlternatingPattern:
    def test_abab_detected(self) -> None:
        items = ["A", "B", "A", "B", "A", "B"]
        assert _has_alternating_pattern(items)

    def test_all_same_not_alternating(self) -> None:
        items = ["A", "A", "A", "A", "A", "A"]
        assert not _has_alternating_pattern(items)

    def test_too_short_not_alternating(self) -> None:
        assert not _has_alternating_pattern(["A", "B"])

    def test_random_not_alternating(self) -> None:
        items = ["A", "B", "C", "D", "E", "F"]
        assert not _has_alternating_pattern(items)

    @pytest.mark.asyncio
    async def test_alternating_steps_detected(self) -> None:
        steps = [
            _step("pass"), _step("fail"),
            _step("pass"), _step("fail"),
            _step("pass"), _step("fail"),
        ]
        # Mock the LLM suggestion
        with patch(
            "openseed_guard.stuck_detector._get_llm_suggestion",
            new_callable=AsyncMock,
            return_value="Try a third approach",
        ):
            result = await detect_stuck(steps, [], [])
        assert result.is_stuck
        assert result.pattern == "alternating"


# ─── Pattern 5: Context Saturation ───────────────────────────────────────────


class TestContextSaturation:
    @pytest.mark.asyncio
    async def test_too_many_messages(self) -> None:
        messages = [f"msg {i}" for i in range(200)]
        result = await detect_stuck([], messages, [], max_messages=200)
        assert result.is_stuck
        assert result.pattern == "context_saturation"

    @pytest.mark.asyncio
    async def test_normal_message_count_ok(self) -> None:
        messages = [f"msg {i}" for i in range(10)]
        result = await detect_stuck([], messages, [])
        assert not result.is_stuck


# ─── No stuck ────────────────────────────────────────────────────────────────


class TestNotStuck:
    @pytest.mark.asyncio
    async def test_empty_state_not_stuck(self) -> None:
        result = await detect_stuck([], [], [])
        assert not result.is_stuck

    @pytest.mark.asyncio
    async def test_healthy_pipeline_not_stuck(self) -> None:
        steps = [_step(f"completed step {i}") for i in range(3)]
        messages = ["Intake: analyzed", "Plan: created", "Implement: done"]
        result = await detect_stuck(steps, messages, [])
        assert not result.is_stuck
