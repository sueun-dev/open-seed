"""
Plan node — Generate implementation plan via Claude Opus.

Pattern from: Subagents task-distributor TOML + LangGraph Send() parallel
"""

from __future__ import annotations

from openseed_brain.state import PipelineState, Plan


async def plan_node(state: PipelineState) -> dict:
    """
    Generate a detailed implementation plan.

    1. Send task + memories to Claude Opus
    2. Receive: file manifest, task breakdown, architecture decisions
    3. Return Plan object

    TODO: Implement with left_hand (Claude Opus)
    """
    task = state["task"]
    return {
        "plan": Plan(summary=f"Plan for: {task[:100]}"),
        "messages": ["Plan: generated implementation plan"],
    }
