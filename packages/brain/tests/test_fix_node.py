"""
Tests for the fix_node — structured diagnose/fix/verify cycle.

Covers:
  1. Session continuity — first attempt creates session, subsequent reuse
  2. Structured fix prompts — different prompts for retry 0-2 vs 3+
  3. Insight consultation — triggered at retry 3, 6, 9, ...
  4. Evidence verification — detects no-op fixes, retries with explicit instruction
  5. Git stash — push on first attempt, revert on 3rd failure
  6. Helper functions — _build_findings_text, _build_fix_prompt, _snapshot_dir
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_brain.state import PipelineState, initial_state
from openseed_core.types import (
    Error,
    Finding,
    QAResult,
    Severity,
    Verdict,
)

# The fix_node does local imports, so we patch at the source module level.
# ClaudeAgent: patched at openseed_claude.agent.ClaudeAgent
# _recall_past_fixes, _git_stash_push, etc.: patched on the sentinel module


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_state(**overrides) -> PipelineState:
    """Return a minimal PipelineState, merging any keyword overrides."""
    base = initial_state(task="test task", working_dir="/tmp/test")
    base.update(overrides)  # type: ignore[attr-defined]
    return base


def _make_qa_fail(findings: list[Finding] | None = None) -> QAResult:
    """Build a failing QAResult with optional findings."""
    return QAResult(
        verdict=Verdict.BLOCK,
        findings=findings or [
            Finding(
                agent="syntax",
                severity=Severity.HIGH,
                title="SyntaxError",
                description="Unexpected token on line 42",
                file="app.py",
            ),
        ],
    )


def _mock_agent_response(text: str = "Fixed.", session_id: str = "sess-1"):
    """Create a mock ClaudeResponse."""
    resp = MagicMock()
    resp.text = text
    resp.session_id = session_id
    return resp


def _patch_fix_node_deps(mock_agent, stash_push=None, stash_revert=None, insight=None):
    """Return a combined context manager that patches all fix_node dependencies."""
    import contextlib

    patches = [
        patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
        patch(
            "openseed_brain.nodes.sentinel._recall_past_fixes",
            new_callable=AsyncMock,
            return_value="",
        ),
    ]
    if stash_push is not None:
        patches.append(
            patch("openseed_brain.nodes.sentinel._git_stash_push", stash_push),
        )
    if stash_revert is not None:
        patches.append(
            patch("openseed_brain.nodes.sentinel._git_stash_revert", stash_revert),
        )
    if insight is not None:
        patches.append(
            patch(
                "openseed_brain.nodes.sentinel._consult_insight_for_fix",
                new_callable=AsyncMock,
                return_value=insight,
            ),
        )
    return contextlib.ExitStack(), patches


# ─── 1. Session continuity ────────────────────────────────────────────────────


class TestFixNodeSessionContinuity:
    @pytest.mark.asyncio
    async def test_first_attempt_creates_session(self, tmp_path):
        """retry_count=0 should pass session_id, not continue_session."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=0,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed-1")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        invoke_call = mock_agent.invoke.call_args_list[0]
        assert invoke_call.kwargs.get("session_id") is not None
        assert invoke_call.kwargs.get("session_id", "").startswith("fix-")
        assert not invoke_call.kwargs.get("continue_session")

    @pytest.mark.asyncio
    async def test_subsequent_attempt_continues_session(self, tmp_path):
        """retry_count>0 should pass continue_session=True, no session_id."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=2,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed-v2")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
        ):
            result = await fix_node(state)

        invoke_call = mock_agent.invoke.call_args_list[0]
        assert invoke_call.kwargs.get("session_id") is None
        assert invoke_call.kwargs.get("continue_session") is True


# ─── 2. Structured fix prompts ───────────────────────────────────────────────


class TestBuildFixPrompt:
    def test_early_retry_uses_3_phase_approach(self):
        """retry 0-2 should produce a prompt with PHASE 1/2/3."""
        from openseed_brain.nodes.sentinel import _build_fix_prompt

        prompt = _build_fix_prompt(
            task="build a web app",
            working_dir="/tmp/proj",
            findings_text="- [HIGH] Syntax error in app.py",
            memory_context="",
            retry_count=1,
            failure_history=[],
        )
        assert "PHASE 1: DIAGNOSE" in prompt
        assert "PHASE 2: FIX" in prompt
        assert "PHASE 3: VERIFY" in prompt
        assert "COMPLETELY DIFFERENT" not in prompt

    def test_late_retry_uses_different_strategy(self):
        """retry 3+ should insist on a completely different approach."""
        from openseed_brain.nodes.sentinel import _build_fix_prompt

        prompt = _build_fix_prompt(
            task="build a web app",
            working_dir="/tmp/proj",
            findings_text="- [HIGH] Still broken",
            memory_context="",
            retry_count=4,
            failure_history=["Fix: attempt 1", "Fix: attempt 2", "Fix: attempt 3"],
        )
        assert "COMPLETELY DIFFERENT" in prompt
        assert "previous" in prompt.lower()
        assert "DO NOT repeat" in prompt

    def test_insight_advice_included_when_present(self):
        """Insight advice should be embedded in the prompt."""
        from openseed_brain.nodes.sentinel import _build_fix_prompt

        insight = MagicMock()
        insight.diagnosis = "The module structure is fundamentally wrong"
        insight.suggested_approach = "Rewrite using a flat module layout"

        prompt = _build_fix_prompt(
            task="build a web app",
            working_dir="/tmp/proj",
            findings_text="- [HIGH] ImportError",
            memory_context="",
            retry_count=3,
            failure_history=["attempt 1", "attempt 2", "attempt 3"],
            insight_advice=insight,
        )
        assert "INSIGHT GUIDANCE" in prompt
        assert "flat module layout" in prompt

    def test_failure_history_included(self):
        """Previous failure messages should appear in the prompt."""
        from openseed_brain.nodes.sentinel import _build_fix_prompt

        prompt = _build_fix_prompt(
            task="test",
            working_dir="/tmp",
            findings_text="",
            memory_context="",
            retry_count=2,
            failure_history=["Fix: NO files changed", "Fix: same error persists"],
        )
        assert "NO files changed" in prompt
        assert "same error persists" in prompt


# ─── 3. Insight consultation ──────────────────────────────────────────────────


class TestInsightConsultation:
    @pytest.mark.asyncio
    async def test_insight_consulted_at_retry_3(self, tmp_path):
        """At retry_count=3, Insight should be consulted."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=3,
            messages=["Fix: attempt 1", "Fix: attempt 2", "Fix: attempt 3"],
        )

        mock_insight = MagicMock()
        mock_insight.should_abandon = False
        mock_insight.diagnosis = "Root cause is X"
        mock_insight.suggested_approach = "Try Y instead"

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("insight-fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        insight_mock = AsyncMock(return_value=mock_insight)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._consult_insight_for_fix", insight_mock),
            patch("openseed_brain.nodes.sentinel._git_stash_revert", new_callable=AsyncMock, return_value=True),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        # Insight was consulted
        insight_mock.assert_awaited_once()
        # Should not have errors (Insight did not abandon)
        assert not result.get("errors")

    @pytest.mark.asyncio
    async def test_insight_abandon_escalates_to_user(self, tmp_path):
        """When Insight says should_abandon=True, fix_node returns an error for escalation."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=3,
        )

        mock_insight = MagicMock()
        mock_insight.should_abandon = True
        mock_insight.diagnosis = "Impossible without external API key"
        mock_insight.reason = "Missing credentials"

        with (
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._consult_insight_for_fix", new_callable=AsyncMock, return_value=mock_insight),
            patch("openseed_brain.nodes.sentinel._git_stash_revert", new_callable=AsyncMock, return_value=True),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        assert result.get("errors")
        assert "Needs user help" in result["errors"][0].message
        assert "ABANDON" in result["messages"][0]

    @pytest.mark.asyncio
    async def test_insight_not_consulted_at_retry_1(self, tmp_path):
        """At retry_count=1, Insight should NOT be consulted."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=1,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        insight_mock = AsyncMock(return_value=None)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._consult_insight_for_fix", insight_mock),
        ):
            await fix_node(state)

        insight_mock.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_insight_consulted_at_retry_6(self, tmp_path):
        """At retry_count=6 (another multiple of 3), Insight is consulted again."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=6,
        )

        mock_insight = MagicMock()
        mock_insight.should_abandon = False
        mock_insight.diagnosis = "New diagnosis"
        mock_insight.suggested_approach = "New approach"

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed-v6")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        insight_mock = AsyncMock(return_value=mock_insight)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._consult_insight_for_fix", insight_mock),
            patch("openseed_brain.nodes.sentinel._git_stash_revert", new_callable=AsyncMock, return_value=True),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        insight_mock.assert_awaited_once()


# ─── 4. Evidence verification ────────────────────────────────────────────────


class TestEvidenceVerification:
    @pytest.mark.asyncio
    async def test_detects_changed_files(self, tmp_path):
        """When files change, fix_node reports them."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=0,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed!")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        assert "1 files changed" in result["messages"][0]
        assert "app.py" in result["messages"][0]

    @pytest.mark.asyncio
    async def test_noop_fix_gets_second_chance(self, tmp_path):
        """When first invoke changes nothing, a second invoke is tried."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=0,
        )

        mock_agent = AsyncMock()
        call_count = 0

        async def invoke_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                (tmp_path / "app.py").write_text("actually-fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_side_effect)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        assert call_count == 2
        assert "1 files changed" in result["messages"][0]

    @pytest.mark.asyncio
    async def test_double_noop_returns_error(self, tmp_path):
        """When both invocations change nothing, an error is returned."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("broken")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=0,
        )

        mock_agent = AsyncMock()
        mock_agent.invoke = AsyncMock(return_value=_mock_agent_response())

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", new_callable=AsyncMock, return_value=True),
        ):
            result = await fix_node(state)

        assert result.get("errors")
        assert "no file changes" in result["errors"][0].message.lower()
        assert result["retry_count"] == 1


# ─── 5. Git stash ────────────────────────────────────────────────────────────


class TestGitStash:
    @pytest.mark.asyncio
    async def test_stash_push_on_first_attempt(self, tmp_path):
        """Git stash push is called on retry_count=0."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("code")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=0,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        stash_push = AsyncMock(return_value=True)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", stash_push),
        ):
            await fix_node(state)

        stash_push.assert_awaited_once_with(str(tmp_path))

    @pytest.mark.asyncio
    async def test_no_stash_on_subsequent_attempts(self, tmp_path):
        """Git stash push is NOT called on retry_count > 0 (unless multiple of 3)."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("code")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=1,
        )

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        stash_push = AsyncMock(return_value=True)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._git_stash_push", stash_push),
        ):
            await fix_node(state)

        stash_push.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_stash_revert_on_3rd_failure(self, tmp_path):
        """Git stash revert is called at retry_count=3 (3 consecutive failures)."""
        from openseed_brain.nodes.sentinel import fix_node

        (tmp_path / "app.py").write_text("code")
        state = _make_state(
            working_dir=str(tmp_path),
            qa_result=_make_qa_fail(),
            retry_count=3,
        )

        mock_insight = MagicMock()
        mock_insight.should_abandon = False
        mock_insight.diagnosis = "Try X"
        mock_insight.suggested_approach = "Do Y"

        mock_agent = AsyncMock()

        async def invoke_and_modify(*args, **kwargs):
            (tmp_path / "app.py").write_text("insight-fixed")
            return _mock_agent_response()

        mock_agent.invoke = AsyncMock(side_effect=invoke_and_modify)

        stash_revert = AsyncMock(return_value=True)
        stash_push = AsyncMock(return_value=True)

        with (
            patch("openseed_claude.agent.ClaudeAgent", return_value=mock_agent),
            patch("openseed_brain.nodes.sentinel._recall_past_fixes", new_callable=AsyncMock, return_value=""),
            patch("openseed_brain.nodes.sentinel._consult_insight_for_fix", new_callable=AsyncMock, return_value=mock_insight),
            patch("openseed_brain.nodes.sentinel._git_stash_revert", stash_revert),
            patch("openseed_brain.nodes.sentinel._git_stash_push", stash_push),
        ):
            await fix_node(state)

        stash_revert.assert_awaited_once()


# ─── 6. Helper functions ─────────────────────────────────────────────────────


class TestBuildFindingsText:
    def test_formats_findings(self):
        from openseed_brain.nodes.sentinel import _build_findings_text

        qa = _make_qa_fail([
            Finding(agent="lint", severity=Severity.HIGH, title="Error", description="bad code", file="x.py"),
            Finding(agent="test", severity=Severity.MEDIUM, title="Warn", description="slow", file="y.py"),
        ])
        text = _build_findings_text(qa)
        assert "[high]" in text or "[HIGH]" in text
        assert "[medium]" in text or "[MEDIUM]" in text
        assert "bad code" in text
        assert "x.py" in text

    def test_empty_findings(self):
        from openseed_brain.nodes.sentinel import _build_findings_text

        assert _build_findings_text(None) == ""
        empty_qa = QAResult(verdict=Verdict.BLOCK, findings=[])
        assert _build_findings_text(empty_qa) == ""


class TestSnapshotDir:
    def test_hashes_files(self, tmp_path):
        from openseed_brain.nodes.sentinel import _snapshot_dir

        (tmp_path / "a.txt").write_text("hello")
        (tmp_path / "b.txt").write_text("world")

        snap = _snapshot_dir(str(tmp_path))
        assert "a.txt" in snap
        assert "b.txt" in snap
        assert len(snap) == 2

    def test_excludes_git_and_node_modules(self, tmp_path):
        from openseed_brain.nodes.sentinel import _snapshot_dir

        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "config").write_text("git")
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "pkg.js").write_text("js")
        (tmp_path / "real.py").write_text("code")

        snap = _snapshot_dir(str(tmp_path))
        assert "real.py" in snap
        assert ".git/config" not in snap
        assert "node_modules/pkg.js" not in snap

    def test_detects_file_changes(self, tmp_path):
        from openseed_brain.nodes.sentinel import _snapshot_dir

        (tmp_path / "f.txt").write_text("v1")
        before = _snapshot_dir(str(tmp_path))

        (tmp_path / "f.txt").write_text("v2")
        after = _snapshot_dir(str(tmp_path))

        assert before["f.txt"] != after["f.txt"]


class TestGitStashHelpers:
    @pytest.mark.asyncio
    async def test_git_stash_push_no_git_dir(self, tmp_path):
        """_git_stash_push returns False when no .git directory exists."""
        from openseed_brain.nodes.sentinel import _git_stash_push

        result = await _git_stash_push(str(tmp_path))
        assert result is False

    @pytest.mark.asyncio
    async def test_git_stash_revert_no_git_dir(self, tmp_path):
        """_git_stash_revert returns False when no .git directory exists."""
        from openseed_brain.nodes.sentinel import _git_stash_revert

        result = await _git_stash_revert(str(tmp_path))
        assert result is False

    @pytest.mark.asyncio
    async def test_git_stash_push_with_git_dir(self, tmp_path):
        """_git_stash_push calls run_simple when .git exists."""
        from openseed_brain.nodes.sentinel import _git_stash_push

        (tmp_path / ".git").mkdir()

        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("openseed_core.subprocess.run_simple", new_callable=AsyncMock, return_value=mock_result):
            result = await _git_stash_push(str(tmp_path))
            assert result is True
