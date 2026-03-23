"""
Sisyphus node — Infinite retry loop until zero errors.

Pattern from: OmO todo-continuation-enforcer
- Progress tracking via actual state comparison
- Stagnation detection (3 cycles same state)
- Exponential backoff on failures
- Oracle escalation → user escalation
"""

from __future__ import annotations

from openseed_brain.state import PipelineState
from openseed_core.types import Verdict, Error, Severity


async def sisyphus_check_node(state: PipelineState) -> dict:
    """
    Check QA result and decide: pass, retry, or give up.

    1. Read qa_result verdict
    2. If PASS → route to deploy
    3. If FAIL → increment retry_count, route to fix
    4. If retries exhausted → escalate

    The routing decision is made by routing.route_after_qa.
    This node just updates the retry counter.
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)

    if qa_result and qa_result.verdict == Verdict.PASS:
        return {
            "messages": [f"Sisyphus: QA PASSED after {retry_count} retries"],
        }

    # QA failed — increment retry
    return {
        "retry_count": retry_count + 1,
        "messages": [f"Sisyphus: QA FAILED, retry {retry_count + 1}"],
    }


async def fix_node(state: PipelineState) -> dict:
    """
    Fix errors reported by QA gate.

    1. Read qa_result findings
    2. Ask Claude to diagnose and fix each finding
    3. Apply fixes
    4. Return updated implementation

    Loops back to qa_gate for re-verification.

    TODO: Implement with left_hand (Claude) + evidence-based verification
    """
    qa_result = state.get("qa_result")
    findings_count = len(qa_result.findings) if qa_result else 0
    return {
        "messages": [f"Fix: addressing {findings_count} findings (placeholder)"],
    }
