"""
Intake node — Parse task, recall memories, classify intent.

Pattern from: OmO Sisyphus Phase 0 Intent Gate
All classification by LLM, no regex.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState


async def intake_node(state: PipelineState) -> dict:
    """
    First node: analyze the task, recall relevant memories.

    1. Query Memory for similar past tasks/failures
    2. Ask LLM to classify intent and complexity
    3. Return relevant_memories + messages

    TODO: Implement with left_hand (Claude) for intent analysis
    """
    task = state["task"]
    return {
        "messages": [f"Intake: received task '{task[:100]}'"],
    }
