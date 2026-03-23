"""
Open Seed v2 — QA Gate.

Spawns specialist reviewers in parallel, synthesizes results,
produces verdict. Blocks pipeline if critical issues found.

Pattern from: awesome-codex-subagents parallel QA + knowledge-synthesizer
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from openseed_core.config import QAGateConfig
from openseed_core.events import EventBus, EventType
from openseed_core.types import Finding, QAResult, Severity, Verdict
from openseed_qa_gate.agent_loader import load_active_agents
from openseed_qa_gate.specialist import run_specialist
from openseed_qa_gate.synthesizer import synthesize
from openseed_qa_gate.types import AgentDefinition


async def run_qa_gate(
    context: str,
    working_dir: str,
    config: QAGateConfig | None = None,
    event_bus: EventBus | None = None,
) -> QAResult:
    """
    Run the full QA gate.

    1. Load active TOML agent definitions
    2. Spawn each agent in parallel (bounded concurrency)
    3. Collect all specialist results
    4. Synthesize findings via knowledge-synthesizer
    5. Produce verdict: PASS / WARN / BLOCK

    Args:
        context: Code/diff/files to review
        working_dir: Project directory
        config: QA gate configuration
        event_bus: For streaming events

    Returns:
        QAResult with verdict and findings
    """
    cfg = config or QAGateConfig()
    start = time.monotonic()

    # Load agent definitions
    agents = load_active_agents(Path(cfg.agents_dir), cfg.active_agents)

    if not agents:
        return QAResult(
            verdict=Verdict.WARN,
            synthesis="No QA agents loaded",
            agents_run=[],
        )

    # Run all agents in parallel
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

    # Synthesize
    findings, synthesis = await synthesize(specialist_results, event_bus)

    # Determine verdict — AI decides severity, we just check thresholds
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
