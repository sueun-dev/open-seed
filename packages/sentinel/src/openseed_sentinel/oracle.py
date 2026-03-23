"""
Open Seed v2 — Oracle escalation.

When Sentinel is stuck after multiple retries, Oracle provides
high-reasoning analysis of what's going wrong and suggests
a completely different approach.

Pattern from: OmO oracle.ts — read-only, high-reasoning advisor
"""

from __future__ import annotations

from dataclasses import dataclass

from openseed_core.events import EventBus, EventType


@dataclass
class OracleAdvice:
    """Advice from the Oracle."""
    diagnosis: str = ""
    suggested_approach: str = ""
    should_abandon: bool = False
    reason: str = ""


async def consult_oracle(
    task: str,
    failure_history: list[str],
    current_errors: list[str],
    event_bus: EventBus | None = None,
) -> OracleAdvice:
    """
    Consult the Oracle for guidance when stuck.

    The Oracle uses Claude Opus with extended thinking to deeply
    analyze the failure pattern and suggest a different approach.

    Args:
        task: Original user task
        failure_history: List of previous attempt summaries
        current_errors: Current unresolved errors
        event_bus: For streaming

    Returns:
        OracleAdvice with diagnosis and suggestion
    """
    if event_bus:
        await event_bus.emit_simple(
            EventType.SENTINEL_ESCALATE,
            node="sentinel",
            escalation="oracle",
            retry_count=len(failure_history),
        )

    from openseed_left_hand.agent import ClaudeAgent

    agent = ClaudeAgent(event_bus=event_bus)

    prompt = f"""You are the Oracle — a last-resort advisor.

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
        system_prompt="You are an oracle. Analyze deeply. Be creative. Think outside the box. Output valid JSON.",
        allowed_tools=["Read", "Grep", "Glob"],  # Read-only
    )

    # Parse response
    import json
    try:
        start = response.text.find("{")
        end = response.text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(response.text[start:end + 1])
            return OracleAdvice(**data)
    except (json.JSONDecodeError, TypeError):
        pass

    return OracleAdvice(
        diagnosis=response.text[:500],
        suggested_approach="Unable to parse structured advice. Raw analysis above.",
    )
