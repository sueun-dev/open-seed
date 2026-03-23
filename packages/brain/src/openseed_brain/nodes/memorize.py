"""
Memorize node — Store results and learnings in long-term memory.
REAL implementation — calls openseed_memory.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState


async def memorize_node(state: PipelineState) -> dict:
    """Store pipeline results in memory for future runs."""
    task = state["task"]
    retry_count = state.get("retry_count", 0)
    errors = state.get("errors", [])
    plan = state.get("plan")
    qa_result = state.get("qa_result")

    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import record_failure

        store = MemoryStore()
        await store.initialize()

        # Store task outcome
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

        return {
            "messages": [f"Memory: stored results ({outcome}, {retry_count} retries)"],
        }
    except Exception as e:
        return {
            "messages": [f"Memory: store failed — {e}"],
        }
