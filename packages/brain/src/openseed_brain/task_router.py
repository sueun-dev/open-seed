"""
LLM-based task router — analyzes plan tasks and assigns domains.

No regex, no file extension matching. Claude reads the task description
and decides which specialist should handle it.
"""

from __future__ import annotations

import json
from typing import Any

from openseed_brain.specialists import VALID_DOMAINS
from openseed_brain.state import Plan, PlanTask

ROUTING_SYSTEM_PROMPT = """\
You are a task routing expert. Given a list of implementation tasks from a \
project plan, you assign each task to the best specialist domain.

Available domains:
- frontend: UI components, pages, CSS, layout, styling, client-side state, \
  browser APIs, forms, responsive design, accessibility, animations, \
  frontend routing, component libraries
- backend: API endpoints, routes, controllers, middleware, authentication, \
  authorization, server-side logic, request validation, error handling, \
  business logic, background jobs, email sending, file uploads
- database: Schema design, models, migrations, seed data, queries, indexes, \
  ORMs, data modeling, relationships, constraints, stored procedures
- infra: Build configuration, package.json, pyproject.toml, Docker, CI/CD, \
  environment variables, linting config, testing config, deployment scripts, \
  monorepo setup, dependency management, git hooks
- fullstack: Tasks that tightly couple multiple layers where splitting them \
  would cause integration problems, OR tasks that are simple enough that a \
  single specialist can handle everything more efficiently

DECISION GUIDELINES:
- If a task involves BOTH creating an API endpoint AND the React component \
  that calls it, and they are tightly coupled (e.g., a form with server \
  action), assign to fullstack
- If a task is purely "create the login page UI", assign to frontend even \
  if it calls an API — the API is a separate task
- If a task mentions "set up project" or "initialize", assign to infra
- If a task is about data models / schema, assign to database even if it \
  also mentions the ORM — the ORM is a database concern
- When in doubt between splitting and fullstack, prefer fullstack for tasks \
  with fewer than 3 files
- A single task should be assigned to exactly ONE domain

Output valid JSON: a list of objects, one per task:
[{"task_id": "T1", "domain": "frontend"}, {"task_id": "T2", "domain": "backend"}, ...]
"""


async def route_tasks(plan: Plan, task: str) -> dict[str, list[PlanTask]]:
    """
    Ask Claude to assign each PlanTask to a domain specialist.

    Uses Claude Haiku for fast, cheap routing decisions.

    Args:
        plan: The implementation plan with tasks to route.
        task: The original user task description (for context).

    Returns:
        Dictionary mapping domain names to lists of PlanTasks.
        Example: {"frontend": [task1, task2], "backend": [task3]}
    """
    from openseed_claude.agent import ClaudeAgent

    if not plan.tasks:
        return {}

    # Build task list for the LLM
    task_lines = []
    for t in plan.tasks:
        files_str = ", ".join(t.files) if t.files else "not specified"
        task_lines.append(f"- {t.id}: {t.description} (files: {files_str})")
    task_list = "\n".join(task_lines)

    agent = ClaudeAgent()
    response = await agent.invoke(
        prompt=f"""Route these implementation tasks to specialist domains.

Original user request: {task}

Plan summary: {plan.summary}

Tasks to route:
{task_list}

Assign each task to exactly one domain. Output ONLY valid JSON.""",
        system_prompt=ROUTING_SYSTEM_PROMPT,
        model="sonnet",  # Sonnet for accurate domain routing
        max_turns=1,
    )

    # Parse routing assignments from LLM response
    assignments = _parse_routing_response(response.text, plan.tasks)
    return assignments


def _parse_routing_response(
    text: str,
    tasks: list[PlanTask],
) -> dict[str, list[PlanTask]]:
    """
    Parse the LLM's routing JSON and group tasks by domain.

    Falls back to fullstack for any tasks that couldn't be parsed or
    were assigned an invalid domain.
    """
    # Build lookup by task ID
    task_map: dict[str, PlanTask] = {t.id: t for t in tasks}
    assigned_ids: set[str] = set()

    result: dict[str, list[PlanTask]] = {}

    try:
        # Extract JSON array from response
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end <= start:
            raise ValueError("No JSON array found")

        data: list[dict[str, Any]] = json.loads(text[start : end + 1])

        for entry in data:
            task_id = entry.get("task_id", "")
            domain = entry.get("domain", "fullstack")

            # Validate domain
            if domain not in VALID_DOMAINS:
                domain = "fullstack"

            # Validate task exists
            if task_id not in task_map:
                continue

            result.setdefault(domain, []).append(task_map[task_id])
            assigned_ids.add(task_id)

    except (json.JSONDecodeError, ValueError, TypeError):
        # LLM returned unparseable output — assign everything to fullstack
        pass

    # Any unassigned tasks go to fullstack
    for t in tasks:
        if t.id not in assigned_ids:
            result.setdefault("fullstack", []).append(t)

    return result
