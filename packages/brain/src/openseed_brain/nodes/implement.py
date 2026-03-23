"""
Implement node — Execute the plan using domain-specialist agents in parallel.

Supports specialist-based parallel implementation:
1. LLM routes plan tasks to domain specialists (frontend, backend, database, infra)
2. Specialists execute in parallel with deep domain expertise
3. Integration check verifies parallel outputs are compatible

Falls back to fullstack specialist when:
- No plan exists (skip_planning was set)
- Plan has no tasks
- Provider is "codex" or "both" (legacy modes)
"""

from __future__ import annotations

import asyncio

from openseed_brain.state import PipelineState, Implementation, PlanTask


# ─── Implementation Rules (shared across all specialists) ────────────────────

_IMPLEMENTATION_RULES = """\
Rules:
- Write ALL files DIRECTLY in the working directory — do NOT create a subdirectory/subfolder for the project
- Each file must be COMPLETE and RUNNABLE
- No placeholders, no TODOs
- If package.json is needed, create it with all deps
- Run npm install after creating package.json if needed
- src/ subfolder is OK for source files, but package.json/index.html must be at the root"""


def _build_plan_text(state: PipelineState) -> str:
    """Build human-readable plan text from state."""
    plan = state.get("plan")
    if not plan:
        return ""
    parts = [f"Summary: {plan.summary}"]
    for t in plan.tasks:
        parts.append(f"- {t.id}: {t.description} (files: {', '.join(t.files)})")
    parts.append("\nFiles to create:")
    for f in plan.file_manifest:
        parts.append(f"- {f.path}: {f.purpose}")
    return "\n".join(parts)


# ─── Specialist Runner ───────────────────────────────────────────────────────


async def _run_specialist(
    domain: str,
    tasks: list[PlanTask],
    state: PipelineState,
) -> Implementation:
    """
    Run a single domain specialist to implement its assigned tasks.

    Args:
        domain: The specialist domain (frontend, backend, database, infra, fullstack).
        tasks: The plan tasks assigned to this specialist.
        state: The full pipeline state for context.

    Returns:
        Implementation result from the specialist.
    """
    from openseed_left_hand.agent import ClaudeAgent
    from openseed_brain.specialists import get_specialist_prompt

    agent = ClaudeAgent()
    specialist_prompt = get_specialist_prompt(domain)

    task_descriptions = "\n".join(
        f"- {t.description} (files: {', '.join(t.files)})" for t in tasks
    )

    plan_text = _build_plan_text(state)

    response = await agent.invoke(
        prompt=f"""You are implementing the {domain} portion of this project.

Original task: {state["task"]}
Working directory: {state["working_dir"]}

Your assigned tasks:
{task_descriptions}

Full plan context:
{plan_text}

{_IMPLEMENTATION_RULES}""",
        system_prompt=specialist_prompt,
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=10,
    )

    return Implementation(
        summary=f"[{domain}] {response.text[:400]}",
        raw_output=response.text,
    )


# ─── Fullstack Fallback ─────────────────────────────────────────────────────


async def _implement_fullstack(state: PipelineState) -> Implementation:
    """
    Fullstack implementation — used when there is no plan or when the task
    is too simple to benefit from specialist splitting.
    """
    from openseed_left_hand.agent import ClaudeAgent
    from openseed_brain.specialists import get_specialist_prompt

    agent = ClaudeAgent()
    plan_text = _build_plan_text(state)

    response = await agent.invoke(
        prompt=f"""Implement this project. Write ALL files with COMPLETE code.

Task: {state["task"]}
Working directory: {state["working_dir"]}

{f"Plan:{chr(10)}{plan_text}" if plan_text else "No plan provided — implement the task directly."}

{_IMPLEMENTATION_RULES}""",
        system_prompt=get_specialist_prompt("fullstack"),
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=15,
    )

    return Implementation(summary=response.text[:500], raw_output=response.text)


# ─── Integration Check ──────────────────────────────────────────────────────


async def _integration_check(
    state: PipelineState,
    specialist_results: list[Implementation],
) -> Implementation:
    """
    Ask Claude to verify that parallel specialist outputs are compatible
    and fix any integration issues.

    This catches common problems from parallel implementation:
    - Mismatched imports between files
    - Duplicate file names from different specialists
    - API contract mismatches (frontend expects different response shape)
    - Missing dependencies in package.json
    - Database schema not matching ORM models
    """
    from openseed_left_hand.agent import ClaudeAgent

    agent = ClaudeAgent()

    summaries = "\n\n".join(
        f"--- {r.summary[:200]} ---" for r in specialist_results
    )

    response = await agent.invoke(
        prompt=f"""Multiple domain specialists just implemented different parts of this project in parallel.

Original task: {state["task"]}
Working directory: {state["working_dir"]}

Specialist outputs:
{summaries}

Read ALL the files that were just created in the working directory, then verify and fix:

1. All imports between files are correct (no importing from non-existent modules)
2. No duplicate file paths created by different specialists
3. API endpoints and response shapes match what the frontend expects
4. Database schema and models match what the backend queries use
5. package.json / pyproject.toml has ALL needed dependencies with correct names
6. Environment variables are consistent across all config files
7. Type definitions are shared correctly (no duplicate or conflicting types)

Fix any integration issues you find. If everything looks correct, confirm it.""",
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=5,
    )

    return Implementation(
        summary=f"[integration-check] {response.text[:400]}",
        raw_output=response.text,
    )


# ─── Legacy Provider Modes ───────────────────────────────────────────────────


async def _implement_codex(state: PipelineState) -> Implementation:
    """Fast parallel implementation via Codex (legacy mode)."""
    from openseed_right_hand.agent import CodexAgent

    agent = CodexAgent()
    plan_text = _build_plan_text(state)

    response = await agent.invoke(
        prompt=f"""Implement this plan. Write ALL files.

Task: {state["task"]}

Plan:
{plan_text}

Write every file with complete code. No placeholders.""",
        working_dir=state["working_dir"],
    )

    return Implementation(
        summary=response.text[:500],
        files_created=response.files_created,
        files_modified=response.files_modified,
        raw_output=response.text,
    )


async def _implement_both(state: PipelineState) -> Implementation:
    """Claude designs architecture, Codex implements in parallel (legacy mode)."""
    from openseed_left_hand.agent import ClaudeAgent
    from openseed_right_hand.agent import CodexAgent

    plan_text = _build_plan_text(state)

    claude = ClaudeAgent()
    arch_response = await claude.invoke(
        prompt=f"""Create the core architecture files for this project.
Focus on: entry point, main server/app file, config, types.
Other files will be created by a parallel agent.

Task: {state["task"]}
Working directory: {state["working_dir"]}

Plan:
{plan_text}

Write only the 3-4 most critical files. Be thorough.""",
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=8,
    )

    codex = CodexAgent()
    impl_response = await codex.invoke(
        prompt=f"""Complete the remaining files for this project.
Some core files already exist — read them first, then create the rest.

Task: {state["task"]}

Plan:
{plan_text}

Read existing files, then write ALL missing files. No duplicates.""",
        working_dir=state["working_dir"],
    )

    return Implementation(
        summary=f"Claude: {arch_response.text[:200]} | Codex: {impl_response.text[:200]}",
        files_created=impl_response.files_created,
        raw_output=f"=== Claude ===\n{arch_response.text}\n\n=== Codex ===\n{impl_response.text}",
    )


# ─── Main Node ───────────────────────────────────────────────────────────────


async def implement_node(state: PipelineState) -> dict:
    """
    Execute the plan using domain specialists in parallel.

    Flow:
    1. If provider is "codex" or "both", use legacy modes (backward compat)
    2. If no plan or no tasks, use fullstack specialist directly
    3. Otherwise: route tasks to specialists via LLM, execute in parallel,
       then run integration check
    """
    provider = state.get("provider", "claude")

    # Legacy provider modes — backward compatibility
    if provider == "codex":
        impl = await _implement_codex(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [codex]: {impl.summary[:300]}"],
        }
    if provider == "both":
        impl = await _implement_both(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [both]: {impl.summary[:300]}"],
        }

    # ── Specialist-based implementation ──────────────────────────────────────

    plan = state.get("plan")

    # No plan or empty plan — use fullstack specialist directly
    if not plan or not plan.tasks:
        impl = await _implement_fullstack(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack]: {impl.summary[:300]}"],
        }

    # Route tasks to domain specialists via LLM
    from openseed_brain.task_router import route_tasks

    routed = await route_tasks(plan, state["task"])

    if not routed:
        # Routing returned nothing — fall back to fullstack
        impl = await _implement_fullstack(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack-fallback]: {impl.summary[:300]}"],
        }

    # Execute specialists in parallel
    domain_tasks = [
        (domain, tasks) for domain, tasks in routed.items() if tasks
    ]

    specialist_results: list[Implementation] = await asyncio.gather(
        *[_run_specialist(domain, tasks, state) for domain, tasks in domain_tasks]
    )

    # Combine specialist summaries
    domains_used = [d for d, _ in domain_tasks]
    combined_summary = " | ".join(r.summary[:150] for r in specialist_results)
    combined_output = "\n\n".join(
        f"=== {domain} specialist ===\n{r.raw_output}"
        for (domain, _), r in zip(domain_tasks, specialist_results)
    )

    # Integration check — verify parallel outputs are compatible
    if len(specialist_results) > 1:
        integration_result = await _integration_check(state, specialist_results)
        combined_output += f"\n\n=== Integration Check ===\n{integration_result.raw_output}"
        combined_summary += f" | {integration_result.summary[:100]}"

    impl = Implementation(
        summary=combined_summary[:500],
        raw_output=combined_output,
    )

    messages = [
        f"Implement [specialists: {', '.join(domains_used)}]: {impl.summary[:300]}"
    ]

    return {
        "implementation": impl,
        "messages": messages,
    }
