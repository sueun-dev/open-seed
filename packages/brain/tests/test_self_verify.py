"""
Tests for implement node self-verify-and-fix.

Covers:
  1. _self_verify_and_fix — lint check + auto-fix before QA Gate
  2. No lint commands detected → passthrough
  3. Lint passes → no fix invoked
  4. Lint fails → Claude fix invoked → re-check
  5. Lint fails → fix fails → message reports remaining issues
  6. Exception in self-verify → graceful fallthrough
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_brain.nodes.implement import _self_verify_and_fix
from openseed_core.types import Implementation


def _make_state(**overrides):
    """Create a minimal PipelineState-like dict."""
    base = {
        "task": "Build a REST API",
        "working_dir": "/tmp/test-project",
        "provider": "claude",
        "plan": None,
        "implementation": None,
        "qa_result": None,
        "retry_count": 0,
        "max_retries": 10,
        "deploy_result": None,
        "relevant_memories": [],
        "skip_planning": False,
        "errors": [],
        "messages": [],
        "step_results": [],
        "findings": [],
        "intake_analysis": {},
        "microagent_context": [],
        "_specialist_task": None,
    }
    base.update(overrides)
    return base


def _make_impl(summary="Built the API"):
    return Implementation(summary=summary, raw_output="full output here")


def _make_evidence(passed: bool, detail: str = ""):
    from openseed_guard.evidence import Evidence

    return Evidence(check="lint: tsc", passed=passed, detail=detail)


# ─── No lint commands detected ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_lint_commands_passthrough():
    """When no lint tools are detected, implementation passes through unchanged."""
    state = _make_state()
    impl = _make_impl()

    with patch(
        "openseed_guard.evidence.auto_detect_lint_commands",
        new_callable=AsyncMock,
        return_value=[],
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "test")

    assert result_impl is impl
    assert messages == []


# ─── Lint passes ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_lint_passes_no_fix():
    """When all lint checks pass, no fix is invoked."""
    state = _make_state()
    impl = _make_impl()

    with (
        patch(
            "openseed_guard.evidence.auto_detect_lint_commands",
            new_callable=AsyncMock,
            return_value=["npx tsc --noEmit"],
        ),
        patch(
            "openseed_guard.evidence.verify_command",
            new_callable=AsyncMock,
            return_value=_make_evidence(passed=True),
        ),
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "fullstack")

    assert result_impl is impl
    assert any("lint checks passed" in m for m in messages)


# ─── Lint fails → auto-fix succeeds ────────────────────────────────────────


@pytest.mark.asyncio
async def test_lint_fails_fix_succeeds():
    """When lint fails, Claude fixes, and re-check passes."""
    state = _make_state()
    impl = _make_impl()

    call_count = 0

    async def mock_verify_command(cmd, working_dir):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # First check: lint fails
            return _make_evidence(passed=False, detail="error TS2304: Cannot find name 'foo'")
        else:
            # After fix: lint passes
            return _make_evidence(passed=True)

    mock_agent = MagicMock()
    mock_agent.invoke = AsyncMock(return_value=MagicMock(text="Fixed the type error"))

    with (
        patch(
            "openseed_guard.evidence.auto_detect_lint_commands",
            new_callable=AsyncMock,
            return_value=["npx tsc --noEmit"],
        ),
        patch(
            "openseed_guard.evidence.verify_command",
            side_effect=mock_verify_command,
        ),
        patch(
            "openseed_claude.agent.ClaudeAgent",
            return_value=mock_agent,
        ),
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "fullstack")

    assert any("auto-fixing" in m for m in messages)
    assert any("all lint errors fixed" in m for m in messages)
    # Claude was invoked to fix
    mock_agent.invoke.assert_called_once()


# ─── Lint fails → fix also fails ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_lint_fails_fix_still_fails():
    """When lint fails and fix doesn't resolve it, message reports remaining issues."""
    state = _make_state()
    impl = _make_impl()

    async def mock_verify_always_fails(cmd, working_dir):
        return _make_evidence(passed=False, detail="still broken")

    mock_agent = MagicMock()
    mock_agent.invoke = AsyncMock(return_value=MagicMock(text="Tried to fix"))

    with (
        patch(
            "openseed_guard.evidence.auto_detect_lint_commands",
            new_callable=AsyncMock,
            return_value=["npx tsc --noEmit", "ruff check ."],
        ),
        patch(
            "openseed_guard.evidence.verify_command",
            side_effect=mock_verify_always_fails,
        ),
        patch(
            "openseed_claude.agent.ClaudeAgent",
            return_value=mock_agent,
        ),
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "test")

    assert any("lint issues remain" in m for m in messages)


# ─── Exception → graceful fallthrough ──────────────────────────────────────


@pytest.mark.asyncio
async def test_exception_graceful_fallthrough():
    """If self-verify throws, implementation passes through silently."""
    state = _make_state()
    impl = _make_impl()

    with patch(
        "openseed_guard.evidence.auto_detect_lint_commands",
        new_callable=AsyncMock,
        side_effect=RuntimeError("boom"),
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "test")

    assert result_impl is impl
    assert messages == []


# ─── Multiple lint commands, partial failure ───────────────────────────────


@pytest.mark.asyncio
async def test_multiple_lint_commands_partial_failure():
    """When one lint passes and another fails, only the failing one triggers fix."""
    state = _make_state()
    impl = _make_impl()

    results = iter(
        [
            _make_evidence(passed=True),  # tsc passes
            _make_evidence(passed=False, detail="ruff: E302"),  # ruff fails
            # After fix re-check:
            _make_evidence(passed=True),  # tsc still passes
            _make_evidence(passed=True),  # ruff now passes
        ]
    )

    mock_agent = MagicMock()
    mock_agent.invoke = AsyncMock(return_value=MagicMock(text="Fixed"))

    with (
        patch(
            "openseed_guard.evidence.auto_detect_lint_commands",
            new_callable=AsyncMock,
            return_value=["npx tsc --noEmit", "ruff check ."],
        ),
        patch(
            "openseed_guard.evidence.verify_command",
            side_effect=lambda *a, **kw: next(results),
        ),
        patch(
            "openseed_claude.agent.ClaudeAgent",
            return_value=mock_agent,
        ),
    ):
        result_impl, messages = await _self_verify_and_fix(state, impl, "test")

    assert any("auto-fixing" in m for m in messages)
    assert any("all lint errors fixed" in m for m in messages)
