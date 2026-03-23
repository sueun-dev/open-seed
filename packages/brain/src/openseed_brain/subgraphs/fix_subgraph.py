"""
Fix subgraph — encapsulates the diagnose → fix → verify cycle as a LangGraph subgraph.

Nodes:
1. diagnose  — LLM analyses errors and produces a structured repair plan
2. fix       — applies the fix (delegates to ClaudeAgent)
3. verify    — evidence-based check that the fix landed correctly

Usage in the parent graph:
    fix_sub = build_fix_subgraph().compile()
    parent.add_node("fix", fix_sub)
"""

from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class FixSubState(TypedDict):
    """State schema for the Fix subgraph."""
    # Inputs (set by parent before entering subgraph)
    task: str
    working_dir: str
    errors: list[str]

    # Set by diagnose node
    repair_plan: str

    # Set by fix node
    fix_applied: str

    # Set by verify node
    verified: bool
    verify_summary: str


# ── Node implementations ──────────────────────────────────────────────────────


async def diagnose_node(state: FixSubState) -> dict:
    """
    Analyse the errors and produce a structured repair plan via LLM.
    Uses Claude Haiku for fast triage.
    """
    from openseed_left_hand.agent import ClaudeAgent

    task = state.get("task", "")
    working_dir = state.get("working_dir", "")
    errors = state.get("errors", [])

    errors_text = "\n".join(f"- {e}" for e in errors[:10]) if errors else "No specific errors reported."

    agent = ClaudeAgent()
    prompt = f"""Analyse the following errors for the project at {working_dir} and produce a concise repair plan.

TASK: {task}

ERRORS:
{errors_text}

Output a numbered list of concrete fixes. Each item must state:
1. Which file to change
2. What exactly to change and why

Be brief — this plan will be fed directly to an automated fix agent."""

    response = await agent.invoke(
        prompt=prompt,
        model="haiku",
        working_dir=working_dir,
        max_turns=1,
    )

    return {"repair_plan": response.text.strip()}


async def fix_node(state: FixSubState) -> dict:
    """
    Apply fixes according to the repair plan using ClaudeAgent (claude-sonnet).
    Mirrors the logic of openseed_brain.nodes.sisyphus.fix_node but is
    driven by the locally produced repair_plan rather than QA findings.
    """
    from openseed_left_hand.agent import ClaudeAgent

    task = state.get("task", "")
    working_dir = state.get("working_dir", "")
    repair_plan = state.get("repair_plan", "")
    errors = state.get("errors", [])

    errors_text = "\n".join(f"- {e}" for e in errors[:10]) if errors else "No specific errors."

    agent = ClaudeAgent()
    prompt = f"""Apply the following repair plan to the project at {working_dir}.

TASK: {task}

ORIGINAL ERRORS:
{errors_text}

REPAIR PLAN:
{repair_plan}

Rules:
- Read each file before modifying it
- Fix the ROOT CAUSE, not the symptom
- Write COMPLETE fixed files (no partial edits)
- Do NOT introduce new features — only fix what's broken
- After each fix, re-read the file to confirm the change landed"""

    response = await agent.invoke(
        prompt=prompt,
        model="sonnet",
        working_dir=working_dir,
        max_turns=5,
    )

    return {"fix_applied": response.text.strip()}


async def verify_node(state: FixSubState) -> dict:
    """
    Evidence-based verification that the fix was applied correctly.
    Uses openseed_sisyphus.evidence.verify_implementation when available;
    falls back to a lightweight file-existence check.
    """
    working_dir = state.get("working_dir", "")
    task = state.get("task", "")

    try:
        from openseed_sisyphus.evidence import verify_implementation

        result = await verify_implementation(
            working_dir=working_dir,
            expected_files=[],  # Subgraph does not know the manifest; broad check
        )
        passed = result.get("passed", False)
        summary = result.get("summary", "Verification complete")
    except Exception as exc:
        # Fallback: if sisyphus is unavailable, fail safe — don't assume success
        passed = False
        summary = f"Evidence check skipped ({exc}); verification unavailable"

    return {
        "verified": passed,
        "verify_summary": summary,
    }


# ── Graph builder ─────────────────────────────────────────────────────────────


def build_fix_subgraph() -> StateGraph:
    """
    Build the Fix cycle as a self-contained LangGraph subgraph.

    Usage in the parent graph:
        fix_sub = build_fix_subgraph().compile()
        parent.add_node("fix", fix_sub)

    The subgraph flow:
        START → diagnose → fix → verify → END
    """
    graph = StateGraph(FixSubState)

    graph.add_node("diagnose", diagnose_node)
    graph.add_node("fix", fix_node)
    graph.add_node("verify", verify_node)

    graph.add_edge(START, "diagnose")
    graph.add_edge("diagnose", "fix")
    graph.add_edge("fix", "verify")
    graph.add_edge("verify", END)

    return graph
