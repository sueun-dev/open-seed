"""
Intake node — Analyze task, classify intent, recall memories.
Calls Claude Opus for deep analysis.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState
from openseed_core.events import EventBus, EventType


async def intake_node(state: PipelineState) -> dict:
    """
    First node: analyze the task via Claude.
    1. Ask Claude to classify intent, complexity, requirements
    2. Return analysis as messages
    """
    task = state["task"]
    working_dir = state["working_dir"]

    from openseed_left_hand.agent import ClaudeAgent

    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Analyze this task and classify it:

Task: {task}
Working directory: {working_dir}

Output a brief analysis:
1. Intent type (build/fix/refactor/research)
2. Complexity (simple/moderate/complex)
3. Key requirements (bullet list)
4. Suggested approach (1-2 sentences)

Be concise. No more than 10 lines.""",
        model="sonnet",
        max_turns=1,
    )

    return {
        "messages": [f"Intake: {response.text[:500]}"],
    }
