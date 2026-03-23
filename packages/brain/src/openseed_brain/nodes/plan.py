"""
Plan node — Generate implementation plan via Claude Opus.
"""

from __future__ import annotations

import json

from openseed_brain.state import PipelineState, Plan, PlanTask, FileEntry
from openseed_core.types import AgentProvider


async def plan_node(state: PipelineState) -> dict:
    """
    Generate a detailed implementation plan via Claude Opus.
    """
    task = state["task"]
    working_dir = state["working_dir"]
    intake = "\n".join(state.get("messages", []))

    from openseed_left_hand.agent import ClaudeAgent

    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Create an implementation plan for this task.

Task: {task}
Working directory: {working_dir}
Analysis: {intake[:500]}

Output valid JSON:
{{
  "summary": "one-line summary",
  "tasks": [
    {{"id": "T1", "description": "what to do", "role": "executor", "files": ["file.py"]}}
  ],
  "file_manifest": [
    {{"path": "file.py", "purpose": "what it does"}}
  ]
}}

Be specific. List every file to create.""",
        model="sonnet",
        max_turns=1,
    )

    # Parse plan from response
    plan = Plan(summary=f"Plan for: {task[:100]}")
    try:
        text = response.text
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(text[start:end + 1])
            plan.summary = data.get("summary", plan.summary)
            plan.tasks = [
                PlanTask(
                    id=t.get("id", f"T{i}"),
                    description=t.get("description", ""),
                    role=t.get("role", "executor"),
                    files=t.get("files", []),
                )
                for i, t in enumerate(data.get("tasks", []))
            ]
            plan.file_manifest = [
                FileEntry(path=f.get("path", ""), purpose=f.get("purpose", ""))
                for f in data.get("file_manifest", [])
            ]
    except (json.JSONDecodeError, TypeError):
        pass

    return {
        "plan": plan,
        "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
    }
