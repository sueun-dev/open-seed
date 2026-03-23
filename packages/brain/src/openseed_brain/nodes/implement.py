"""
Implement node — Execute the plan by generating code via Claude.
"""

from __future__ import annotations

from openseed_brain.state import PipelineState, Implementation


async def implement_node(state: PipelineState) -> dict:
    """
    Execute the plan by writing actual code via Claude.
    """
    task = state["task"]
    working_dir = state["working_dir"]
    plan = state.get("plan")

    plan_text = ""
    if plan:
        plan_text = f"Summary: {plan.summary}\n"
        for t in plan.tasks:
            plan_text += f"- {t.id}: {t.description} (files: {', '.join(t.files)})\n"
        plan_text += "\nFiles to create:\n"
        for f in plan.file_manifest:
            plan_text += f"- {f.path}: {f.purpose}\n"

    from openseed_left_hand.agent import ClaudeAgent

    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Implement this plan. Write ALL files with COMPLETE code.

Task: {task}
Working directory: {working_dir}

Plan:
{plan_text}

Rules:
- Write EVERY file listed in the plan
- Each file must be COMPLETE and RUNNABLE
- No placeholders, no TODOs
- If package.json is needed, create it with all deps
- Run `npm install` after creating package.json if needed""",
        model="sonnet",
        working_dir=working_dir,
        allowed_tools=["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
        max_turns=10,
    )

    return {
        "implementation": Implementation(
            summary=response.text[:500],
            raw_output=response.text,
        ),
        "messages": [f"Implement: code generation complete ({len(response.text)} chars)"],
    }
