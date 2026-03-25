"""
Comprehensive tests for openseed-guard.

Coverage:
  - IntentGate: classify_intent (all IntentTypes + fallbacks)
  - ExecutionLoop: all 7 steps, retry logic, evidence integration
  - Delegation: build_delegation_prompt structure & escaping
  - Backoff: compute_backoff_ms + should_retry (pure logic)
  - Stagnation: is_stagnated threshold checks (pure logic)
  - Progress: ProgressTracker improvement / stagnation detection
  - evaluate_loop: pass / retry / insight / user_escalate / abort
"""

from __future__ import annotations

import os
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ─── Core types ───────────────────────────────────────────────────────────────

from openseed_core.config import SentinelConfig
from openseed_core.types import Finding, QAResult, Verdict

# ─── Sentinel modules ─────────────────────────────────────────────────────────

from openseed_guard.backoff import compute_backoff_ms, should_retry
from openseed_guard.delegation import build_delegation_prompt
from openseed_guard.evidence import (
    Evidence,
    VerificationResult,
    verify_files_exist,
)
from openseed_guard.execution_loop import ExecutionLoop, ExecutionResult
from openseed_guard.intent_gate import IntentClassification, IntentType, classify_intent
from openseed_guard.loop import LoopDecision, LoopState, evaluate_loop
from openseed_guard.insight import InsightAdvice
from openseed_guard.progress import ProgressSnapshot, ProgressTracker, ProgressUpdate
from openseed_guard.stagnation import is_stagnated, stagnation_message


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _make_stream_result(stdout: str, exit_code: int = 0) -> MagicMock:
    """Build a fake run_streaming result object."""
    result = MagicMock()
    result.stdout = stdout
    result.stderr = ""
    result.exit_code = exit_code
    result.timed_out = False
    result.lines = []
    return result


def _make_streaming_side_effect(json_text: str):
    """
    Return an AsyncMock side-effect that, when awaited, calls on_line once
    with a fake stdout StreamLine bearing json_text, then returns None.
    """

    async def _effect(command, timeout_seconds, on_line):  # noqa: ARG001
        line = MagicMock()
        line.source = "stdout"
        line.text = json_text
        await on_line(line)

    return _effect


def _make_qa_result(verdict: Verdict = Verdict.PASS, findings: list | None = None) -> QAResult:
    return QAResult(verdict=verdict, findings=findings or [])


def _make_verification(all_passed: bool = True) -> VerificationResult:
    evidence = [Evidence(check="dummy", passed=all_passed)]
    return VerificationResult(
        all_passed=all_passed,
        evidence=evidence,
        missing_files=[] if all_passed else ["missing.py"],
        failing_commands=[] if all_passed else ["pytest"],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# 1. IntentGate
# ═══════════════════════════════════════════════════════════════════════════════


class TestIntentGate:
    """Tests for openseed_guard.intent_gate.classify_intent."""

    @pytest.fixture
    def _patch_auth(self):
        with patch("openseed_guard.intent_gate.require_claude_auth", return_value="/usr/bin/claude"):
            yield

    # ── Implementation ────────────────────────────────────────────────────────

    async def test_classify_intent_implementation(self, _patch_auth):
        json_text = (
            '{"intent_type": "implementation", "confidence": 0.95, '
            '"reasoning": "User wants to add a feature.", '
            '"suggested_approach": "plan and implement"}'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ):
            result = await classify_intent("Add a new login page")

        assert result.intent_type == IntentType.IMPLEMENTATION
        assert result.confidence == pytest.approx(0.95)
        assert "plan" in result.suggested_approach.lower()

    # ── Research ──────────────────────────────────────────────────────────────

    async def test_classify_intent_research(self, _patch_auth):
        json_text = (
            '{"intent_type": "research", "confidence": 0.88, '
            '"reasoning": "User is asking how something works.", '
            '"suggested_approach": "explore → answer"}'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ):
            result = await classify_intent("How does LangGraph work?")

        assert result.intent_type == IntentType.RESEARCH
        assert result.confidence == pytest.approx(0.88)

    # ── Fix ───────────────────────────────────────────────────────────────────

    async def test_classify_intent_fix(self, _patch_auth):
        json_text = (
            '{"intent_type": "fix", "confidence": 0.92, '
            '"reasoning": "There is a broken test.", '
            '"suggested_approach": "diagnose → fix minimally"}'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ):
            result = await classify_intent("Fix the broken pytest suite")

        assert result.intent_type == IntentType.FIX
        assert "fix" in result.suggested_approach.lower()

    # ── Fallback on parse error ───────────────────────────────────────────────

    async def test_classify_intent_fallback_on_parse_error(self, _patch_auth):
        """Garbled LLM output → open_ended fallback with low confidence."""
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect("not valid json at all!!!"),
        ):
            result = await classify_intent("Do something")

        assert result.intent_type == IntentType.OPEN_ENDED
        assert result.confidence < 0.5
        assert result.reasoning == "Failed to parse LLM response"

    # ── Fallback on CLI failure (no output) ───────────────────────────────────

    async def test_classify_intent_fallback_on_cli_failure(self, _patch_auth):
        """When run_streaming produces no stdout lines → graceful fallback."""
        async def _noop(command, timeout_seconds, on_line):  # noqa: ARG001
            pass  # never calls on_line

        with patch("openseed_guard.intent_gate.run_streaming", side_effect=_noop):
            result = await classify_intent("Whatever task")

        assert result.intent_type == IntentType.OPEN_ENDED
        assert result.confidence < 0.5

    # ── Unknown intent_type in JSON → coerced to open_ended ──────────────────

    async def test_classify_intent_unknown_type_coerced(self, _patch_auth):
        json_text = (
            '{"intent_type": "banana", "confidence": 0.7, '
            '"reasoning": "unknown", "suggested_approach": "?"}'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ):
            result = await classify_intent("Some task")

        assert result.intent_type == IntentType.OPEN_ENDED

    # ── JSON embedded in prose ────────────────────────────────────────────────

    async def test_classify_intent_json_embedded_in_prose(self, _patch_auth):
        """Parser should extract JSON even when surrounded by markdown text."""
        json_text = (
            'Sure! Here is my answer:\n'
            '{"intent_type": "evaluation", "confidence": 0.75, '
            '"reasoning": "User wants a review.", "suggested_approach": "evaluate → propose"}'
            '\nHope that helps!'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ):
            result = await classify_intent("What do you think about this design?")

        assert result.intent_type == IntentType.EVALUATION

    # ── Codebase context is truncated to 500 chars ────────────────────────────

    async def test_classify_intent_codebase_context_truncated(self, _patch_auth):
        """Verify that long codebase_context doesn't cause a crash."""
        long_context = "x" * 5000
        json_text = (
            '{"intent_type": "open_ended", "confidence": 0.5, '
            '"reasoning": "ok", "suggested_approach": "assess"}'
        )
        with patch(
            "openseed_guard.intent_gate.run_streaming",
            side_effect=_make_streaming_side_effect(json_text),
        ) as mock_rs:
            result = await classify_intent("Task", codebase_context=long_context)

        assert result.intent_type == IntentType.OPEN_ENDED
        # The call should have been made (no crash)
        assert mock_rs.called


# ═══════════════════════════════════════════════════════════════════════════════
# 2. ExecutionLoop
# ═══════════════════════════════════════════════════════════════════════════════


class TestExecutionLoop:
    """Tests for openseed_guard.execution_loop.ExecutionLoop."""

    @pytest.fixture
    def _patch_auth(self):
        with patch(
            "openseed_guard.execution_loop.require_claude_auth",
            return_value="/usr/bin/claude",
        ):
            yield

    @pytest.fixture
    def _always_pass_verify(self):
        """Patch verify_implementation to always succeed."""
        ok = VerificationResult(
            all_passed=True,
            evidence=[Evidence(check="ok", passed=True)],
            missing_files=[],
            failing_commands=[],
        )
        with patch(
            "openseed_guard.execution_loop.verify_implementation",
            new_callable=AsyncMock,
            return_value=ok,
        ):
            yield ok

    @pytest.fixture
    def _always_fail_verify(self):
        """Patch verify_implementation to always fail."""
        fail = VerificationResult(
            all_passed=False,
            evidence=[Evidence(check="bad", passed=False, detail="missing file")],
            missing_files=["expected.py"],
            failing_commands=["pytest"],
        )
        with patch(
            "openseed_guard.execution_loop.verify_implementation",
            new_callable=AsyncMock,
            return_value=fail,
        ):
            yield fail

    def _explore_side_effect(self):
        """Return a streaming side-effect for a valid EXPLORE response."""
        return _make_streaming_side_effect(
            '{"codebase_state": "disciplined", "relevant_patterns": ["pytest"], '
            '"assumptions": [], "relevant_files": [], "summary": "test project"}'
        )

    def _plan_side_effect(self):
        return _make_streaming_side_effect(
            '{"files_to_change": [], "files_to_create": ["new.py"], '
            '"steps": ["Step 1: create new.py"], '
            '"expected_test_commands": [], "complexity": "trivial", '
            '"approach_summary": "just create new.py"}'
        )

    def _route_side_effect(self):
        return _make_streaming_side_effect(
            '{"decision": "execute", "reason": "simple task", '
            '"sub_agent_type": null, "clarification_question": null, "concern": null}'
        )

    def _retry_side_effect(self):
        return _make_streaming_side_effect(
            '{"diagnosis": "file was not created", '
            '"corrective_steps": ["Step 1: create the file"], '
            '"files_to_check": ["new.py"], "new_test_commands": []}'
        )

    # ── Happy path: all steps complete ───────────────────────────────────────

    async def test_execution_loop_completes_all_steps(self, _patch_auth, _always_pass_verify):
        """Full run with passing verify — steps_completed must include all 7."""
        call_sequence = [
            self._explore_side_effect(),
            self._plan_side_effect(),
            self._route_side_effect(),
        ]
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=call_sequence,
        ):
            loop = ExecutionLoop()
            result = await loop.run(task="Create new.py", working_dir="/tmp")

        assert result.success is True
        assert "explore" in result.steps_completed
        assert "plan" in result.steps_completed
        assert "route" in result.steps_completed
        assert "execute" in result.steps_completed
        assert "verify" in result.steps_completed
        assert "done" in result.steps_completed
        assert result.retry_count == 0

    # ── Verify failure triggers a retry ──────────────────────────────────────

    async def test_execution_loop_retries_on_verify_failure(self, _patch_auth):
        """First verify fails, second (after retry) passes."""
        fail = VerificationResult(
            all_passed=False,
            evidence=[Evidence(check="bad", passed=False)],
            missing_files=["new.py"],
            failing_commands=[],
        )
        ok = VerificationResult(
            all_passed=True,
            evidence=[Evidence(check="ok", passed=True)],
            missing_files=[],
            failing_commands=[],
        )
        verify_mock = AsyncMock(side_effect=[fail, ok])

        with patch(
            "openseed_guard.execution_loop.verify_implementation",
            verify_mock,
        ), patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=[
                self._explore_side_effect(),
                self._plan_side_effect(),
                self._route_side_effect(),
                self._retry_side_effect(),  # retry step calls Claude
            ],
        ):
            loop = ExecutionLoop()
            result = await loop.run(task="Create file", working_dir="/tmp")

        assert result.retry_count == 1
        assert "retry_1" in result.steps_completed
        assert result.success is True

    # ── Max 3 retries: verify always fails ───────────────────────────────────

    async def test_execution_loop_max_3_retries(self, _patch_auth, _always_fail_verify):
        """When verify always fails the loop exits after exactly 3 retries."""
        retry_responses = [self._retry_side_effect() for _ in range(3)]
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=[
                self._explore_side_effect(),
                self._plan_side_effect(),
                self._route_side_effect(),
                *retry_responses,
            ],
        ):
            loop = ExecutionLoop()
            result = await loop.run(task="Fail always", working_dir="/tmp")

        assert result.retry_count == 3
        assert result.success is False
        assert "retry_1" in result.steps_completed
        assert "retry_2" in result.steps_completed
        assert "retry_3" in result.steps_completed

    # ── _explore returns structured data ─────────────────────────────────────

    async def test_explore_returns_structured_data(self, _patch_auth):
        """_explore should parse JSON and return a dict with codebase_state."""
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=self._explore_side_effect(),
        ):
            loop = ExecutionLoop()
            data = await loop._explore(
                task="test",
                working_dir="/tmp",
                context={},
                cli_path="/usr/bin/claude",
            )

        assert data["codebase_state"] == "disciplined"
        assert isinstance(data["relevant_patterns"], list)

    # ── _plan returns structured data ─────────────────────────────────────────

    async def test_plan_returns_structured_data(self, _patch_auth):
        """_plan should parse JSON and return files_to_create / complexity."""
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=self._plan_side_effect(),
        ):
            loop = ExecutionLoop()
            data = await loop._plan(
                task="test",
                working_dir="/tmp",
                explore={"codebase_state": "disciplined", "relevant_patterns": [], "summary": ""},
                cli_path="/usr/bin/claude",
            )

        assert "files_to_create" in data
        assert data["complexity"] == "trivial"

    # ── _route returns a decision ─────────────────────────────────────────────

    async def test_route_returns_decision(self, _patch_auth):
        """_route decision must be one of the four valid routing choices."""
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=self._route_side_effect(),
        ):
            loop = ExecutionLoop()
            data = await loop._route(
                task="test",
                plan={"complexity": "trivial", "steps": [], "approach_summary": ""},
                cli_path="/usr/bin/claude",
            )

        assert data["decision"] in {"delegate", "execute", "ask", "challenge"}

    # ── _verify uses evidence module ──────────────────────────────────────────

    async def test_verify_uses_evidence_module(self, _patch_auth):
        """_verify must delegate to verify_implementation and reflect its result."""
        ok = VerificationResult(
            all_passed=True,
            evidence=[Evidence(check="file exists: foo.py", passed=True)],
            missing_files=[],
            failing_commands=[],
        )
        with patch(
            "openseed_guard.execution_loop.verify_implementation",
            new_callable=AsyncMock,
            return_value=ok,
        ) as mock_vi:
            loop = ExecutionLoop()
            result = await loop._verify(
                working_dir="/tmp",
                exec_result={"claimed_files": ["foo.py"], "test_commands": []},
                plan={"expected_test_commands": []},
            )

        mock_vi.assert_awaited_once()
        assert result["passed"] is True
        assert "1" in result["summary"]  # "All 1 checks passed."

    # ── _explore fallback when JSON is absent ─────────────────────────────────

    async def test_explore_fallback_on_non_json(self, _patch_auth):
        """When Claude returns plain text instead of JSON, _explore uses fallback dict."""
        with patch(
            "openseed_guard.execution_loop.run_streaming",
            side_effect=_make_streaming_side_effect("I cannot analyse this codebase right now."),
        ):
            loop = ExecutionLoop()
            data = await loop._explore(
                task="test",
                working_dir="/tmp",
                context={},
                cli_path="/usr/bin/claude",
            )

        # Fallback guarantees at least these keys
        assert "summary" in data
        assert "codebase_state" in data


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Delegation
# ═══════════════════════════════════════════════════════════════════════════════


class TestDelegation:
    """Tests for openseed_guard.delegation.build_delegation_prompt."""

    def test_build_delegation_prompt_has_all_sections(self):
        prompt = build_delegation_prompt(
            task="Write a REST endpoint",
            expected_outcome="A working /health endpoint returning 200",
            required_tools=["Read", "Edit"],
            must_do=["Follow existing patterns", "Add tests"],
            must_not=["Delete existing files", "Use API keys"],
            context="packages/api/src/routes.py — FastAPI router",
        )

        assert "## TASK" in prompt
        assert "## EXPECTED OUTCOME" in prompt
        assert "## REQUIRED TOOLS" in prompt
        assert "## MUST DO" in prompt
        assert "## MUST NOT DO" in prompt
        assert "## CONTEXT" in prompt

    def test_build_delegation_prompt_task_appears(self):
        prompt = build_delegation_prompt(
            task="Implement OAuth login",
            expected_outcome="Users can log in",
            required_tools=[],
            must_do=[],
            must_not=[],
            context="",
        )
        assert "Implement OAuth login" in prompt

    def test_build_delegation_prompt_tools_listed(self):
        prompt = build_delegation_prompt(
            task="T",
            expected_outcome="O",
            required_tools=["Bash", "Glob", "Grep"],
            must_do=[],
            must_not=[],
            context="",
        )
        assert "- Bash" in prompt
        assert "- Glob" in prompt
        assert "- Grep" in prompt

    def test_build_delegation_prompt_empty_lists_show_placeholder(self):
        """Empty lists should render readable placeholders, not crash."""
        prompt = build_delegation_prompt(
            task="T",
            expected_outcome="O",
            required_tools=[],
            must_do=[],
            must_not=[],
            context="no context",
        )
        assert "(all tools available)" in prompt or "- (" in prompt
        assert "(none specified)" in prompt

    def test_build_delegation_prompt_escapes_content(self):
        """Special characters in task / context survive rendering intact."""
        special = 'task with "quotes" and {braces} and \\backslash'
        prompt = build_delegation_prompt(
            task=special,
            expected_outcome="outcome",
            required_tools=[],
            must_do=[],
            must_not=[],
            context="ctx",
        )
        assert special in prompt

    def test_build_delegation_prompt_must_not_listed(self):
        prompt = build_delegation_prompt(
            task="T",
            expected_outcome="O",
            required_tools=[],
            must_do=["Do A"],
            must_not=["Never do B", "Never do C"],
            context="",
        )
        assert "Never do B" in prompt
        assert "Never do C" in prompt


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Backoff (pure logic)
# ═══════════════════════════════════════════════════════════════════════════════


class TestBackoff:
    """Tests for openseed_guard.backoff — pure functions, no mocking required."""

    def test_compute_backoff_initial(self):
        """0 failures → base delay (5000 ms by default)."""
        assert compute_backoff_ms(0) == 5_000

    def test_compute_backoff_exponential(self):
        """Each additional failure doubles the delay."""
        assert compute_backoff_ms(1) == 10_000
        assert compute_backoff_ms(2) == 20_000
        assert compute_backoff_ms(3) == 40_000

    def test_compute_backoff_cap(self):
        """Beyond cap_exponent the delay stops growing (max_ms boundary)."""
        # cap_exponent=5 → 5000 * 2^5 = 160_000
        at_cap = compute_backoff_ms(5)
        beyond_cap = compute_backoff_ms(99)
        assert at_cap == 160_000
        assert beyond_cap == 160_000

    def test_compute_backoff_custom_base(self):
        """Custom base_ms is respected."""
        assert compute_backoff_ms(0, base_ms=1_000) == 1_000
        assert compute_backoff_ms(2, base_ms=1_000) == 4_000

    def test_compute_backoff_custom_max(self):
        """max_ms clamps the result."""
        assert compute_backoff_ms(10, base_ms=5_000, cap_exponent=10, max_ms=30_000) == 30_000

    def test_should_retry_within_limit(self):
        """Returns True when consecutive_failures < max_retries."""
        assert should_retry(0, max_retries=10) is True
        assert should_retry(9, max_retries=10) is True

    def test_should_retry_exceeds_limit(self):
        """Returns False when consecutive_failures >= max_retries."""
        assert should_retry(10, max_retries=10) is False
        assert should_retry(99, max_retries=10) is False


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Stagnation (pure logic)
# ═══════════════════════════════════════════════════════════════════════════════


class TestStagnation:
    """Tests for openseed_guard.stagnation — pure functions."""

    def _update(self, stagnation_count: int) -> ProgressUpdate:
        return ProgressUpdate(
            has_progressed=stagnation_count == 0,
            progress_source="none" if stagnation_count > 0 else "todo",
            stagnation_count=stagnation_count,
        )

    def test_is_stagnated_below_threshold(self):
        assert is_stagnated(self._update(2), threshold=3) is False

    def test_is_stagnated_at_threshold(self):
        assert is_stagnated(self._update(3), threshold=3) is True

    def test_is_stagnated_above_threshold(self):
        assert is_stagnated(self._update(10), threshold=3) is True

    def test_is_stagnated_zero(self):
        assert is_stagnated(self._update(0), threshold=3) is False

    def test_stagnation_message_stagnated(self):
        msg = stagnation_message(self._update(4), threshold=3)
        assert "STAGNATED" in msg

    def test_stagnation_message_warning(self):
        msg = stagnation_message(self._update(2), threshold=3)
        assert "Warning" in msg

    def test_stagnation_message_progress(self):
        msg = stagnation_message(self._update(0), threshold=3)
        assert "progress" in msg.lower()


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Progress (pure logic)
# ═══════════════════════════════════════════════════════════════════════════════


class TestProgress:
    """Tests for openseed_guard.progress.ProgressTracker."""

    def test_first_call_is_baseline(self):
        """First track() call is always a baseline — not yet improvement."""
        tracker = ProgressTracker()
        snap = ProgressSnapshot(incomplete_count=5, completed_count=2)
        update = tracker.track(snap)
        assert update.progress_source == "baseline"
        assert update.stagnation_count == 0

    def test_progress_tracker_detects_improvement_via_completed(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(completed_count=2, incomplete_count=5))
        update = tracker.track(ProgressSnapshot(completed_count=4, incomplete_count=3))
        assert update.has_progressed is True
        assert update.progress_source == "todo"
        assert update.stagnation_count == 0

    def test_progress_tracker_detects_improvement_via_files_created(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(files_created=[]))
        update = tracker.track(ProgressSnapshot(files_created=["foo.py"]))
        assert update.has_progressed is True
        assert update.progress_source == "files"

    def test_progress_tracker_detects_improvement_via_tests(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(test_pass_count=0))
        update = tracker.track(ProgressSnapshot(test_pass_count=5))
        assert update.has_progressed is True
        assert update.progress_source == "tests"

    def test_progress_tracker_detects_improvement_via_error_reduction(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(error_count=10))
        update = tracker.track(ProgressSnapshot(error_count=5))
        assert update.has_progressed is True
        assert update.progress_source == "errors"

    def test_progress_tracker_detects_stagnation(self):
        tracker = ProgressTracker()
        snap = ProgressSnapshot(incomplete_count=5, completed_count=2)
        tracker.track(snap)         # baseline
        tracker.track(snap)         # stagnation 1
        tracker.track(snap)         # stagnation 2
        update = tracker.track(snap)  # stagnation 3
        assert update.has_progressed is False
        assert update.stagnation_count == 3

    def test_progress_tracker_resets_stagnation_on_improvement(self):
        tracker = ProgressTracker()
        snap = ProgressSnapshot(completed_count=0)
        tracker.track(snap)
        tracker.track(snap)  # stagnation 1
        # Now improve
        update = tracker.track(ProgressSnapshot(completed_count=1))
        assert update.has_progressed is True
        assert update.stagnation_count == 0

    def test_progress_tracker_state_hash_change_counts_as_progress(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(raw_hash="abc"))
        update = tracker.track(ProgressSnapshot(raw_hash="xyz"))
        assert update.has_progressed is True
        assert update.progress_source == "state"

    def test_progress_tracker_reset(self):
        tracker = ProgressTracker()
        tracker.track(ProgressSnapshot(completed_count=0))
        tracker.track(ProgressSnapshot(completed_count=0))  # stagnation 1
        tracker.reset()
        assert tracker.stagnation_count == 0
        # Next track should be fresh baseline
        update = tracker.track(ProgressSnapshot(completed_count=0))
        assert update.progress_source == "baseline"


# ═══════════════════════════════════════════════════════════════════════════════
# 7. evaluate_loop
# ═══════════════════════════════════════════════════════════════════════════════


class TestEvaluateLoop:
    """Tests for openseed_guard.loop.evaluate_loop."""

    # ── PASS: QA + verification both pass ────────────────────────────────────

    async def test_evaluate_loop_pass(self):
        qa = _make_qa_result(Verdict.PASS)
        vr = _make_verification(all_passed=True)
        state = LoopState()
        decision = await evaluate_loop(qa, vr, state)
        assert decision.action == "pass"

    # ── RETRY: QA fails, retries available, no stagnation ────────────────────

    async def test_evaluate_loop_retry(self):
        qa = _make_qa_result(Verdict.BLOCK, findings=[Finding(description="err")])
        vr = _make_verification(all_passed=False)
        state = LoopState(consecutive_failures=0)
        cfg = SentinelConfig(max_retries=5, stagnation_threshold=10)

        decision = await evaluate_loop(qa, vr, state, config=cfg)
        assert decision.action == "retry"
        assert decision.backoff_ms > 0

    # ── INSIGHT: stagnation threshold reached ─────────────────────────────────
    # evaluate_loop creates a fresh ProgressTracker per call; the first
    # tracker.track() always returns stagnation_count=0 (baseline). The only
    # way to force the stagnation branch is to mock is_stagnated directly.

    async def test_evaluate_loop_sage_on_stagnation(self):
        qa = _make_qa_result(Verdict.BLOCK, findings=[Finding(description="error")])
        vr = _make_verification(all_passed=False)
        state = LoopState(consecutive_failures=1)
        cfg = SentinelConfig(stagnation_threshold=3, insight_enabled=True, max_retries=10)

        insight_advice = InsightAdvice(
            diagnosis="root cause",
            suggested_approach="try something else",
            should_abandon=False,
        )

        with patch("openseed_guard.loop.is_stagnated", return_value=True), patch(
            "openseed_guard.loop.consult_insight",
            new_callable=AsyncMock,
            return_value=insight_advice,
        ):
            decision = await evaluate_loop(qa, vr, state, config=cfg, task="some task")

        # Insight was consulted → retry with its advice
        assert decision.action == "retry"
        assert decision.insight_advice is not None
        assert decision.insight_advice.suggested_approach == "try something else"

    # ── USER_ESCALATE: stagnated + insight already consulted ───────────────────

    async def test_evaluate_loop_user_escalate(self):
        qa = _make_qa_result(Verdict.BLOCK, findings=[Finding(description="error")])
        vr = _make_verification(all_passed=False)
        # Insight already consulted in a prior iteration
        state = LoopState(consecutive_failures=1, insight_consulted=True)
        cfg = SentinelConfig(stagnation_threshold=3, insight_enabled=True, max_retries=10)

        with patch("openseed_guard.loop.is_stagnated", return_value=True):
            decision = await evaluate_loop(qa, vr, state, config=cfg)

        assert decision.action == "user_escalate"

    # ── ABORT: max retries exhausted ─────────────────────────────────────────

    async def test_evaluate_loop_abort_on_max_retries(self):
        qa = _make_qa_result(Verdict.BLOCK, findings=[Finding(description="err")])
        vr = _make_verification(all_passed=False)
        cfg = SentinelConfig(max_retries=3, stagnation_threshold=100)
        # consecutive_failures equals max_retries → should_retry returns False
        state = LoopState(consecutive_failures=3)

        decision = await evaluate_loop(qa, vr, state, config=cfg)
        assert decision.action == "abort"
        assert "3" in decision.reason

    # ── PASS even without a VerificationResult (None) ────────────────────────

    async def test_evaluate_loop_pass_without_verification(self):
        qa = _make_qa_result(Verdict.PASS)
        state = LoopState()
        decision = await evaluate_loop(qa, None, state)
        assert decision.action == "pass"

    # ── ABORT: insight recommends abandonment ─────────────────────────────────

    async def test_evaluate_loop_abort_when_sage_says_abandon(self):
        qa = _make_qa_result(Verdict.BLOCK, findings=[Finding(description="fatal")])
        vr = _make_verification(all_passed=False)
        state = LoopState(consecutive_failures=0)
        cfg = SentinelConfig(stagnation_threshold=3, insight_enabled=True, max_retries=10)

        abandon_advice = InsightAdvice(
            diagnosis="impossible task",
            suggested_approach="give up",
            should_abandon=True,
            reason="The task cannot be completed with available tools.",
        )

        with patch("openseed_guard.loop.is_stagnated", return_value=True), patch(
            "openseed_guard.loop.consult_insight",
            new_callable=AsyncMock,
            return_value=abandon_advice,
        ):
            decision = await evaluate_loop(qa, vr, state, config=cfg, task="hopeless")

        assert decision.action == "abort"
        assert "abandon" in decision.reason.lower() or "Insight" in decision.reason


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Evidence helpers (integration-light, uses real filesystem)
# ═══════════════════════════════════════════════════════════════════════════════


class TestEvidenceVerifyFilesExist:
    """Tests for openseed_guard.evidence.verify_files_exist."""

    async def test_file_exists_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            fname = "hello.py"
            open(os.path.join(tmp, fname), "w").close()
            evidence = await verify_files_exist(tmp, [fname])
        assert len(evidence) == 1
        assert evidence[0].passed is True

    async def test_missing_file_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            evidence = await verify_files_exist(tmp, ["does_not_exist.py"])
        assert evidence[0].passed is False
        assert "MISSING" in evidence[0].detail

    async def test_multiple_files_mixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            open(os.path.join(tmp, "exists.py"), "w").close()
            evidence = await verify_files_exist(tmp, ["exists.py", "ghost.py"])
        passed = [e.passed for e in evidence]
        assert passed == [True, False]
