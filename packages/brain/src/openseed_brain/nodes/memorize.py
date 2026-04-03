"""
Memorize node — Store results and learnings in long-term memory.

Two storage paths:
1. Task outcome + failure patterns (existing)
2. Structured wisdom extraction (conventions, successes, failures, gotchas, commands)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openseed_brain.state import PipelineState


async def memorize_node(state: PipelineState) -> dict:
    """Store pipeline results and extract wisdom for future runs."""
    task = state["task"]
    retry_count = state.get("retry_count", 0)
    errors = state.get("errors", [])
    plan = state.get("plan")
    qa_result = state.get("qa_result")
    intake_raw = state.get("intake_analysis") or {}
    intake = intake_raw if isinstance(intake_raw, dict) else {}

    try:
        from openseed_memory.failure import record_failure
        from openseed_memory.store import MemoryStore

        store = MemoryStore()
        await store.initialize()

        # ── 1. Store task outcome (existing behavior) ──
        outcome = "success" if not errors else f"completed with {len(errors)} errors"
        summary = f"Task: {task[:200]}\nOutcome: {outcome}\nRetries: {retry_count}"
        if plan:
            summary += f"\nPlan: {plan.summary}"
            summary += f"\nFiles: {', '.join(f.path for f in plan.file_manifest)}"
        if qa_result:
            summary += f"\nQA: {qa_result.verdict.value} — {qa_result.synthesis}"

        await store.add(content=summary, user_id="system", agent_id="pipeline")

        # Record failures for learning
        if errors:
            await record_failure(
                store=store,
                task=task,
                errors=[e.message for e in errors[:10]],
                attempted_fixes=[],
                successful_fix="" if errors else "all resolved",
            )

        # ── 2. Extract and store structured wisdom ──
        wisdom_msg = ""
        try:
            from openseed_memory.wisdom import extract_wisdom, store_wisdom

            tech_stack = intake.get("tech_stack", "")
            wisdom = await extract_wisdom(
                task=task,
                plan_summary=plan.summary if plan else "",
                qa_synthesis=qa_result.synthesis if qa_result else "",
                retry_count=retry_count,
                errors=[e.message for e in errors[:5]],
                tech_stack=tech_stack,
            )

            total = (
                len(wisdom.conventions)
                + len(wisdom.successes)
                + len(wisdom.failures)
                + len(wisdom.gotchas)
                + len(wisdom.commands)
            )
            if total > 0:
                await store_wisdom(store, task, wisdom, tech_stack=tech_stack)
                wisdom_msg = f", {total} wisdom items"
        except Exception:
            pass  # Wisdom extraction is best-effort

        return {
            "messages": [f"Memory: stored results ({outcome}, {retry_count} retries{wisdom_msg})"],
        }
    except Exception as e:
        return {
            "messages": [f"Memory: store failed — {e}"],
        }
