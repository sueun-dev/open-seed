"""
Intake node — Analyze task, recall memories, classify intent.
REAL implementation — calls Claude + Memory recall.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState


async def intake_node(state: PipelineState) -> dict:
    """
    First node: recall memories + analyze task via Claude.
    1. Search memory for similar past tasks/failures
    2. Ask Claude to classify intent and complexity
    3. Return analysis + recalled memories
    """
    task = state["task"]
    working_dir = state["working_dir"]

    # Recall relevant memories
    memory_context = ""
    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures
        store = MemoryStore()
        await store.initialize()

        # Search for similar tasks
        results = await store.search(task, limit=5)
        if results:
            memory_context += "\n\nRelevant past experiences:\n"
            for r in results:
                memory_context += f"- {r.entry.content[:200]} (score: {r.score:.2f})\n"

        # Check for known failure patterns
        patterns = await recall_similar_failures(store, task, [])
        if patterns:
            memory_context += "\nKnown failure patterns for similar tasks:\n"
            for p in patterns:
                memory_context += f"- {p.error_type[:200]} → fix: {p.successful_fix}\n"
    except Exception:
        pass  # Memory not available — proceed without it

    from openseed_left_hand.agent import ClaudeAgent
    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Analyze this task and classify it:

Task: {task}
Working directory: {working_dir}
{memory_context}

Output a brief analysis:
1. Intent type (build/fix/refactor/research)
2. Complexity (simple/moderate/complex)
3. Key requirements (bullet list)
4. Suggested approach (1-2 sentences)
5. Any relevant lessons from past experiences above

Be concise. No more than 15 lines.""",
        model="sonnet",
        max_turns=1,
    )

    return {
        "messages": [f"Intake: {response.text[:500]}"],
    }
