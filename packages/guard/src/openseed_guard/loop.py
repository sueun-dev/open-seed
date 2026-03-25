"""
Open Seed v2 — Sentinel main loop.

The infinite retry loop that guarantees zero errors.
Build → Test → Fail? → Fix → Retest. Until 0 errors. Never stops early.

Escalation chain:
  retry (backoff) → retry (different approach) → Insight → User
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from openseed_core.config import SentinelConfig
from openseed_core.events import EventBus, EventType
from openseed_core.types import QAResult, Verdict
from openseed_guard.backoff import compute_backoff_ms, should_retry
from openseed_guard.evidence import VerificationResult
from openseed_guard.execution_loop import ExecutionLoop, ExecutionResult
from openseed_guard.intent_gate import classify_intent
from openseed_guard.insight import InsightAdvice, consult_insight
from openseed_guard.progress import ProgressSnapshot, ProgressTracker
from openseed_guard.stagnation import is_stagnated


@dataclass
class LoopState:
    """Sentinel loop state."""
    retry_count: int = 0
    consecutive_failures: int = 0
    insight_consulted: bool = False
    insight_advice: InsightAdvice | None = None
    user_escalated: bool = False
    failure_history: list[str] = field(default_factory=list)


@dataclass
class LoopDecision:
    """What the Sentinel loop decides to do next."""
    action: str  # "retry", "insight", "user_escalate", "pass", "abort"
    reason: str
    backoff_ms: int = 0
    insight_advice: InsightAdvice | None = None


async def evaluate_loop(
    qa_result: QAResult,
    verification: VerificationResult | None,
    loop_state: LoopState,
    config: SentinelConfig | None = None,
    task: str = "",
    event_bus: EventBus | None = None,
) -> LoopDecision:
    """
    Evaluate whether to continue the Sentinel loop.

    Decision tree:
    1. QA passed + verification passed → PASS
    2. QA failed, retries left, not stagnated → RETRY (with backoff)
    3. Stagnated (3+ cycles no progress) → INSIGHT
    4. Insight consulted but still failing → USER_ESCALATE
    5. Max retries exhausted → ABORT

    Args:
        qa_result: Latest QA gate result
        verification: File/command verification result
        loop_state: Current loop state
        config: Sentinel configuration
        task: Original task (for Insight context)
        event_bus: For streaming events

    Returns:
        LoopDecision with next action
    """
    cfg = config or SentinelConfig()
    tracker = ProgressTracker()

    # 1. Check if we passed
    qa_passed = qa_result.verdict == Verdict.PASS
    verification_passed = verification.all_passed if verification else True

    if qa_passed and verification_passed:
        return LoopDecision(action="pass", reason="QA passed and all evidence verified")

    # Track progress
    snapshot = ProgressSnapshot(
        incomplete_count=len([f for f in qa_result.findings]),
        error_count=len([f for f in qa_result.findings]),
    )
    progress = tracker.track(snapshot)

    # 2. Check stagnation
    if is_stagnated(progress, cfg.stagnation_threshold):
        if event_bus:
            await event_bus.emit_simple(
                EventType.SENTINEL_STAGNATION,
                node="sentinel",
                stagnation_count=progress.stagnation_count,
            )

        # 3. Consult Insight if not already done
        if cfg.insight_enabled and not loop_state.insight_consulted:
            if event_bus:
                await event_bus.emit_simple(EventType.SENTINEL_ESCALATE, node="sentinel", escalation="insight")

            advice = await consult_insight(
                task=task,
                failure_history=loop_state.failure_history,
                current_errors=[f.description for f in qa_result.findings[:5]],
                event_bus=event_bus,
            )
            loop_state.insight_consulted = True
            loop_state.insight_advice = advice

            if advice.should_abandon:
                return LoopDecision(action="abort", reason=f"Insight recommends abandoning: {advice.reason}")

            return LoopDecision(
                action="retry",
                reason=f"Insight suggests new approach: {advice.suggested_approach[:200]}",
                insight_advice=advice,
            )

        # 4. User escalation
        return LoopDecision(
            action="user_escalate",
            reason=f"Stagnated for {progress.stagnation_count} cycles, Insight already consulted",
        )

    # 5. Check retry budget
    if not should_retry(loop_state.consecutive_failures, cfg.max_retries):
        return LoopDecision(action="abort", reason=f"Max retries ({cfg.max_retries}) exhausted")

    # 6. Retry with backoff
    backoff = compute_backoff_ms(
        loop_state.consecutive_failures,
        base_ms=cfg.backoff_base_ms,
        cap_exponent=cfg.backoff_cap_exponent,
        max_ms=cfg.backoff_max_ms,
    )

    if event_bus:
        await event_bus.emit_simple(
            EventType.SENTINEL_RETRY,
            node="sentinel",
            retry_count=loop_state.retry_count + 1,
            backoff_ms=backoff,
        )

    return LoopDecision(
        action="retry",
        reason=f"Retry {loop_state.retry_count + 1} (backoff {backoff}ms)",
        backoff_ms=backoff,
    )


async def run_sentinel(
    task: str,
    working_dir: str,
    config: SentinelConfig | None = None,
    event_bus: EventBus | None = None,
    codebase_context: str = "",
) -> ExecutionResult:
    """
    Full Sentinel pipeline: Intent Gate → Execution Loop → evaluate_loop fallback.

    1. Classify intent with Haiku (fast, cheap routing decision)
    2. Run the 7-step ExecutionLoop with intent context
    3. The loop handles: explore → plan → route → execute → verify → retry → done

    Args:
        task: The user task description.
        working_dir: Absolute path to the working directory.
        config: Optional Sentinel configuration (defaults used if None).
        event_bus: Optional event bus for real-time streaming.
        codebase_context: Optional codebase summary for better intent classification.

    Returns:
        ExecutionResult with success, summary, steps_completed, retry_count.
    """
    intent = await classify_intent(task, codebase_context=codebase_context)

    loop = ExecutionLoop(config=config or SentinelConfig(), event_bus=event_bus)

    return await loop.run(
        task=task,
        working_dir=working_dir,
        context={"intent": intent},
    )
