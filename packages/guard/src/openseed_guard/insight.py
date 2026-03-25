"""
Open Seed v2 — Insight escalation.

When Sentinel is stuck after multiple retries, Insight provides
deep analysis of what's going wrong and suggests a completely
different approach.

Read-only, deep-thinking advisor — never executes, only diagnoses
and recommends.
"""

from __future__ import annotations

from dataclasses import dataclass

from openseed_core.events import EventBus, EventType


@dataclass
class InsightAdvice:
    """Deep diagnosis and alternative strategy from Insight."""
    diagnosis: str = ""
    suggested_approach: str = ""
    should_abandon: bool = False
    reason: str = ""


async def consult_insight(
    task: str,
    failure_history: list[str],
    current_errors: list[str],
    event_bus: EventBus | None = None,
) -> InsightAdvice:
    """
    Consult Insight for guidance when stuck.

    Uses Claude Opus with extended thinking to deeply analyze
    the failure pattern and suggest a different approach.

    Args:
        task: Original user task
        failure_history: List of previous attempt summaries
        current_errors: Current unresolved errors
        event_bus: For streaming

    Returns:
        InsightAdvice with diagnosis and suggestion
    """
    if event_bus:
        await event_bus.emit_simple(
            EventType.SENTINEL_ESCALATE,
            node="sentinel",
            escalation="insight",
            retry_count=len(failure_history),
        )

    from openseed_claude.agent import ClaudeAgent

    agent = ClaudeAgent(event_bus=event_bus)

    prompt = f"""You are Insight — the deep-thinking advisor for the Open Seed pipeline.

## Original Task
{task}

## Failure History ({len(failure_history)} attempts)
{chr(10).join(f"Attempt {i+1}: {h}" for i, h in enumerate(failure_history[-5:]))}

## Current Errors
{chr(10).join(f"- {e}" for e in current_errors[:10])}

## Your Job
1. Diagnose WHY previous attempts keep failing (root cause, not symptoms)
2. Suggest a COMPLETELY DIFFERENT approach (not tweaking the same strategy)
3. If this task is fundamentally impossible or blocked, say so honestly

Output JSON:
{{"diagnosis": "root cause analysis", "suggested_approach": "new strategy", "should_abandon": false, "reason": "why"}}"""

    response = await agent.invoke(
        prompt=prompt,
        model="opus",
        system_prompt="You are Insight. Analyze deeply. Be creative. Think outside the box. Output valid JSON.",
        allowed_tools=["Read", "Grep", "Glob"],  # Read-only
    )

    # Parse response
    import json
    try:
        start = response.text.find("{")
        end = response.text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(response.text[start:end + 1])
            return InsightAdvice(**data)
    except (json.JSONDecodeError, TypeError):
        pass

    return InsightAdvice(
        diagnosis=response.text[:500],
        suggested_approach="Unable to parse structured advice. Raw analysis above.",
    )
