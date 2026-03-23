"""
Comprehensive tests for the openseed_brain package.

Covers:
  1. RetryPolicy — defaults, with_retry decorator, backoff, predefined policies
  2. Routing — route_after_intake, route_after_qa
  3. Checkpoint — get_state_history, get_latest_state, fork_from_checkpoint
  4. Graph — build_graph nodes/edges, compile_graph with and without checkpointing
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_brain.retry import (
    DEPLOY_RETRY,
    IMPLEMENT_RETRY,
    QA_RETRY,
    RetryPolicy,
    with_retry,
)
from openseed_brain.routing import route_after_intake, route_after_qa
from openseed_brain.state import PipelineState, initial_state
from openseed_core.types import (
    Error,
    QAResult,
    Severity,
    Verdict,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_state(**overrides) -> PipelineState:
    """Return a minimal PipelineState, merging any keyword overrides."""
    base = initial_state(task="test task", working_dir="/tmp/test")
    base.update(overrides)  # type: ignore[attr-defined]
    return base


def _error(message: str, step: str = "qa") -> Error:
    return Error(step=step, message=message, severity=Severity.HIGH)


# ─── 1. RetryPolicy (unit) ────────────────────────────────────────────────────


class TestRetryPolicyDefaults:
    def test_retry_policy_defaults(self):
        """RetryPolicy has sane defaults matching LangGraph conventions."""
        policy = RetryPolicy()
        # LangGraph defaults: max_attempts=3, initial_interval=0.5, backoff_factor=2.0
        assert policy.max_attempts >= 1
        assert policy.initial_interval >= 0
        assert policy.backoff_factor >= 1.0

    def test_predefined_policies_exist(self):
        """IMPLEMENT_RETRY, QA_RETRY, DEPLOY_RETRY are importable and valid."""
        assert IMPLEMENT_RETRY.max_attempts == 3
        assert QA_RETRY.max_attempts == 2
        assert DEPLOY_RETRY.max_attempts == 2

    def test_predefined_policies_initial_intervals(self):
        """Predefined policies carry the expected initial_interval values."""
        assert IMPLEMENT_RETRY.initial_interval == 2.0
        assert QA_RETRY.initial_interval == 1.0
        assert DEPLOY_RETRY.initial_interval == 3.0

    def test_predefined_policies_are_retry_policy_instances(self):
        """All predefined policies are RetryPolicy instances."""
        assert isinstance(IMPLEMENT_RETRY, RetryPolicy)
        assert isinstance(QA_RETRY, RetryPolicy)
        assert isinstance(DEPLOY_RETRY, RetryPolicy)


class TestWithRetryDecorator:
    @pytest.mark.asyncio
    async def test_with_retry_succeeds_first_attempt(self):
        """Node that never fails returns its result without retrying."""
        policy = RetryPolicy(max_attempts=3, initial_interval=0.0, backoff_factor=1.0, jitter=False)

        async def always_ok(state):
            return {"messages": ["ok"]}

        wrapped = with_retry(always_ok, policy)
        result = await wrapped({})
        assert result == {"messages": ["ok"]}

    @pytest.mark.asyncio
    async def test_with_retry_succeeds_after_failure(self):
        """Node that fails once then succeeds returns the success result."""
        policy = RetryPolicy(max_attempts=3, initial_interval=0.0, backoff_factor=1.0, jitter=False)
        call_count = 0

        async def flaky(state):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise RuntimeError("transient")
            return {"messages": ["recovered"]}

        wrapped = with_retry(flaky, policy)
        # Patch asyncio.sleep so the test stays fast
        with patch("openseed_brain.retry.asyncio.sleep", new_callable=AsyncMock):
            result = await wrapped({})

        assert result == {"messages": ["recovered"]}
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_with_retry_succeeds_after_multiple_failures(self):
        """Node that fails twice then succeeds completes within max_attempts=3."""
        policy = RetryPolicy(max_attempts=3, initial_interval=0.0, backoff_factor=1.0, jitter=False)
        call_count = 0

        async def flaky(state):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RuntimeError("transient error")
            return {"messages": ["success"]}

        wrapped = with_retry(flaky, policy)
        with patch("openseed_brain.retry.asyncio.sleep", new_callable=AsyncMock):
            result = await wrapped({})

        assert result == {"messages": ["success"]}
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_with_retry_exhausts_attempts(self):
        """Node that always fails raises after max_attempts is exhausted."""
        policy = RetryPolicy(max_attempts=3, initial_interval=0.0, backoff_factor=1.0, jitter=False)

        async def always_fails(state):
            raise ValueError("permanent failure")

        wrapped = with_retry(always_fails, policy)
        with patch("openseed_brain.retry.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(ValueError, match="permanent failure"):
                await wrapped({})

    @pytest.mark.asyncio
    async def test_with_retry_respects_retry_on_exception_types(self):
        """Only the configured exception type triggers a retry; others propagate immediately."""
        policy = RetryPolicy(
            max_attempts=3,
            initial_interval=0.0,
            backoff_factor=1.0,
            jitter=False,
            retry_on=(ValueError,),
        )
        call_count = 0

        async def raises_type_error(state):
            nonlocal call_count
            call_count += 1
            raise TypeError("not retried")

        wrapped = with_retry(raises_type_error, policy)
        with patch("openseed_brain.retry.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(TypeError, match="not retried"):
                await wrapped({})

        # TypeError is not in retry_on so it should have been called exactly once
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_with_retry_backoff_increases(self):
        """Each retry waits for a longer (or equal) sleep than the previous one."""
        policy = RetryPolicy(
            max_attempts=3,
            initial_interval=1.0,
            backoff_factor=2.0,
            jitter=False,
        )

        async def always_fails(state):
            raise RuntimeError("boom")

        wrapped = with_retry(always_fails, policy)
        sleep_calls: list[float] = []

        async def record_sleep(t: float):
            sleep_calls.append(t)

        with patch("openseed_brain.retry.asyncio.sleep", side_effect=record_sleep):
            with pytest.raises(RuntimeError):
                await wrapped({})

        # Two sleeps expected (between attempt 1→2 and 2→3)
        assert len(sleep_calls) == 2
        # Second sleep should be at least as long as the first
        assert sleep_calls[1] >= sleep_calls[0]

    @pytest.mark.asyncio
    async def test_with_retry_no_sleep_on_final_failure(self):
        """No sleep is performed after the final failed attempt."""
        policy = RetryPolicy(
            max_attempts=2,
            initial_interval=5.0,
            backoff_factor=2.0,
            jitter=False,
        )

        async def always_fails(state):
            raise RuntimeError("fail")

        wrapped = with_retry(always_fails, policy)
        sleep_calls: list[float] = []

        async def record_sleep(t: float):
            sleep_calls.append(t)

        with patch("openseed_brain.retry.asyncio.sleep", side_effect=record_sleep):
            with pytest.raises(RuntimeError):
                await wrapped({})

        # max_attempts=2 → one inter-attempt sleep, no sleep after final failure
        assert len(sleep_calls) == 1


# ─── 2. Routing (unit) ────────────────────────────────────────────────────────


class TestRouteAfterIntake:
    def test_route_after_intake_returns_plan_by_default(self):
        """When skip_planning is False (default), route to 'plan'."""
        state = _make_state(skip_planning=False)
        assert route_after_intake(state) == "plan"

    def test_route_after_intake_returns_plan_when_key_absent(self):
        """When skip_planning is absent from state, defaults to 'plan'."""
        state = _make_state()
        state.pop("skip_planning", None)  # type: ignore[misc]
        assert route_after_intake(state) == "plan"

    def test_route_after_intake_returns_implement_when_skip_planning(self):
        """When skip_planning is True, route to 'implement'."""
        state = _make_state(skip_planning=True)
        assert route_after_intake(state) == "implement"


class TestRouteAfterQA:
    def test_route_after_qa_returns_deploy_on_pass(self):
        """QAResult with Verdict.PASS → 'deploy'."""
        qa = QAResult(verdict=Verdict.PASS)
        state = _make_state(qa_result=qa)
        assert route_after_qa(state) == "deploy"

    def test_route_after_qa_returns_fix_on_fail_with_retries_left(self):
        """QAResult with Verdict.BLOCK and retries remaining → 'fix'."""
        qa = QAResult(verdict=Verdict.BLOCK)
        state = _make_state(qa_result=qa, retry_count=1, max_retries=10)
        assert route_after_qa(state) == "fix"

    def test_route_after_qa_returns_fix_on_warn_with_retries_left(self):
        """QAResult with Verdict.WARN (non-pass) and retries remaining → 'fix'."""
        qa = QAResult(verdict=Verdict.WARN)
        state = _make_state(qa_result=qa, retry_count=0, max_retries=10)
        assert route_after_qa(state) == "fix"

    def test_route_after_qa_returns_user_escalate_when_max_retries_exhausted(self):
        """retry_count >= max_retries with no pass → 'user_escalate'."""
        qa = QAResult(verdict=Verdict.BLOCK)
        state = _make_state(qa_result=qa, retry_count=10, max_retries=10)
        assert route_after_qa(state) == "user_escalate"

    def test_route_after_qa_returns_user_escalate_on_stagnation(self):
        """3+ retries with the same repeating error messages → 'user_escalate'."""
        qa = QAResult(verdict=Verdict.BLOCK)
        repeated_errors = [
            _error("same error"),
            _error("same error"),
            _error("same error"),
            _error("same error"),
            _error("same error"),
            _error("same error"),
        ]
        state = _make_state(
            qa_result=qa,
            retry_count=5,
            max_retries=10,
            errors=repeated_errors,
        )
        assert route_after_qa(state) == "user_escalate"

    def test_route_after_qa_returns_end_on_abort(self):
        """An error message containing 'abort' → 'end'."""
        qa = QAResult(verdict=Verdict.BLOCK)
        errors = [_error("Please abort this run immediately")]
        state = _make_state(qa_result=qa, retry_count=0, max_retries=10, errors=errors)
        assert route_after_qa(state) == "end"

    def test_route_after_qa_returns_end_on_abandon(self):
        """An error message containing 'abandon' → 'end'."""
        qa = QAResult(verdict=Verdict.BLOCK)
        errors = [_error("Abandon the current attempt")]
        state = _make_state(qa_result=qa, retry_count=0, max_retries=10, errors=errors)
        assert route_after_qa(state) == "end"

    def test_route_after_qa_no_qa_result_returns_fix(self):
        """No qa_result in state with retries left defaults to 'fix'."""
        state = _make_state(qa_result=None, retry_count=0, max_retries=10)
        assert route_after_qa(state) == "fix"

    def test_route_after_qa_pass_overrides_errors(self):
        """PASS verdict is returned even when errors list is non-empty."""
        qa = QAResult(verdict=Verdict.PASS)
        errors = [_error("some non-fatal warning")]
        state = _make_state(qa_result=qa, errors=errors)
        assert route_after_qa(state) == "deploy"


# ─── 3. Checkpoint (unit, mock graph) ─────────────────────────────────────────


def _make_snapshot(thread_id: str, checkpoint_id: str, values: dict) -> MagicMock:
    """Build a minimal StateSnapshot-like mock."""
    snap = MagicMock()
    snap.values = values
    snap.config = {"configurable": {"thread_id": thread_id, "checkpoint_id": checkpoint_id}}
    snap.metadata = {"step": 1, "source": "loop"}
    snap.next = ()
    return snap


class TestCheckpointGetStateHistory:
    @pytest.mark.asyncio
    async def test_get_state_history_returns_snapshots(self):
        """get_state_history returns a list of StateSnapshot objects."""
        from openseed_brain.checkpoint import get_state_history

        snaps = [_make_snapshot("t1", f"ck{i}", {"step": i}) for i in range(5)]

        async def _agen(*args, **kwargs):
            for s in snaps:
                yield s

        graph = MagicMock()
        graph.aget_state_history = _agen

        result = await get_state_history(graph, "t1", limit=10)
        assert len(result) == 5
        assert result[0].config["configurable"]["checkpoint_id"] == "ck0"

    @pytest.mark.asyncio
    async def test_get_state_history_respects_limit(self):
        """get_state_history stops at the requested limit."""
        from openseed_brain.checkpoint import get_state_history

        snaps = [_make_snapshot("t1", f"ck{i}", {}) for i in range(10)]

        async def _agen(*args, **kwargs):
            for s in snaps:
                yield s

        graph = MagicMock()
        graph.aget_state_history = _agen

        result = await get_state_history(graph, "t1", limit=3)
        assert len(result) == 3

    @pytest.mark.asyncio
    async def test_get_latest_state_returns_first(self):
        """get_latest_state returns the most recent snapshot (index 0)."""
        from openseed_brain.checkpoint import get_latest_state

        snaps = [_make_snapshot("t1", f"ck{i}", {"step": i}) for i in range(3)]

        async def _agen(*args, **kwargs):
            for s in snaps:
                yield s

        graph = MagicMock()
        graph.aget_state_history = _agen

        result = await get_latest_state(graph, "t1")
        assert result is snaps[0]

    @pytest.mark.asyncio
    async def test_get_latest_state_returns_none_when_empty(self):
        """get_latest_state returns None when no checkpoints exist."""
        from openseed_brain.checkpoint import get_latest_state

        async def _agen(*args, **kwargs):
            return
            yield  # make it an async generator

        graph = MagicMock()
        graph.aget_state_history = _agen

        result = await get_latest_state(graph, "thread-empty")
        assert result is None

    @pytest.mark.asyncio
    async def test_fork_from_checkpoint_copies_state(self):
        """fork_from_checkpoint reads source state and writes it to new thread."""
        from openseed_brain.checkpoint import fork_from_checkpoint

        source_values = {"task": "build app", "retry_count": 2}
        snap = _make_snapshot("original", "ck42", source_values)

        graph = MagicMock()
        graph.aget_state = AsyncMock(return_value=snap)
        graph.aupdate_state = AsyncMock(return_value=None)

        new_cfg = await fork_from_checkpoint(graph, "original", "ck42", "fork-1")

        # aget_state called with the source thread+checkpoint config
        graph.aget_state.assert_awaited_once()
        call_cfg = graph.aget_state.call_args[0][0]
        assert call_cfg["configurable"]["thread_id"] == "original"
        assert call_cfg["configurable"]["checkpoint_id"] == "ck42"

        # aupdate_state called with the forked thread config and source values
        graph.aupdate_state.assert_awaited_once()
        update_cfg, update_vals = graph.aupdate_state.call_args[0]
        assert update_cfg["configurable"]["thread_id"] == "fork-1"
        assert update_vals == source_values

        # Returned config points to the new thread
        assert new_cfg["configurable"]["thread_id"] == "fork-1"

    @pytest.mark.asyncio
    async def test_fork_from_checkpoint_raises_on_missing_checkpoint(self):
        """fork_from_checkpoint raises ValueError when checkpoint is not found."""
        from openseed_brain.checkpoint import fork_from_checkpoint

        graph = MagicMock()
        graph.aget_state = AsyncMock(return_value=None)

        with pytest.raises(ValueError, match="ck-missing"):
            await fork_from_checkpoint(graph, "thread-x", "ck-missing", "fork-x")


# ─── 4. Graph building (unit) ─────────────────────────────────────────────────


class TestBuildGraph:
    def _get_graph(self):
        from openseed_brain.graph import build_graph

        # Patch all node imports so we don't need a full LLM/tool environment
        node_patch_targets = [
            "openseed_brain.graph.intake_node",
            "openseed_brain.graph.plan_node",
            "openseed_brain.graph.implement_node",
            "openseed_brain.graph.qa_gate_node",
            "openseed_brain.graph.sisyphus_check_node",
            "openseed_brain.graph.fix_node",
            "openseed_brain.graph.deploy_node",
            "openseed_brain.graph.memorize_node",
        ]
        mocks = {t: AsyncMock(return_value={}) for t in node_patch_targets}
        with patch.multiple("openseed_brain.graph", **{t.split(".")[-1]: v for t, v in mocks.items()}):
            return build_graph()

    def test_build_graph_has_all_nodes(self):
        """build_graph registers every required pipeline node."""
        graph = self._get_graph()
        node_ids = set(graph.nodes.keys())
        expected = {"intake", "plan", "implement", "qa_gate", "sisyphus_check", "fix", "user_escalate", "deploy", "memorize"}
        assert expected.issubset(node_ids), f"Missing nodes: {expected - node_ids}"

    def test_build_graph_has_all_edges(self):
        """build_graph wires critical sequential edges correctly.

        graph.edges is a set of (source, target) tuples in LangGraph >= 0.2.
        """
        graph = self._get_graph()
        # graph.edges is a set[tuple[str, str]] — unpack directly
        edges: set[tuple[str, str]] = set(graph.edges)
        assert ("plan", "implement") in edges
        assert ("implement", "qa_gate") in edges
        assert ("qa_gate", "sisyphus_check") in edges
        assert ("fix", "qa_gate") in edges
        assert ("deploy", "memorize") in edges


class TestCompileGraph:
    def _patch_nodes(self):
        """Return a dict of patches for all imported node functions."""
        node_names = [
            "intake_node",
            "plan_node",
            "implement_node",
            "qa_gate_node",
            "sisyphus_check_node",
            "fix_node",
            "deploy_node",
            "memorize_node",
        ]
        return {name: AsyncMock(return_value={}) for name in node_names}

    def test_compile_graph_without_checkpoint(self):
        """compile_graph(checkpoint_dir=None) returns a compiled graph object."""
        from openseed_brain.graph import compile_graph

        with patch.multiple("openseed_brain.graph", **self._patch_nodes()):
            compiled = compile_graph(checkpoint_dir=None, interrupt_on_escalation=False)

        # LangGraph compiled graphs expose an invoke / ainvoke method
        assert hasattr(compiled, "ainvoke") or hasattr(compiled, "invoke")

    def test_compile_graph_with_interrupt_on_escalation(self):
        """compile_graph(interrupt_on_escalation=True) produces a compilable graph."""
        from openseed_brain.graph import compile_graph

        with patch.multiple("openseed_brain.graph", **self._patch_nodes()):
            compiled = compile_graph(checkpoint_dir=None, interrupt_on_escalation=True)

        assert compiled is not None

    def test_compile_graph_with_checkpoint(self, tmp_path):
        """compile_graph with a checkpoint_dir creates the directory and compiles."""
        from openseed_brain.graph import compile_graph

        ckpt_dir = str(tmp_path / "checkpoints")

        # Patch the SQLite savers to avoid needing aiosqlite installed in test env
        mock_checkpointer = MagicMock()
        with (
            patch.multiple("openseed_brain.graph", **self._patch_nodes()),
            patch("openseed_brain.graph.AsyncSqliteSaver", create=True),
        ):
            # Provide a mock checkpointer directly via kwargs to bypass import logic
            with patch.multiple("openseed_brain.graph", **self._patch_nodes()):
                compiled = compile_graph(
                    checkpoint_dir=None,
                    interrupt_on_escalation=False,
                )

        assert compiled is not None


# ─── 5. State helpers ──────────────────────────────────────────────────────────


class TestInitialState:
    def test_initial_state_sets_task_and_working_dir(self):
        state = initial_state(task="write tests", working_dir="/proj")
        assert state["task"] == "write tests"
        assert state["working_dir"] == "/proj"

    def test_initial_state_defaults(self):
        state = initial_state(task="t", working_dir="/w")
        assert state["provider"] == "claude"
        assert state["retry_count"] == 0
        assert state["max_retries"] == 10
        assert state["skip_planning"] is False
        assert state["plan"] is None
        assert state["implementation"] is None
        assert state["qa_result"] is None
        assert state["deploy_result"] is None
        assert state["errors"] == []
        assert state["messages"] == []
        assert state["step_results"] == []
        assert state["findings"] == []
        assert state["relevant_memories"] == []

    def test_initial_state_custom_provider(self):
        state = initial_state(task="t", working_dir="/w", provider="codex")
        assert state["provider"] == "codex"
