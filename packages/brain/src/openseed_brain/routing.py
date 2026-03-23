"""
Open Seed v2 — Conditional routing functions.

These are the "decision points" in the graph. Every routing decision
is based on pipeline state — NOT regex, NOT hardcoded rules.

Pattern from: LangGraph add_conditional_edges
"""

from __future__ import annotations

from typing import Literal

from openseed_brain.state import PipelineState
from openseed_core.types import Verdict


def route_after_qa(state: PipelineState) -> Literal["deploy", "fix", "end"]:
    """
    After QA + Sisyphus check, decide next step.

    - QA passed (verdict=PASS) → deploy
    - QA failed but retries left → fix
    - Retries exhausted → end (escalate to user)
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)
    max_retries = state.get("max_retries", 10)

    if qa_result and qa_result.verdict == Verdict.PASS:
        return "deploy"

    if retry_count < max_retries:
        return "fix"

    return "end"
