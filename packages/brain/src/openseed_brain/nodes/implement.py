"""
Implement node — Dispatch code generation to Claude and/or Codex.

Pattern from: LangGraph Send() for parallel + Codex multi-agent spawn
"""

from __future__ import annotations

from openseed_brain.state import PipelineState, Implementation


async def implement_node(state: PipelineState) -> dict:
    """
    Execute the plan by generating code.

    1. Read plan from state
    2. For architecture tasks → left_hand (Claude Opus)
    3. For implementation tasks → right_hand (Codex, parallel)
    4. Return Implementation with files created/modified

    TODO: Implement with left_hand + right_hand agents
    """
    plan = state.get("plan")
    summary = plan.summary if plan else "No plan"
    return {
        "implementation": Implementation(summary=f"Implemented: {summary}"),
        "messages": ["Implement: code generation complete"],
    }
