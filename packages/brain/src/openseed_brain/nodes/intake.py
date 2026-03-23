"""
Intake node — Analyze task, recall memories, classify intent.
REAL implementation — calls Claude + Memory recall.

Sets skip_planning=True when Claude determines the task is trivial (complexity:
simple/trivial with a single well-scoped change). All routing decisions are
made by the LLM — no regex, no hardcoded extension checks.
"""

from __future__ import annotations

import logging

from openseed_brain.state import PipelineState

logger = logging.getLogger(__name__)


async def intake_node(state: PipelineState) -> dict:
    """
    First node: recall memories + analyze task via Claude.
    1. Search memory for similar past tasks/failures
    2. Ask Claude to classify intent, complexity, and whether planning can be skipped
    3. Return analysis + recalled memories + skip_planning flag
    """
    task = state["task"]
    working_dir = state["working_dir"]

    # ── Step 1: Classify intent via Sentinel Intent Gate ──
    intent_info = ""
    try:
        from openseed_sentinel.intent_gate import classify_intent
        intent = await classify_intent(task)
        intent_info = (
            f"\nIntent classification: {intent.intent_type.value} "
            f"(confidence: {intent.confidence:.1f})\n"
            f"Suggested approach: {intent.suggested_approach}\n"
        )
    except Exception as exc:
        logger.debug("Intent gate unavailable, proceeding without it: %s", exc)

    # ── Step 2: Recall relevant memories ──
    memory_context = ""
    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures
        store = MemoryStore()
        await store.initialize()

        # Search for similar tasks (uses LLM reranking automatically)
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
    except Exception as exc:
        logger.debug("Memory unavailable, proceeding without it: %s", exc)

    # ── Step 3: Analyse task via Claude ──
    from openseed_left_hand.agent import ClaudeAgent
    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Analyze this task and classify it.

Task: {task}
Working directory: {working_dir}
{intent_info}{memory_context}

Respond with EXACTLY this structure (fill in each line):
INTENT: <build|fix|refactor|research>
COMPLEXITY: <simple|moderate|complex>
SKIP_PLANNING: <yes|no>
REQUIREMENTS:
- <requirement 1>
- <requirement 2>
APPROACH: <1-2 sentence approach>
LESSONS: <any relevant lessons from past experiences, or "none">

Rules for SKIP_PLANNING:
- yes ONLY when: complexity is simple AND the task is a single, clearly scoped change
  (e.g. fix one bug in one file, add one small function, update one config value)
- no for everything else: new features, multi-file changes, refactors, research tasks

Be concise. No extra prose outside the above structure.""",
        model="sonnet",
        max_turns=1,
    )

    analysis_text = response.text
    skip_planning = _parse_skip_planning(analysis_text)

    return {
        "skip_planning": skip_planning,
        "messages": [f"Intake: {analysis_text[:500]}"],
    }


def _parse_skip_planning(text: str) -> bool:
    """
    Extract the SKIP_PLANNING decision from Claude's structured response.

    Looks for the literal line 'SKIP_PLANNING: yes' (case-insensitive).
    Falls back to False (do full planning) if the line is absent or malformed.
    """
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SKIP_PLANNING:"):
            value = stripped.split(":", 1)[1].strip().lower()
            return value == "yes"
    return False
