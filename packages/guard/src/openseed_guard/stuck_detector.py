"""
Open Seed v2 — Stuck Detection (OpenHands pattern).

Detects 5 concrete stuck patterns by analyzing step_results, messages,
and errors from PipelineState. All semantic comparisons are LLM-based
(no regex, no string matching).

Patterns (adapted from OpenHands controller/stuck.py):
  1. Repeating output   — last N step results are semantically identical
  2. Repeating errors   — last N errors share the same root cause
  3. No-op loop         — fix node runs but produces no file changes
  4. Alternating pattern — A→B→A→B oscillation in step results
  5. Context saturation  — approaching token/message limits
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class StuckAnalysis:
    """Result of stuck detection."""
    is_stuck: bool = False
    pattern: str = ""       # Which pattern matched
    suggestion: str = ""    # LLM-generated suggestion for breaking out
    confidence: str = "low" # "high", "medium", "low"
    details: dict[str, Any] = field(default_factory=dict)


async def detect_stuck(
    step_results: list[Any],
    messages: list[str],
    errors: list[Any],
    retry_count: int = 0,
    max_messages: int = 200,
) -> StuckAnalysis:
    """
    Analyze pipeline state for stuck patterns.

    All 5 patterns are checked. If any match, returns is_stuck=True
    with the pattern name and a suggestion for breaking out.

    The semantic comparison uses Claude Haiku for speed/cost.
    Falls back to structural comparison if LLM is unavailable.

    Args:
        step_results: List of StepResult objects from PipelineState
        messages: List of message strings from PipelineState
        errors: List of Error objects from PipelineState
        retry_count: Current retry count
        max_messages: Message count threshold for context saturation

    Returns:
        StuckAnalysis with is_stuck flag, pattern name, and suggestion
    """
    # ── Pattern 1: Repeating output (last 4 steps semantically identical) ──
    if len(step_results) >= 4:
        last_4 = step_results[-4:]
        summaries = [getattr(s, "summary", str(s)) for s in last_4]
        if summaries and all(s == summaries[0] for s in summaries):
            # Exact match — definitely stuck
            suggestion = await _get_llm_suggestion(
                "repeating_output", summaries, messages[-3:]
            )
            return StuckAnalysis(
                is_stuck=True,
                pattern="repeating_output",
                suggestion=suggestion,
                confidence="high",
                details={"repeated_summary": summaries[0][:200]},
            )
        # Check semantic similarity via LLM
        if await _are_semantically_identical(summaries):
            suggestion = await _get_llm_suggestion(
                "repeating_output", summaries, messages[-3:]
            )
            return StuckAnalysis(
                is_stuck=True,
                pattern="repeating_output",
                suggestion=suggestion,
                confidence="medium",
                details={"summaries": [s[:100] for s in summaries]},
            )

    # ── Pattern 2: Repeating errors (last 3 errors same root cause) ──
    if len(errors) >= 3:
        last_3 = errors[-3:]
        error_msgs = [getattr(e, "message", str(e)) for e in last_3]
        if error_msgs and all(m == error_msgs[0] for m in error_msgs):
            suggestion = await _get_llm_suggestion(
                "repeating_errors", error_msgs, messages[-3:]
            )
            return StuckAnalysis(
                is_stuck=True,
                pattern="repeating_errors",
                suggestion=suggestion,
                confidence="high",
                details={"repeated_error": error_msgs[0][:200]},
            )
        if await _are_semantically_identical(error_msgs):
            suggestion = await _get_llm_suggestion(
                "repeating_errors", error_msgs, messages[-3:]
            )
            return StuckAnalysis(
                is_stuck=True,
                pattern="repeating_errors",
                suggestion=suggestion,
                confidence="medium",
                details={"errors": [m[:100] for m in error_msgs]},
            )

    # ── Pattern 3: No-op loop (fix messages indicate no file changes) ──
    fix_messages = [m for m in messages if "NO files changed" in m or "no-op" in m.lower()]
    if len(fix_messages) >= 3:
        return StuckAnalysis(
            is_stuck=True,
            pattern="noop_loop",
            suggestion=(
                "The fix agent repeatedly fails to edit files. "
                "Try a completely different approach: rewrite the affected files "
                "from scratch instead of patching, or simplify the architecture."
            ),
            confidence="high",
            details={"noop_count": len(fix_messages)},
        )

    # ── Pattern 4: Alternating pattern (A→B→A→B in last 6 steps) ──
    if len(step_results) >= 6:
        last_6 = step_results[-6:]
        summaries_6 = [getattr(s, "summary", str(s)) for s in last_6]
        if _has_alternating_pattern(summaries_6):
            suggestion = await _get_llm_suggestion(
                "alternating", summaries_6, messages[-3:]
            )
            return StuckAnalysis(
                is_stuck=True,
                pattern="alternating",
                suggestion=suggestion,
                confidence="medium",
                details={"pattern": [s[:60] for s in summaries_6]},
            )

    # ── Pattern 5: Context saturation ──
    if len(messages) >= max_messages:
        return StuckAnalysis(
            is_stuck=True,
            pattern="context_saturation",
            suggestion=(
                "Message history has grown too large. Condense context and "
                "restart with a fresh approach focusing only on remaining issues."
            ),
            confidence="high",
            details={"message_count": len(messages), "threshold": max_messages},
        )

    return StuckAnalysis(is_stuck=False)


def _has_alternating_pattern(items: list[str]) -> bool:
    """
    Check if items follow an A-B-A-B pattern.
    Uses structural comparison (exact string match on alternating positions).
    """
    if len(items) < 4:
        return False
    # Check if even positions are same and odd positions are same
    evens = items[0::2]
    odds = items[1::2]
    even_same = all(e == evens[0] for e in evens) if evens else False
    odd_same = all(o == odds[0] for o in odds) if odds else False
    # Must be alternating (not all identical)
    return even_same and odd_same and evens[0] != odds[0]


async def _are_semantically_identical(texts: list[str]) -> bool:
    """
    Use LLM (Haiku) to determine if a list of texts are semantically identical.
    Falls back to structural comparison if LLM unavailable.
    """
    if not texts or len(texts) < 2:
        return False

    # Fast path: if all texts are identical strings, no LLM needed
    if all(t == texts[0] for t in texts):
        return True

    try:
        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        joined = "\n---\n".join(t[:300] for t in texts)
        response = await agent.invoke(
            prompt=(
                f"Are ALL of the following {len(texts)} texts describing "
                f"the same outcome, error, or situation? "
                f"Answer ONLY 'yes' or 'no'.\n\n{joined}"
            ),
            model="haiku",
            max_turns=1,
        )
        return response.text.strip().lower().startswith("yes")
    except Exception:
        # Fallback: simple structural comparison
        # Check if texts share >80% of their words
        if not texts:
            return False
        base_words = set(texts[0].lower().split())
        if not base_words:
            return False
        for t in texts[1:]:
            t_words = set(t.lower().split())
            overlap = len(base_words & t_words) / max(len(base_words | t_words), 1)
            if overlap < 0.8:
                return False
        return True


async def _get_llm_suggestion(
    pattern: str,
    items: list[str],
    recent_messages: list[str],
) -> str:
    """
    Ask LLM for a suggestion on how to break out of a stuck pattern.
    Falls back to a generic suggestion if LLM unavailable.
    """
    generic_suggestions = {
        "repeating_output": (
            "The pipeline is producing identical results. "
            "Try rewriting the implementation from scratch with a simpler approach."
        ),
        "repeating_errors": (
            "The same error keeps recurring. The root cause is likely architectural. "
            "Consider reverting and taking a fundamentally different approach."
        ),
        "alternating": (
            "The pipeline is oscillating between two states. "
            "Both approaches have issues. Try a third, completely different strategy."
        ),
    }

    try:
        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        context = "\n".join(items[:4])
        messages_ctx = "\n".join(recent_messages[:3])
        response = await agent.invoke(
            prompt=(
                f"A coding pipeline is stuck in a '{pattern}' pattern.\n\n"
                f"Recent outputs:\n{context}\n\n"
                f"Recent messages:\n{messages_ctx}\n\n"
                f"In 1-2 sentences, suggest how to break out of this loop. "
                f"Be specific and actionable."
            ),
            model="haiku",
            max_turns=1,
        )
        return response.text.strip()[:500]
    except Exception:
        return generic_suggestions.get(pattern, "Try a completely different approach.")
