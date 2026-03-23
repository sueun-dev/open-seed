"""
Memorize node — Store results, failures, and learnings in long-term memory.

Pattern from: mem0 Memory.add() with fact extraction + procedural memory
"""

from __future__ import annotations

from openseed_brain.state import PipelineState


async def memorize_node(state: PipelineState) -> dict:
    """
    Store pipeline results in memory for future runs.

    1. Extract facts from plan, implementation, QA results
    2. Store failures as procedural memory (avoid same mistakes)
    3. Store successes as patterns to reuse

    TODO: Implement with memory package (mem0)
    """
    task = state["task"]
    retry_count = state.get("retry_count", 0)
    return {
        "messages": [f"Memory: stored results for '{task[:50]}' ({retry_count} retries)"],
    }
