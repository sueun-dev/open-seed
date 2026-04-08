"""
Tests for the WorkflowOrchestrator staged QA pipeline.

Covers:
- test_workflow_completes_all_stages
- test_workflow_stops_at_discovery_blocker
- test_workflow_stage_mapping
- test_finalize_combines_findings
- test_workflow_default_is_flat (backward compat)
- test_stage_result_dataclass
- test_workflow_result_dataclass
- test_workflow_verdict_block_on_critical
- test_workflow_skips_review_when_review_gate_closed
- test_finalize_deduplicates_findings
- test_workflow_no_agents_for_stage_continues
- test_workflow_gate_falls_back_on_llm_failure
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

from openseed_core.types import Finding, QAResult, Severity, Verdict
from openseed_qa_gate.types import AgentDefinition, SpecialistResult
from openseed_qa_gate.workflow import (
    _STAGE_CATEGORIES,
    StageResult,
    WorkflowOrchestrator,
    WorkflowResult,
    WorkflowStage,
)

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_finding(
    severity: Severity = Severity.LOW,
    title: str = "Test finding",
    file: str = "",
    line: int | None = None,
) -> Finding:
    return Finding(severity=severity, title=title, file=file, line=line)


def _make_stage_result(
    stage: WorkflowStage = WorkflowStage.DISCOVERY,
    findings: list[Finding] | None = None,
    should_continue: bool = True,
    reason: str = "",
) -> StageResult:
    return StageResult(
        stage=stage,
        findings=findings or [],
        should_continue=should_continue,
        reason=reason,
        duration_ms=10,
    )


def _make_subprocess_result(
    stdout: str,
    exit_code: int = 0,
    timed_out: bool = False,
    stderr: str = "",
) -> MagicMock:
    r = MagicMock()
    r.stdout = stdout
    r.stderr = stderr
    r.exit_code = exit_code
    r.timed_out = timed_out
    return r


def _make_config(block_on_critical: bool = True, max_parallel_agents: int = 4):
    cfg = MagicMock()
    cfg.block_on_critical = block_on_critical
    cfg.max_parallel_agents = max_parallel_agents
    cfg.agents_dir = "/fake/agents"
    return cfg


# ─── 1. WorkflowStage + StageResult + WorkflowResult dataclasses ──────────────


class TestWorkflowDataclasses:
    def test_stage_result_dataclass(self):
        """StageResult stores all fields with correct defaults."""
        sr = StageResult(stage=WorkflowStage.REVIEW)
        assert sr.stage == WorkflowStage.REVIEW
        assert sr.findings == []
        assert sr.should_continue is True
        assert sr.reason == ""
        assert sr.duration_ms == 0

    def test_workflow_result_dataclass(self):
        """WorkflowResult stores all fields."""
        wr = WorkflowResult(
            stages_completed=[WorkflowStage.DISCOVERY, WorkflowStage.REVIEW],
            all_findings=[_make_finding()],
            verdict="warn",
            synthesis="1 finding — warn",
            total_duration_ms=150,
        )
        assert wr.verdict == "warn"
        assert len(wr.all_findings) == 1
        assert WorkflowStage.DISCOVERY in wr.stages_completed
        assert wr.total_duration_ms == 150

    def test_workflow_stage_enum_values(self):
        """WorkflowStage enum values match expected strings."""
        assert WorkflowStage.DISCOVERY.value == "discovery"
        assert WorkflowStage.REVIEW.value == "review"
        assert WorkflowStage.VALIDATION.value == "validation"
        assert WorkflowStage.SYNTHESIS.value == "synthesis"


# ─── 2. Stage category mapping ────────────────────────────────────────────────


class TestWorkflowStageMapping:
    def test_workflow_stage_mapping(self):
        """Each stage maps to the correct agent categories."""
        assert "10-research-analysis" in _STAGE_CATEGORIES[WorkflowStage.DISCOVERY]
        assert "09-meta-orchestration" in _STAGE_CATEGORIES[WorkflowStage.DISCOVERY]

        assert "01-core-development" in _STAGE_CATEGORIES[WorkflowStage.REVIEW]
        assert "02-language-specialists" in _STAGE_CATEGORIES[WorkflowStage.REVIEW]
        assert "04-quality-security" in _STAGE_CATEGORIES[WorkflowStage.REVIEW]

        assert "04-quality-security" in _STAGE_CATEGORIES[WorkflowStage.VALIDATION]
        assert "03-infrastructure" in _STAGE_CATEGORIES[WorkflowStage.VALIDATION]

        assert "09-meta-orchestration" in _STAGE_CATEGORIES[WorkflowStage.SYNTHESIS]

    def test_all_four_stages_have_mappings(self):
        """All four workflow stages have at least one category mapped."""
        for stage in (
            WorkflowStage.DISCOVERY,
            WorkflowStage.REVIEW,
            WorkflowStage.VALIDATION,
            WorkflowStage.SYNTHESIS,
        ):
            assert len(_STAGE_CATEGORIES[stage]) >= 1, f"Stage {stage.value} has no category mappings"


# ─── 3. _finalize combines and deduplicates findings ─────────────────────────


class TestFinalize:
    def test_finalize_combines_findings(self):
        """_finalize merges findings from all stages into all_findings."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        import time

        start = time.monotonic()

        stage_results = [
            _make_stage_result(
                stage=WorkflowStage.DISCOVERY,
                findings=[_make_finding(title="A", severity=Severity.HIGH)],
            ),
            _make_stage_result(
                stage=WorkflowStage.REVIEW,
                findings=[_make_finding(title="B", severity=Severity.LOW)],
            ),
        ]

        result = orchestrator._finalize(stage_results, start)

        assert len(result.all_findings) == 2
        titles = {f.title for f in result.all_findings}
        assert "A" in titles
        assert "B" in titles

    def test_finalize_deduplicates_findings(self):
        """_finalize removes duplicate findings (same title+file+line) across stages."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        import time

        start = time.monotonic()

        dup = _make_finding(title="Dup finding", file="x.py", line=5, severity=Severity.MEDIUM)
        stage_results = [
            _make_stage_result(stage=WorkflowStage.DISCOVERY, findings=[dup]),
            _make_stage_result(stage=WorkflowStage.REVIEW, findings=[dup]),
        ]

        result = orchestrator._finalize(stage_results, start)

        titles = [f.title for f in result.all_findings]
        assert titles.count("Dup finding") == 1

    def test_finalize_verdict_block_on_critical(self):
        """_finalize returns block verdict when critical finding is present."""
        orchestrator = WorkflowOrchestrator(config=_make_config(block_on_critical=True))
        import time

        start = time.monotonic()

        stage_results = [
            _make_stage_result(
                stage=WorkflowStage.REVIEW,
                findings=[_make_finding(severity=Severity.CRITICAL, title="RCE")],
            )
        ]

        result = orchestrator._finalize(stage_results, start)

        assert result.verdict == "block"

    def test_finalize_verdict_warn_on_high(self):
        """High finding with block_on_critical=False → warn verdict."""
        orchestrator = WorkflowOrchestrator(config=_make_config(block_on_critical=False))
        import time

        start = time.monotonic()

        stage_results = [
            _make_stage_result(
                stage=WorkflowStage.REVIEW,
                findings=[_make_finding(severity=Severity.HIGH, title="High issue")],
            )
        ]

        result = orchestrator._finalize(stage_results, start)
        assert result.verdict == "warn"

    def test_finalize_verdict_pass_on_low(self):
        """Only low/info findings → pass verdict."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        import time

        start = time.monotonic()

        stage_results = [
            _make_stage_result(
                stage=WorkflowStage.DISCOVERY,
                findings=[_make_finding(severity=Severity.INFO, title="FYI")],
            )
        ]

        result = orchestrator._finalize(stage_results, start)
        assert result.verdict == "pass"

    def test_finalize_synthesis_contains_stage_names(self):
        """_finalize synthesis text mentions the completed stages."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        import time

        start = time.monotonic()

        stage_results = [
            _make_stage_result(stage=WorkflowStage.DISCOVERY),
            _make_stage_result(stage=WorkflowStage.REVIEW),
        ]

        result = orchestrator._finalize(stage_results, start)

        assert "discovery" in result.synthesis
        assert "review" in result.synthesis


# ─── 4. Full workflow runs ────────────────────────────────────────────────────


class TestWorkflowRun:
    async def test_workflow_completes_all_stages(self):
        """When every stage has go/no-go=True, all three non-synthesis stages run."""
        orchestrator = WorkflowOrchestrator(config=_make_config())

        async def fake_run_stage(stage, context, working_dir, task):
            return _make_stage_result(stage=stage, should_continue=True)

        with patch.object(orchestrator, "_run_stage", side_effect=fake_run_stage):
            result = await orchestrator.run("context", "/tmp", "task")

        assert WorkflowStage.DISCOVERY in result.stages_completed
        assert WorkflowStage.REVIEW in result.stages_completed
        assert WorkflowStage.VALIDATION in result.stages_completed
        # Total stages = 3 (SYNTHESIS is folded into _finalize, not a stage call)
        assert len(result.stages_completed) == 3

    async def test_workflow_stops_at_discovery_blocker(self):
        """When DISCOVERY gate closes (should_continue=False), REVIEW and VALIDATION are skipped."""
        orchestrator = WorkflowOrchestrator(config=_make_config())

        async def fake_run_stage(stage, context, working_dir, task):
            if stage == WorkflowStage.DISCOVERY:
                return _make_stage_result(
                    stage=stage,
                    findings=[_make_finding(severity=Severity.CRITICAL)],
                    should_continue=False,
                    reason="Build broken — skipping",
                )
            return _make_stage_result(stage=stage, should_continue=True)

        with patch.object(orchestrator, "_run_stage", side_effect=fake_run_stage) as mock_run:
            result = await orchestrator.run("context", "/tmp", "task")

        # Only DISCOVERY ran
        assert result.stages_completed == [WorkflowStage.DISCOVERY]
        # _run_stage was called exactly once
        mock_run.assert_called_once()

    async def test_workflow_skips_review_when_review_gate_closed(self):
        """When REVIEW gate closes, VALIDATION is skipped but DISCOVERY ran."""
        orchestrator = WorkflowOrchestrator(config=_make_config())

        async def fake_run_stage(stage, context, working_dir, task):
            if stage == WorkflowStage.REVIEW:
                return _make_stage_result(
                    stage=stage,
                    should_continue=False,
                    reason="Critical issues in review",
                )
            return _make_stage_result(stage=stage, should_continue=True)

        with patch.object(orchestrator, "_run_stage", side_effect=fake_run_stage):
            result = await orchestrator.run("context", "/tmp", "task")

        assert WorkflowStage.DISCOVERY in result.stages_completed
        assert WorkflowStage.REVIEW in result.stages_completed
        assert WorkflowStage.VALIDATION not in result.stages_completed

    async def test_workflow_verdict_block_on_critical(self):
        """Critical finding in a stage produces a 'block' verdict in the workflow result."""
        orchestrator = WorkflowOrchestrator(config=_make_config(block_on_critical=True))

        async def fake_run_stage(stage, context, working_dir, task):
            findings = [_make_finding(severity=Severity.CRITICAL, title="RCE")] if stage == WorkflowStage.REVIEW else []
            return _make_stage_result(stage=stage, findings=findings, should_continue=True)

        with patch.object(orchestrator, "_run_stage", side_effect=fake_run_stage):
            result = await orchestrator.run("context", "/tmp", "task")

        assert result.verdict == "block"


# ─── 5. Backward compatibility (staged=False uses flat mode) ──────────────────


class TestWorkflowDefaultIsFlat:
    async def test_workflow_default_is_flat(self):
        """run_qa_gate without staged=True uses the flat (non-orchestrated) path."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        agent = AgentDefinition(name="reviewer", description="Review agent")
        sr = SpecialistResult(agent_name="reviewer", findings=[], success=True)

        with (
            patch("openseed_qa_gate.gate.load_active_agents", return_value=[agent]),
            patch("openseed_qa_gate.gate.select_agents", new_callable=AsyncMock, return_value=[agent]),
            patch("openseed_qa_gate.gate.run_specialist", new_callable=AsyncMock, return_value=sr),
            patch("openseed_qa_gate.gate.synthesize", new_callable=AsyncMock, return_value=([], "no issues", None)),
            patch("openseed_qa_gate.gate._run_staged", new_callable=AsyncMock) as mock_staged,
        ):
            cfg = QAGateConfig(active_agents=["reviewer"])
            await run_qa_gate("context", "/tmp", config=cfg)  # staged defaults to False

        mock_staged.assert_not_called()

    async def test_workflow_staged_true_calls_orchestrator(self):
        """run_qa_gate with staged=True delegates to _run_staged."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        expected_result = QAResult(
            verdict=Verdict.PASS,
            findings=[],
            agents_run=["discovery"],
            synthesis="Staged run OK",
            duration_ms=42,
        )

        with patch(
            "openseed_qa_gate.gate._run_staged", new_callable=AsyncMock, return_value=expected_result
        ) as mock_staged:
            cfg = QAGateConfig()
            result = await run_qa_gate("context", "/tmp", config=cfg, staged=True)

        mock_staged.assert_called_once()
        assert result is expected_result


# ─── 6. Gate LLM decision ─────────────────────────────────────────────────────


class TestEvaluateGate:
    async def test_gate_falls_back_on_llm_failure(self):
        """When the LLM gate call raises, the gate defaults to continue=True."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        findings = [_make_finding(severity=Severity.CRITICAL)]

        with patch.object(
            orchestrator,
            "_llm_gate_decision",
            new_callable=AsyncMock,
            side_effect=RuntimeError("LLM unavailable"),
        ):
            should_continue, reason = await orchestrator._evaluate_gate(WorkflowStage.DISCOVERY, findings)

        assert should_continue is True
        assert "default" in reason.lower() or "fail" in reason.lower()

    async def test_gate_continues_when_no_critical_findings(self):
        """Gate always continues if there are no CRITICAL findings (no LLM call needed)."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        findings = [
            _make_finding(severity=Severity.HIGH),
            _make_finding(severity=Severity.MEDIUM),
        ]

        with patch.object(
            orchestrator,
            "_llm_gate_decision",
            new_callable=AsyncMock,
        ) as mock_llm:
            should_continue, _ = await orchestrator._evaluate_gate(WorkflowStage.DISCOVERY, findings)

        mock_llm.assert_not_called()
        assert should_continue is True

    async def test_gate_llm_decision_parses_response(self):
        """_llm_gate_decision correctly parses Claude's JSON response."""
        orchestrator = WorkflowOrchestrator(config=_make_config())
        findings = [_make_finding(severity=Severity.CRITICAL)]

        gate_response = json.dumps({"continue": False, "reason": "Build is broken"})
        mock_proc = _make_subprocess_result(stdout=gate_response)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            should_continue, reason = await orchestrator._llm_gate_decision(WorkflowStage.DISCOVERY, findings)

        assert should_continue is False
        assert "broken" in reason.lower()

    async def test_workflow_no_agents_for_stage_continues(self):
        """A stage with no agents produces an empty StageResult with should_continue=True."""
        orchestrator = WorkflowOrchestrator(config=_make_config())

        with patch.object(orchestrator, "_select_agents_for_stage", return_value=[]):
            result = await orchestrator._run_stage(WorkflowStage.DISCOVERY, "ctx", "/tmp", "task")

        assert result.stage == WorkflowStage.DISCOVERY
        assert result.findings == []
        assert result.should_continue is True
