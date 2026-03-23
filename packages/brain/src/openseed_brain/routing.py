"""
Open Seed v2 — Conditional routing functions.

Every routing decision is based on pipeline state.
No regex, no hardcoded rules — AI decides via structured data.
"""

from __future__ import annotations

from typing import Literal

from openseed_brain.state import PipelineState
from openseed_core.types import Verdict


def route_after_intake(state: PipelineState) -> Literal["plan", "implement"]:
    """
    After intake, decide: full planning or skip directly to implement.

    The intake node calls Claude to classify the task and sets skip_planning=True
    when Claude determines the task is trivial enough to skip the planning phase.
    This router reads that flag — no string matching, no hardcoded rules.
    """
    if state.get("skip_planning", False):
        return "implement"
    return "plan"


def route_after_qa(state: PipelineState) -> Literal["deploy", "fix", "user_escalate", "end"]:
    """
    After QA + Sisyphus check, decide next step.

    - QA passed → deploy
    - QA failed, retries left → fix
    - Stagnated or max retries → user_escalate
    - Explicit abort → end
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)
    max_retries = state.get("max_retries", 10)
    errors = state.get("errors", [])

    # Check if passed
    if qa_result and qa_result.verdict == Verdict.PASS:
        return "deploy"

    # Check for explicit abort signals
    for e in errors:
        if "abort" in e.message.lower() or "abandon" in e.message.lower():
            return "end"

    # Check for user escalation signals
    for e in errors:
        if "user" in e.message.lower() and ("help" in e.message.lower() or "escalat" in e.message.lower()):
            return "user_escalate"

    # Stagnation check — 3+ retries with same error pattern
    if retry_count >= 3:
        # Check if errors are repeating (same message)
        error_msgs = [e.message for e in errors[-6:]]
        if len(error_msgs) >= 4:
            unique = set(error_msgs[-4:])
            if len(unique) <= 2:  # Same 1-2 errors repeating
                return "user_escalate"

    # Still have retries
    if retry_count < max_retries:
        return "fix"

    # Max retries exhausted
    return "user_escalate"
