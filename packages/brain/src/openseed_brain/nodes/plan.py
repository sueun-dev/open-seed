"""
Plan node — Generate implementation plan via Claude Opus.

If intake already produced a user-approved plan (with PLAN/SCOPE/DONE_WHEN),
convert it to a structured Plan object and use it directly.
Otherwise, generate a new plan from scratch via Claude.
"""

from __future__ import annotations

import json
import logging

from openseed_brain.state import PipelineState, Plan, PlanTask, FileEntry

logger = logging.getLogger(__name__)


async def plan_node(state: PipelineState) -> dict:
    """
    Generate a detailed implementation plan via Claude Opus.
    Reuses intake's plan if the user already approved one.
    """
    task = state["task"]
    working_dir = state["working_dir"]
    intake = "\n".join(state.get("messages", []))
    intake_analysis = state.get("intake_analysis", {})

    # ── Fast path: intake already has a user-approved plan ──
    intake_plan = intake_analysis.get("plan", "")
    intake_scope = intake_analysis.get("scope", {})
    intake_done_when = intake_analysis.get("done_when", [])

    if intake_plan and (intake_scope or intake_done_when):
        plan = _convert_intake_plan(task, intake_analysis)
        logger.info("Using intake's user-approved plan (%d tasks, %d files)",
                     len(plan.tasks), len(plan.file_manifest))
        return {
            "plan": plan,
            "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
        }

    # ── Normal path: generate plan via Claude ──
    analysis_context = _build_analysis_context(intake_analysis)

    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Create an implementation plan for this task.

Task: {task}
Working directory: {working_dir}
Analysis: {intake[:500]}
{analysis_context}

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
        model="opus",
        max_turns=1,
    )

    plan = _parse_claude_plan(task, response.text)

    return {
        "plan": plan,
        "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
    }


def _convert_intake_plan(task: str, intake_analysis: dict) -> Plan:
    """Convert intake's text-based plan to a structured Plan object."""
    approach = intake_analysis.get("approach", "")
    plan_text = intake_analysis.get("plan", "")
    scope = intake_analysis.get("scope", {})
    done_when = intake_analysis.get("done_when", [])

    plan = Plan(summary=approach or f"Plan for: {task[:100]}")

    # Collect all file paths from scope for matching
    modify_files = scope.get("modify", [])
    create_files = scope.get("create", [])
    do_not_touch = scope.get("do_not_touch", [])
    all_scope_files = modify_files + create_files

    # Convert plan steps to tasks with file assignment
    steps = [line.strip() for line in plan_text.splitlines() if line.strip()]
    for i, step in enumerate(steps):
        # Strip leading "1. ", "2. " etc.
        desc = step.lstrip("0123456789. ").strip() if step[0:1].isdigit() else step
        lower = desc.lower()

        # Guess role from content
        if any(w in lower for w in ("frontend", "component", "ui", "css", "style", "react", "page")):
            role = "frontend"
        elif any(w in lower for w in ("backend", "api", "server", "endpoint", "route", "database", "model")):
            role = "backend"
        elif any(w in lower for w in ("test", "verify", "check")):
            role = "qa"
        elif any(w in lower for w in ("setup", "install", "config", "deploy", "docker")):
            role = "infra"
        else:
            role = "fullstack"

        # Match scope files to this task by keyword overlap
        task_files = []
        for fp in all_scope_files:
            fp_lower = fp.lower()
            # Check if any word from the step description appears in the file path
            desc_words = [w for w in lower.split() if len(w) > 3]
            if any(w in fp_lower for w in desc_words):
                task_files.append(fp)
        plan.tasks.append(PlanTask(
            id=f"T{i + 1}",
            description=desc,
            role=role,
            files=task_files,
        ))

    # Build file manifest from scope
    for f in create_files:
        plan.file_manifest.append(FileEntry(path=f, purpose="Create new"))
    for f in modify_files:
        plan.file_manifest.append(FileEntry(path=f, purpose="Modify existing"))

    # Inject constraints into plan summary (NOT as tasks, to avoid execution)
    constraints = []
    if do_not_touch:
        constraints.append(f"DO NOT TOUCH: {', '.join(do_not_touch)}")
    if done_when:
        constraints.append(f"DONE WHEN: {' | '.join(done_when)}")
    if constraints:
        plan.summary += " [" + "; ".join(constraints) + "]"

    return plan


def _build_analysis_context(intake_analysis: dict) -> str:
    """Build analysis context string from intake analysis fields."""
    if not intake_analysis:
        return ""

    reqs = intake_analysis.get("requirements", [])
    approach = intake_analysis.get("approach", "")
    existing = intake_analysis.get("existing_project", "no")
    complexity = intake_analysis.get("complexity", "moderate")
    tech_stack = intake_analysis.get("tech_stack", "")
    lessons = intake_analysis.get("lessons", "")
    intent = intake_analysis.get("intent", "implementation")

    parts = [
        "\nIntake analysis:",
        f"- Intent: {intent}",
        f"- Complexity: {complexity}",
        f"- Existing project: {existing}",
    ]
    if tech_stack:
        parts.append(f"- Tech stack: {tech_stack}")
    if approach:
        parts.append(f"- Approach: {approach}")
    if reqs:
        parts.append(f"- Requirements: {', '.join(reqs) if isinstance(reqs, list) else reqs}")
    if lessons and str(lessons).lower() != "none":
        parts.append(f"- Lessons from past: {lessons}")
    if existing.lower() == "yes":
        parts.append(
            "- IMPORTANT: This is an existing project. Plan should include BOTH "
            "files to modify AND files to create. Do NOT plan to recreate files that already exist."
        )
    return "\n".join(parts) + "\n"


def _parse_claude_plan(task: str, text: str) -> Plan:
    """Parse Claude's JSON plan response into a Plan object."""
    plan = Plan(summary=f"Plan for: {task[:100]}")
    try:
        # Strip markdown code fences if present
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
    except (json.JSONDecodeError, TypeError, AttributeError) as exc:
        logger.warning("Failed to parse plan JSON: %s", exc)

    return plan
