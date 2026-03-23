"""
Open Seed v2 — QA Gate.

Spawns specialist reviewers in parallel, synthesizes results,
produces verdict. Blocks pipeline if critical issues found.

Pattern from: awesome-codex-subagents parallel QA + knowledge-synthesizer
              + agent-organizer (LLM-based agent selection)
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from openseed_core.config import QAGateConfig
from openseed_core.events import EventBus, EventType
from openseed_core.types import Finding, QAResult, Severity, Verdict
from openseed_qa_gate.agent_loader import load_active_agents
from openseed_qa_gate.agent_selector import select_agents
from openseed_qa_gate.specialist import run_specialist
from openseed_qa_gate.synthesizer import synthesize
from openseed_qa_gate.types import AgentDefinition

logger = logging.getLogger(__name__)


async def run_qa_gate(
    context: str,
    working_dir: str,
    config: QAGateConfig | None = None,
    event_bus: EventBus | None = None,
    staged: bool = False,
) -> QAResult:
    """
    Run the full QA gate.

    When *staged=False* (default), the flat mode runs:
    1. Load active TOML agent definitions
    2. Use LLM (Claude Haiku) to select the most relevant agents for this task
    3. Spawn each selected agent in parallel (bounded concurrency)
    4. Collect all specialist results
    5. Synthesize findings via knowledge-synthesizer (Claude Sonnet)
    6. Produce verdict: PASS / WARN / BLOCK

    When *staged=True*, the workflow orchestrator runs four ordered stages
    (DISCOVERY → REVIEW → VALIDATION → SYNTHESIS) with LLM-driven go/no-go
    gates between each stage.

    Args:
        context: Code/diff/files to review (also used as task description for selection)
        working_dir: Project directory
        config: QA gate configuration
        event_bus: For streaming events
        staged: If True, use WorkflowOrchestrator (staged pipeline).
                If False (default), use flat parallel execution.

    Returns:
        QAResult with verdict and findings
    """
    cfg = config or QAGateConfig()

    if staged:
        return await _run_staged(context, working_dir, cfg, event_bus)

    start = time.monotonic()

    # Load all active agent definitions from TOML
    all_active_agents = load_active_agents(Path(cfg.agents_dir), cfg.active_agents)

    if not all_active_agents:
        return QAResult(
            verdict=Verdict.WARN,
            synthesis="No QA agents loaded",
            agents_run=[],
        )

    # LLM-based agent selection — pick the subset most relevant to this task
    # Falls back to all active_agents if selection fails
    task_summary = context[:500] if context else ""
    agents = await _select_agents_for_task(
        task=context,
        implementation_summary=task_summary,
        all_agents=all_active_agents,
        max_agents=cfg.max_parallel_agents,
        event_bus=event_bus,
    )

    # Run selected agents in parallel
    semaphore = asyncio.Semaphore(cfg.max_parallel_agents)

    async def run_one(agent: AgentDefinition):
        async with semaphore:
            return await run_specialist(agent, context, working_dir, event_bus)

    results = await asyncio.gather(
        *[run_one(agent) for agent in agents],
        return_exceptions=True,
    )

    # Collect successful results
    specialist_results = []
    for r in results:
        if isinstance(r, Exception):
            from openseed_qa_gate.types import SpecialistResult
            specialist_results.append(SpecialistResult(
                agent_name="unknown",
                success=False,
                error=str(r),
            ))
        else:
            specialist_results.append(r)

    # Synthesize via knowledge-synthesizer (Claude Sonnet)
    findings, synthesis = await synthesize(specialist_results, event_bus)

    # Determine verdict — AI decides severity, we check thresholds
    verdict = _determine_verdict(findings, cfg.block_on_critical)

    duration = int((time.monotonic() - start) * 1000)

    if event_bus:
        await event_bus.emit_simple(
            EventType.QA_VERDICT,
            node="qa_gate",
            verdict=verdict.value,
            findings_count=len(findings),
            duration_ms=duration,
        )

    return QAResult(
        verdict=verdict,
        findings=findings,
        agents_run=[a.name for a in agents],
        synthesis=synthesis,
        duration_ms=duration,
    )


async def _select_agents_for_task(
    task: str,
    implementation_summary: str,
    all_agents: list[AgentDefinition],
    max_agents: int,
    event_bus: EventBus | None,
) -> list[AgentDefinition]:
    """
    Call select_agents() and log results. Falls back gracefully.

    Emits a QA_AGENTS_SELECTED event if event_bus is provided.
    """
    selected = await select_agents(
        task=task,
        implementation_summary=implementation_summary,
        available_agents=all_agents,
        max_agents=max_agents,
    )

    # Determine if LLM selection actually narrowed things down
    llm_selected = len(selected) < len(all_agents)

    if llm_selected:
        logger.info(
            "QA gate: LLM selected %d/%d agents: %s",
            len(selected),
            len(all_agents),
            [a.name for a in selected],
        )
    else:
        logger.info(
            "QA gate: using all %d agents (LLM selection returned full set or fell back)",
            len(selected),
        )

    if event_bus:
        try:
            await event_bus.emit_simple(
                EventType.QA_AGENTS_SELECTED,
                node="qa_gate",
                selected=[a.name for a in selected],
                total_available=len(all_agents),
                llm_selected=llm_selected,
            )
        except Exception:
            pass  # Event bus failures must not block QA

    return selected


async def _run_staged(
    context: str,
    working_dir: str,
    config: QAGateConfig,
    event_bus: EventBus | None,
) -> QAResult:
    """
    Delegate to WorkflowOrchestrator and convert WorkflowResult → QAResult.
    """
    from openseed_qa_gate.workflow import WorkflowOrchestrator

    orchestrator = WorkflowOrchestrator(config=config, event_bus=event_bus)
    workflow_result = await orchestrator.run(
        context=context,
        working_dir=working_dir,
        task=context[:500],
    )

    # Map workflow verdict string to Verdict enum
    verdict_map = {
        "pass": Verdict.PASS,
        "warn": Verdict.WARN,
        "block": Verdict.BLOCK,
    }
    verdict = verdict_map.get(workflow_result.verdict.lower(), Verdict.WARN)

    # Agents run = stages completed (as a summary)
    stages_run = [s.value for s in workflow_result.stages_completed]

    if event_bus:
        try:
            from openseed_core.events import EventType
            await event_bus.emit_simple(
                EventType.QA_VERDICT,
                node="qa_gate",
                verdict=verdict.value,
                findings_count=len(workflow_result.all_findings),
                duration_ms=workflow_result.total_duration_ms,
                staged=True,
            )
        except Exception:
            pass

    return QAResult(
        verdict=verdict,
        findings=workflow_result.all_findings,
        agents_run=stages_run,
        synthesis=workflow_result.synthesis,
        duration_ms=workflow_result.total_duration_ms,
    )


def _determine_verdict(findings: list[Finding], block_on_critical: bool) -> Verdict:
    """
    Determine QA verdict based on findings.

    BLOCK if any critical finding (when block_on_critical=True)
    WARN if any high/medium findings
    PASS if no findings or only low/info
    """
    has_critical = any(f.severity == Severity.CRITICAL for f in findings)
    has_high = any(f.severity == Severity.HIGH for f in findings)

    if has_critical and block_on_critical:
        return Verdict.BLOCK
    if has_critical or has_high:
        return Verdict.WARN
    return Verdict.PASS
