"""
Plan node — Generate implementation plan via Claude Opus.
"""

from __future__ import annotations

import json

from openseed_brain.state import PipelineState, Plan, PlanTask, FileEntry


async def plan_node(state: PipelineState) -> dict:
    """
    Generate a detailed implementation plan via Claude Opus.
    """
    task = state["task"]
    working_dir = state["working_dir"]
    intake = "\n".join(state.get("messages", []))

    from openseed_claude.agent import ClaudeAgent

    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Create an implementation plan for this task.

Task: {task}
Working directory: {working_dir}
Analysis: {intake[:500]}

You MUST respond with ONLY valid JSON (no markdown, no explanation before/after):
{{
  "summary": "one-line summary of the plan",
  "tasks": [
    {{"id": "T1", "description": "Set up project with package.json and dependencies", "role": "infra", "files": ["package.json"]}},
    {{"id": "T2", "description": "Create Express API server with CRUD routes", "role": "backend", "files": ["server/index.js", "server/routes.js"]}},
    {{"id": "T3", "description": "Create React components for the UI", "role": "frontend", "files": ["src/App.jsx", "src/components/List.jsx"]}}
  ],
  "file_manifest": [
    {{"path": "package.json", "purpose": "Dependencies and scripts"}},
    {{"path": "server/index.js", "purpose": "Express server entry point"}}
  ]
}}

Rules:
- Each task MUST be an object with id, description, role, files fields
- Each file_manifest item MUST be an object with path, purpose fields
- List EVERY file that needs to be created
- Be specific about file paths
- CROSS-CHECK: If the frontend calls an API endpoint (e.g. PATCH /bookmarks/:id/favorite), \
the backend MUST have a corresponding task and route for it. Walk through every UI action \
(button click, form submit, toggle) and verify the backend plan covers the endpoint it needs.
- CROSS-CHECK: If the backend exposes an endpoint, the frontend must have code that calls it. \
No orphan endpoints, no orphan UI actions.
- Output ONLY the JSON object, nothing else""",
        model="opus",  # Planning uses Opus for thorough architecture decisions
        max_turns=1,
    )

    # Parse plan from response
    plan = Plan(summary=f"Plan for: {task[:100]}")
    try:
        text = response.text
        # Strip markdown code fences if present (```json ... ```)
        if "```" in text:
            lines = text.split("\n")
            cleaned = []
            in_fence = False
            for line in lines:
                if line.strip().startswith("```"):
                    in_fence = not in_fence
                    continue
                if in_fence or not line.strip().startswith("```"):
                    cleaned.append(line)
            text = "\n".join(cleaned)
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(text[start:end + 1])
            plan.summary = data.get("summary", plan.summary)
            for i, t in enumerate(data.get("tasks", [])):
                if not isinstance(t, dict):
                    continue
                plan.tasks.append(PlanTask(
                    id=t.get("id", f"T{i}"),
                    description=t.get("description", str(t)),
                    role=t.get("role", "executor"),
                    files=t.get("files", []),
                ))
            for f in data.get("file_manifest", []):
                if not isinstance(f, dict):
                    continue
                plan.file_manifest.append(
                    FileEntry(path=f.get("path", ""), purpose=f.get("purpose", ""))
                )
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass

    return {
        "plan": plan,
        "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
    }
