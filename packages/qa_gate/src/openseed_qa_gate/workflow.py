"""
Workflow orchestrator — staged QA execution.
Pattern from: awesome-codex-subagents workflow-orchestrator.

Stages:
1. DISCOVERY  — context gathering, codebase exploration
2. REVIEW     — implementation-focused specialist review
3. VALIDATION — integration tests, edge cases, security
4. SYNTHESIS  — merge all findings, resolve conflicts, verdict

Each stage runs a subset of agents selected for that purpose.
Go/no-go gates between stages (if discovery finds blockers, skip to synthesis).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from openseed_core.types import Finding, Severity

logger = logging.getLogger(__name__)


class WorkflowStage(str, Enum):
    DISCOVERY = "discovery"
    REVIEW = "review"
    VALIDATION = "validation"
    SYNTHESIS = "synthesis"


# Map each stage to the agent categories it draws from.
# DISCOVERY → research-analysis, meta-orchestration
# REVIEW    → core-development, language-specialists, quality-security
# VALIDATION → quality-security, infrastructure
# SYNTHESIS  → meta-orchestration (knowledge-synthesizer)
_STAGE_CATEGORIES: dict[WorkflowStage, list[str]] = {
    WorkflowStage.DISCOVERY: [
        "10-research-analysis",
        "09-meta-orchestration",
    ],
    WorkflowStage.REVIEW: [
        "01-core-development",
        "02-language-specialists",
        "04-quality-security",
    ],
    WorkflowStage.VALIDATION: [
        "04-quality-security",
        "03-infrastructure",
    ],
    WorkflowStage.SYNTHESIS: [
        "09-meta-orchestration",
    ],
}


@dataclass
class StageResult:
    """Outcome of a single workflow stage."""

    stage: WorkflowStage
    findings: list[Finding] = field(default_factory=list)
    should_continue: bool = True  # go/no-go gate — False means stop here
    reason: str = ""
    duration_ms: int = 0


@dataclass
class WorkflowResult:
    """Aggregated outcome of the full staged workflow."""

    stages_completed: list[WorkflowStage]
    all_findings: list[Finding]
    verdict: str  # "pass" | "warn" | "block"
    synthesis: str
    total_duration_ms: int = 0


class WorkflowOrchestrator:
    """
    Staged QA workflow execution.

    Runs four stages (DISCOVERY → REVIEW → VALIDATION → SYNTHESIS) with
    go/no-go gates between stages powered by Claude Haiku.  SYNTHESIS
    always runs regardless of earlier gate decisions so there is always a
    coherent final verdict.

    Usage::

        orchestrator = WorkflowOrchestrator(config=cfg, event_bus=bus)
        result = await orchestrator.run(context, working_dir, task)
    """

    def __init__(self, config=None, event_bus=None):
        self._config = config
        self._event_bus = event_bus

    # ─── Public API ───────────────────────────────────────────────────────────

    async def run(
        self,
        context: str,
        working_dir: str,
        task: str = "",
    ) -> WorkflowResult:
        """Run the full staged workflow and return a WorkflowResult."""
        total_start = time.monotonic()
        stage_results: list[StageResult] = []

        # Stage 1: DISCOVERY
        discovery = await self._run_stage(
            WorkflowStage.DISCOVERY, context, working_dir, task
        )
        stage_results.append(discovery)

        if not discovery.should_continue:
            logger.info(
                "Workflow: DISCOVERY gate closed — %s. Skipping to synthesis.",
                discovery.reason,
            )
            return self._finalize(stage_results, total_start)

        # Stage 2: REVIEW
        review = await self._run_stage(
            WorkflowStage.REVIEW, context, working_dir, task
        )
        stage_results.append(review)

        if not review.should_continue:
            logger.info(
                "Workflow: REVIEW gate closed — %s. Skipping to synthesis.",
                review.reason,
            )
            return self._finalize(stage_results, total_start)

        # Stage 3: VALIDATION
        validation = await self._run_stage(
            WorkflowStage.VALIDATION, context, working_dir, task
        )
        stage_results.append(validation)

        # Stage 4: SYNTHESIS always runs
        return self._finalize(stage_results, total_start)

    # ─── Internal stage runner ────────────────────────────────────────────────

    async def _run_stage(
        self,
        stage: WorkflowStage,
        context: str,
        working_dir: str,
        task: str,
    ) -> StageResult:
        """
        Run a single stage:
        1. Select agents for this stage using its category mapping.
        2. Run agents in parallel (bounded by config.max_parallel_agents).
        3. Collect findings.
        4. Ask Claude Haiku whether to continue (go/no-go gate).
        """
        stage_start = time.monotonic()
        logger.info("Workflow: starting stage %s", stage.value)

        agents = self._select_agents_for_stage(stage)

        if not agents:
            logger.info("Workflow: no agents available for stage %s", stage.value)
            return StageResult(
                stage=stage,
                findings=[],
                should_continue=True,
                reason="No agents for this stage",
                duration_ms=0,
            )

        # Run agents in parallel
        findings = await self._run_agents(agents, context, working_dir)

        # Go/no-go gate (SYNTHESIS never gates itself)
        should_continue, reason = await self._evaluate_gate(stage, findings)

        duration_ms = int((time.monotonic() - stage_start) * 1000)
        logger.info(
            "Workflow: stage %s finished in %dms — %d findings, continue=%s",
            stage.value,
            duration_ms,
            len(findings),
            should_continue,
        )

        return StageResult(
            stage=stage,
            findings=findings,
            should_continue=should_continue,
            reason=reason,
            duration_ms=duration_ms,
        )

    def _select_agents_for_stage(self, stage: WorkflowStage) -> list[Any]:
        """
        Return agents belonging to this stage's categories.

        Loads from the config agents_dir using load_all_categories, then
        filters to only the categories mapped to this stage.  Falls back
        gracefully to an empty list if categories or dir are unavailable.
        """
        from openseed_qa_gate.categories import AgentCategory, load_all_categories

        if self._config is None:
            return []

        try:
            agents_dir = Path(self._config.agents_dir)
            all_categories = load_all_categories(agents_dir)
        except Exception as exc:
            logger.warning("Workflow: could not load categories: %s", exc)
            return []

        target_dirs = _STAGE_CATEGORIES.get(stage, [])
        collected: list[Any] = []
        seen: set[str] = set()

        for category in AgentCategory:
            if category.value not in target_dirs:
                continue
            cat_info = all_categories.get(category)
            if cat_info is None:
                continue
            for agent in cat_info.agents:
                if agent.name not in seen:
                    collected.append(agent)
                    seen.add(agent.name)

        return collected

    async def _run_agents(
        self,
        agents: list[Any],
        context: str,
        working_dir: str,
    ) -> list[Finding]:
        """Run agents in parallel and collect their findings."""
        from openseed_qa_gate.specialist import run_specialist
        from openseed_qa_gate.synthesizer import synthesize
        from openseed_qa_gate.types import SpecialistResult

        max_parallel = (
            self._config.max_parallel_agents if self._config else 6
        )
        semaphore = asyncio.Semaphore(max_parallel)

        async def run_one(agent):
            async with semaphore:
                return await run_specialist(agent, context, working_dir, self._event_bus)

        raw_results = await asyncio.gather(
            *[run_one(a) for a in agents],
            return_exceptions=True,
        )

        specialist_results: list[SpecialistResult] = []
        for r in raw_results:
            if isinstance(r, Exception):
                specialist_results.append(
                    SpecialistResult(
                        agent_name="unknown",
                        success=False,
                        error=str(r),
                    )
                )
            else:
                specialist_results.append(r)

        findings, _ = await synthesize(specialist_results, self._event_bus)
        return findings

    async def _evaluate_gate(
        self,
        stage: WorkflowStage,
        findings: list[Finding],
    ) -> tuple[bool, str]:
        """
        Ask Claude Haiku whether findings from this stage warrant stopping
        early (go/no-go gate).

        Returns (should_continue: bool, reason: str).
        Falls back to True (continue) if the LLM call fails.
        """
        # SYNTHESIS has no outgoing gate
        if stage == WorkflowStage.SYNTHESIS:
            return True, ""

        # No critical findings → always continue
        has_blocker = any(
            f.severity in (Severity.CRITICAL,) for f in findings
        )
        if not has_blocker:
            return True, "No blockers detected"

        # Ask Claude Haiku for a structured go/no-go decision
        try:
            return await self._llm_gate_decision(stage, findings)
        except Exception as exc:
            logger.warning(
                "Workflow: LLM gate for %s failed (%s), defaulting to continue",
                stage.value,
                exc,
            )
            return True, "Gate LLM failed — continuing by default"

    async def _llm_gate_decision(
        self,
        stage: WorkflowStage,
        findings: list[Finding],
    ) -> tuple[bool, str]:
        """
        Call Claude Haiku to decide whether to continue past *stage*.

        Returns (should_continue, reason).
        """
        from openseed_core.subprocess import run_streaming
        from openseed_core.auth.claude import require_claude_auth

        cli = require_claude_auth()

        # Build a compact findings summary for the prompt
        finding_lines = []
        for i, f in enumerate(findings[:20], 1):  # cap at 20 for prompt size
            finding_lines.append(
                f"{i}. [{f.severity.value.upper()}] {f.title}"
            )
        findings_text = "\n".join(finding_lines) if finding_lines else "None"

        prompt = f"""You are a QA workflow gate. The "{stage.value}" stage just completed.

FINDINGS FROM THIS STAGE:
{findings_text}

DECISION: Should the QA workflow CONTINUE to the next stage, or STOP and go straight to final synthesis?

Stop early if:
- There are CRITICAL blockers that make further review pointless (e.g., build broken, core architecture invalid)
- Continuing would waste time without adding signal

Continue if:
- Issues found are worth deeper investigation by subsequent stages
- No showstopper blockers were found

Output ONLY valid JSON, no markdown:
{{"continue": true, "reason": "one sentence explanation"}}"""

        cmd = [
            cli,
            "--print",
            "--dangerously-skip-permissions",
            "--model", "claude-sonnet-4-6",
            "--max-turns", "1",
            prompt,
        ]

        proc = await run_streaming(cmd, timeout_seconds=30)

        if proc.timed_out:
            raise RuntimeError("Claude gate decision timed out after 30s")
        if proc.exit_code != 0 and not proc.stdout.strip():
            raise RuntimeError(
                f"Claude gate decision failed (exit {proc.exit_code}): "
                f"{proc.stderr[:200]}"
            )

        raw = proc.stdout.strip()
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end <= start:
            raise RuntimeError(f"No JSON found in gate response: {raw[:200]}")

        data = json.loads(raw[start : end + 1])
        should_continue = bool(data.get("continue", True))
        reason = str(data.get("reason", ""))
        return should_continue, reason

    # ─── Finalization ─────────────────────────────────────────────────────────

    def _finalize(
        self,
        stage_results: list[StageResult],
        total_start: float,
    ) -> WorkflowResult:
        """
        Combine all stage findings, determine verdict, produce synthesis text.

        Called after all stages have run (or after an early stop).
        """
        stages_completed = [r.stage for r in stage_results]

        # Flatten all findings across stages, deduplicate by title+file+line
        all_findings: list[Finding] = []
        seen_keys: set[str] = set()
        for sr in stage_results:
            for f in sr.findings:
                key = f"{f.title}:{f.file}:{f.line}"
                if key not in seen_keys:
                    all_findings.append(f)
                    seen_keys.add(key)

        # Determine verdict
        severity_order = {
            Severity.CRITICAL: 0,
            Severity.HIGH: 1,
            Severity.MEDIUM: 2,
            Severity.LOW: 3,
            Severity.INFO: 4,
        }
        all_findings.sort(key=lambda f: severity_order.get(f.severity, 5))

        has_critical = any(f.severity == Severity.CRITICAL for f in all_findings)
        has_high = any(f.severity == Severity.HIGH for f in all_findings)

        cfg_block = getattr(self._config, "block_on_critical", True)
        if has_critical and cfg_block:
            verdict = "block"
        elif has_critical or has_high:
            verdict = "warn"
        else:
            verdict = "pass"

        # Build synthesis text
        stages_run_str = ", ".join(s.value for s in stages_completed)
        counts: dict[str, int] = {}
        for f in all_findings:
            counts[f.severity.value] = counts.get(f.severity.value, 0) + 1

        counts_str = ", ".join(
            f"{sev}: {cnt}"
            for sev, cnt in sorted(
                counts.items(),
                key=lambda x: severity_order.get(Severity(x[0]), 5),
            )
        ) or "none"

        synthesis = (
            f"Staged workflow ({stages_run_str}) — "
            f"{len(all_findings)} findings [{counts_str}] — verdict: {verdict}"
        )

        total_duration_ms = int((time.monotonic() - total_start) * 1000)

        return WorkflowResult(
            stages_completed=stages_completed,
            all_findings=all_findings,
            verdict=verdict,
            synthesis=synthesis,
            total_duration_ms=total_duration_ms,
        )
