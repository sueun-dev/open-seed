"""
Open Seed v2 — Conditional routing functions.

Every routing decision is based on pipeline state.
No regex, no hardcoded rules — AI decides via structured data.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from openseed_core.types import Verdict

if TYPE_CHECKING:
    from openseed_brain.state import PipelineState


def route_after_intake(state: PipelineState) -> Literal["plan", "implement"]:
    """
    After intake, decide: full planning or skip directly to implement.

    Skip planning when:
    - skip_planning=True (simple task, or pre-approved plan from frontend)
    - intake_analysis already has a plan (user approved it in the UI)
    """
    if state.get("skip_planning", False):
        return "implement"
    return "plan"


def route_after_qa(state: PipelineState) -> Literal["deploy", "fix", "user_escalate", "end"]:
    """
    After QA + Sentinel check, decide next step.

    - QA passed → deploy
    - QA failed, retries left → fix
    - Stagnated or max retries → user_escalate
    - Explicit abort → end
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)
    max_retries = state.get("max_retries", 10)
    errors = state.get("errors", [])

    # PASS or PASS_WITH_WARNINGS → always deploy
    if qa_result and qa_result.verdict in (Verdict.PASS, Verdict.PASS_WITH_WARNINGS):
        return "deploy"

    # WARN = "works but has issues"
    #   retry 0-1: Sonnet tries to fix
    #   retry 2-3: Opus tries to fix
    #   retry 4+:  deploy with warnings (remaining issues are cosmetic/unfixable)
    # BLOCK = "broken" → must fix (no early deploy)
    if qa_result and qa_result.verdict == Verdict.WARN:
        if retry_count >= 4:
            return "deploy"
        return "fix"

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
        error_msgs = [e.message for e in errors[-6:]]
        if len(error_msgs) >= 4:
            unique = set(error_msgs[-4:])
            if len(unique) <= 2:
                return "user_escalate"

    # Still have retries
    if retry_count < max_retries:
        return "fix"

    # Max retries exhausted
    return "user_escalate"
