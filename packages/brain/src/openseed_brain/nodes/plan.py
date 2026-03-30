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
from openseed_brain.progress import emit_progress

logger = logging.getLogger(__name__)


async def _emit(event_type: str, **data) -> None:
    await emit_progress(event_type, node="plan", **data)


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
    intake_scope_raw = intake_analysis.get("scope", {})
    intake_scope = intake_scope_raw if isinstance(intake_scope_raw, dict) else {}
    intake_done_when_raw = intake_analysis.get("done_when", [])
    intake_done_when = intake_done_when_raw if isinstance(intake_done_when_raw, list) else []

    logger.info("Plan fast-path check: plan=%s, scope=%s (type=%s), done_when=%s (type=%s)",
                bool(intake_plan), bool(intake_scope), type(intake_scope_raw).__name__,
                bool(intake_done_when), type(intake_done_when_raw).__name__)

    if intake_plan and (intake_scope or intake_done_when):
        await _emit("plan.convert", message="Structuring user-approved plan into tasks...")
        plan = await _convert_intake_plan_via_llm(task, intake_analysis)
        logger.info("Using intake's user-approved plan (%d tasks, %d files)",
                     len(plan.tasks), len(plan.file_manifest))
        return {
            "plan": plan,
            "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
        }

    # ── Normal path: generate plan via Claude ──
    await _emit("plan.generate", message="Generating implementation plan via Claude Opus...")
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

    if not plan.tasks:
        logger.warning("Plan generation produced 0 tasks — implement will use fullstack fallback")

    return {
        "plan": plan,
        "messages": [f"Plan: {plan.summary} ({len(plan.tasks)} tasks, {len(plan.file_manifest)} files)"],
    }


async def _convert_intake_plan_via_llm(task: str, intake_analysis: dict) -> Plan:
    """
    Convert intake's text-based plan to structured Plan via LLM.

    Uses Sonnet to accurately assign roles and files to each step,
    instead of unreliable keyword matching.
    """
    from openseed_claude.agent import ClaudeAgent

    approach = intake_analysis.get("approach", "")
    plan_text = intake_analysis.get("plan", "")
    scope_raw = intake_analysis.get("scope", {})
    # scope can arrive as string from frontend — normalize to dict
    scope: dict = scope_raw if isinstance(scope_raw, dict) else {}
    done_when_raw = intake_analysis.get("done_when", [])
    done_when: list = done_when_raw if isinstance(done_when_raw, list) else []
    selected_skills = intake_analysis.get("selected_skills", [])
    tech_stack = intake_analysis.get("tech_stack", "")

    modify_files = scope.get("modify", [])
    create_files = scope.get("create", [])
    do_not_touch = scope.get("do_not_touch", [])
    all_scope_files = [f.split("(")[0].strip() for f in modify_files + create_files]

    # Build skill catalog for the prompt
    skill_catalog = ""
    if selected_skills:
        try:
            from openseed_brain.skill_loader import list_all_skills
            all_skills = list_all_skills()
            skill_info = []
            for s in all_skills:
                if s.name in selected_skills:
                    skill_info.append(f"  - {s.name}: {s.description[:120]}")
            if skill_info:
                skill_catalog = "\n\nAvailable skills (assign to tasks that need them):\n" + "\n".join(skill_info)
        except Exception:
            pass

    agent = ClaudeAgent()
    response = await agent.invoke(
        prompt=f"""Convert this approved plan into structured JSON tasks with accurate role and skill assignments.

Task: {task}
Approach: {approach}
Tech stack: {tech_stack}
Selected skills: {', '.join(selected_skills) if selected_skills else 'none'}{skill_catalog}

Plan steps:
{plan_text}

Files in scope:
- MODIFY: {', '.join(modify_files) if modify_files else 'none'}
- CREATE: {', '.join(create_files) if create_files else 'none'}

Respond with ONLY valid JSON:
{{
  "tasks": [
    {{"id": "T1", "description": "...", "role": "frontend|backend|database|infra|fullstack", "skills": ["skill-name-1", "skill-name-2"], "files": ["path1", "path2"]}}
  ],
  "file_manifest": [
    {{"path": "file/path", "purpose": "Create new|Modify existing"}}
  ]
}}

Role assignment rules:
- "frontend": UI components, pages, CSS, styling, client-side routing, forms, React/Vue/Svelte
- "backend": API endpoints, auth logic, middleware, validation, business logic, server code
- "database": Schema design, migrations, models, ORM setup, seed data, queries
- "infra": Project setup, package.json, Docker, CI/CD, deploy config, env vars, build config, testing framework setup
- "fullstack": Tasks that span multiple domains or are too intertwined to separate

Skill assignment rules:
- "skills" is a list of 0-3 skill names from the selected skills above
- Assign skills that will help the specialist execute THIS specific task
- A task can have 0 skills if none of the selected skills are relevant
- Multiple tasks CAN share the same skill
- Only use skill names from the selected skills list: {', '.join(selected_skills) if selected_skills else 'none'}

File assignment rules:
- Each file from scope MUST appear in exactly ONE task
- Match files to the task that will actually create/modify them
- A task can have 0 files if it's a conceptual step (e.g. "verify integration")

Output ONLY the JSON object.""",
        model="sonnet",
        max_turns=1,
    )

    plan = _parse_llm_converted_plan(task, approach, response.text, all_scope_files, modify_files, create_files, do_not_touch, done_when)
    return plan


def _parse_llm_converted_plan(
    task: str, approach: str, text: str,
    all_scope_files: list[str], modify_files: list[str], create_files: list[str],
    do_not_touch: list[str], done_when: list[str],
) -> Plan:
    """Parse LLM's JSON response into a Plan object, with fallback."""
    plan = Plan(summary=approach or f"Plan for: {task[:100]}")

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
                if in_fence:
                    cleaned.append(line)
            text = "\n".join(cleaned)

        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(text[start:end + 1])

            for i, t in enumerate(data.get("tasks", [])):
                if not isinstance(t, dict):
                    continue
                role = t.get("role", "fullstack")
                if role not in ("frontend", "backend", "database", "infra", "fullstack"):
                    role = "fullstack"
                plan.tasks.append(PlanTask(
                    id=t.get("id", f"T{i + 1}"),
                    description=t.get("description", str(t)),
                    role=role,
                    files=t.get("files", []),
                    skills=t.get("skills", []),
                ))

            for f in data.get("file_manifest", []):
                if not isinstance(f, dict):
                    continue
                plan.file_manifest.append(
                    FileEntry(path=f.get("path", ""), purpose=f.get("purpose", ""))
                )
    except (json.JSONDecodeError, TypeError, AttributeError) as exc:
        logger.warning("Failed to parse LLM-converted plan: %s — using fallback", exc)
        # Fallback: create a single fullstack task with all files
        plan.tasks.append(PlanTask(
            id="T1",
            description=f"Implement: {task[:200]}",
            role="fullstack",
            files=all_scope_files,
        ))
        for f in create_files:
            path = f.split("(")[0].strip() if "(" in f else f
            plan.file_manifest.append(FileEntry(path=path, purpose="Create new"))
        for f in modify_files:
            path = f.split("(")[0].strip() if "(" in f else f
            plan.file_manifest.append(FileEntry(path=path, purpose="Modify existing"))

    # Inject constraints into plan summary
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
    selected_skills = intake_analysis.get("selected_skills", [])
    if selected_skills:
        parts.append(f"- Selected skills: {', '.join(selected_skills)}")
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
                if in_fence:
                    cleaned.append(line)
            text = "\n".join(cleaned)
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            logger.warning("No JSON object found in Claude plan response")
        elif start != -1 and end > start:
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
                    skills=t.get("skills", []),
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
