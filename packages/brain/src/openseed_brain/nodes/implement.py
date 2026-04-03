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

from openseed_brain.progress import emit_progress
from openseed_brain.state import Implementation, PipelineState, PlanTask


async def _emit(event_type: str, **data) -> None:
    await emit_progress(event_type, node="implement", **data)


# ─── Implementation Rules (shared across all specialists) ────────────────────

_RULES_CORE = """\
- Write ALL files DIRECTLY in the working directory — do NOT create a subdirectory/subfolder for the project
- Each file must be COMPLETE and RUNNABLE
- No placeholders, no TODOs
- Dev defaults: Every config value (ports, origins, DB paths) must work out-of-the-box \
in a dev environment with zero env vars set. Use sensible defaults, not empty strings."""

_RULES_WEB = """\
- If package.json is needed, create it with all deps
- Run npm install after creating package.json if needed
- src/ subfolder is OK for source files, but package.json/index.html must be at the root
- CORS: In development, allow ALL localhost origins (e.g. use an env variable like \
FRONTEND_ORIGIN or default to a pattern that accepts any localhost port). NEVER hardcode \
a specific port like 5173 — the dev server port can change.
- REST updates: Always implement BOTH PUT (full replace, all fields required) AND \
PATCH (partial update, only changed fields required) for every resource. A CRUD API \
without PATCH is incomplete."""

_RULES_FIX = """\
- Make MINIMAL, targeted changes — do NOT rewrite files that are not broken
- Read the affected files FIRST before editing
- Preserve existing code style, naming conventions, and architecture
- Do NOT add unrelated improvements, refactors, or features"""

# Web-related tech stacks (triggers _RULES_WEB inclusion)
_WEB_INDICATORS = frozenset(
    {
        "react",
        "vue",
        "next.js",
        "nuxt",
        "svelte",
        "sveltekit",
        "angular",
        "express",
        "fastify",
        "fastapi",
        "flask",
        "django",
        "vite",
        "webpack",
        "tailwind css",
        "prisma",
    }
)


def _build_rules(intake: dict) -> str:
    """Build context-aware implementation rules from intake_analysis."""
    intent = intake.get("intent", "implementation")
    tech_stack_raw = intake.get("tech_stack", "")

    parts = ["Rules:"]
    parts.append(_RULES_CORE)

    # Add fix-specific rules for bug fixes
    if intent == "fix":
        parts.append(_RULES_FIX)

    # Add web rules only when the project involves web technologies
    if tech_stack_raw:
        detected = {t.strip().lower() for t in tech_stack_raw.split(",")}
    else:
        detected = set()
    if detected & _WEB_INDICATORS or not detected:
        # Include web rules when web tech detected OR when tech is unknown (safe default)
        parts.append(_RULES_WEB)

    return "\n".join(parts)


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


# ─── Skill-aware Prompt Resolution ────────────────────────────────────────────


def _build_specialist_prompt(domain: str, tasks: list[PlanTask], intake: dict) -> str:
    """
    Build specialist prompt by combining:
    1. Hardcoded domain specialist prompt (base expertise)
    2. All SKILL.md contents from task-assigned skills (specific knowledge)

    Each task has a .skills list assigned by LLM during plan structuring.
    Multiple skills are concatenated into the system prompt.
    """
    from openseed_brain.specialists import get_specialist_prompt

    # Start with hardcoded specialist as base
    parts = [get_specialist_prompt(domain)]

    # Collect unique skills from all tasks assigned to this specialist
    skill_names: list[str] = []
    seen: set[str] = set()
    for t in tasks:
        for s in t.skills:
            if s not in seen:
                skill_names.append(s)
                seen.add(s)

    # Load and append SKILL.md content for each assigned skill
    if skill_names:
        try:
            from openseed_brain.skill_loader import get_skill_content

            for name in skill_names:
                content = get_skill_content(name)
                if content:
                    parts.append(f"\n\n{'=' * 60}\nOFFICIAL SKILL: {name}\n{'=' * 60}\n{content}")
        except Exception:
            pass

    return "\n\n".join(parts)


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
    from openseed_claude.agent import ClaudeAgent

    agent = ClaudeAgent()
    intake = state.get("intake_analysis") or {}

    # Build specialist prompt: base domain expertise + all assigned skill contents
    specialist_prompt = _build_specialist_prompt(domain, tasks, intake)

    task_descriptions = "\n".join(f"- {t.description} (files: {', '.join(t.files)})" for t in tasks)

    plan_text = _build_plan_text(state)

    # Build intake context (requirements, approach, lessons)
    intake_context = _build_intake_context(intake)

    # Existing project awareness
    existing = intake.get("existing_project", "").lower() == "yes"
    existing_instruction = (
        "\nThis is an EXISTING project. Read relevant existing files FIRST "
        "before writing, and match the existing code style.\n"
        if existing
        else ""
    )

    # Context-aware rules
    rules = _build_rules(intake)

    # Dynamic max_turns
    max_turns = _resolve_max_turns(intake, has_plan=True)

    # Inject microagent context if available (OpenHands pattern)
    microagent_section = ""
    micro_ctx = state.get("microagent_context", [])
    if micro_ctx:
        microagent_section = "\n\n" + "\n".join(micro_ctx) + "\n"

    response = await agent.invoke(
        prompt=f"""You are implementing the {domain} portion of this project.

Original task: {state["task"]}
Working directory: {state["working_dir"]}
{existing_instruction}
Your assigned tasks:
{task_descriptions}

Full plan context:
{plan_text}
{f"{chr(10)}{intake_context}" if intake_context else ""}\
{microagent_section}
{rules}""",
        system_prompt=specialist_prompt,
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=max_turns,
    )

    return Implementation(
        summary=f"[{domain}] {response.text[:400]}",
        raw_output=response.text,
    )


# ─── Intake-Aware Prompt Builder ───────────────────────────────────────────


def _build_action_instruction(intake: dict) -> str:
    """Build the primary instruction based on intent and project status."""
    intent = intake.get("intent", "implementation")
    existing = intake.get("existing_project", "").lower() == "yes"

    if intent == "fix":
        return (
            "Fix this issue. Read the affected files first, diagnose the root cause, "
            "then apply minimal targeted changes. Do NOT rewrite unrelated code."
        )
    if intent == "research" or intent == "investigation":
        return (
            "Investigate this thoroughly. Read the relevant files, analyze the situation, "
            "and report your findings with specific evidence. Write code only if needed."
        )
    if intent == "evaluation":
        return (
            "Evaluate this. Read the relevant code, assess quality/correctness, "
            "and provide a structured assessment. Fix issues if requested."
        )
    if existing:
        return (
            "Modify this existing project. Read the relevant existing files FIRST to "
            "understand the current architecture, then make your changes consistent "
            "with the existing code style and patterns."
        )
    # New project — implementation or open_ended
    return "Implement this project from scratch. Write ALL files with COMPLETE code."


def _build_intake_context(intake: dict) -> str:
    """Build context sections from intake_analysis."""
    sections: list[str] = []

    # Requirements
    reqs = intake.get("requirements", [])
    if reqs:
        sections.append("Requirements:")
        for r in reqs:
            sections.append(f"- {r}")

    # Approach
    approach = intake.get("approach", "")
    if approach:
        sections.append(f"\nApproach: {approach}")

    # Lessons from past
    lessons = intake.get("lessons", "")
    if lessons and lessons.lower() != "none":
        sections.append(f"\nLessons from past tasks: {lessons}")

    return "\n".join(sections)


def _resolve_max_turns(intake: dict, has_plan: bool) -> int:
    """Determine max_turns based on complexity and context."""
    complexity = intake.get("complexity", "moderate")
    intent = intake.get("intent", "implementation")

    if intent in ("research", "investigation", "evaluation"):
        return 8

    if not has_plan:
        # skip_planning path — simpler tasks
        return {"simple": 10, "moderate": 20, "complex": 30}.get(complexity, 20)

    # With plan — specialist path
    return {"simple": 12, "moderate": 20, "complex": 25}.get(complexity, 20)


# ─── Fullstack Fallback ─────────────────────────────────────────────────────


async def _implement_fullstack(state: PipelineState) -> Implementation:
    """
    Fullstack implementation — used when there is no plan or when the task
    is too simple to benefit from specialist splitting.

    Uses intake_analysis to tailor the prompt to the specific intent,
    complexity, and project context.
    """
    from openseed_claude.agent import ClaudeAgent

    from openseed_brain.specialists import get_specialist_prompt

    agent = ClaudeAgent()
    plan_text = _build_plan_text(state)
    intake = state.get("intake_analysis") or {}

    # Build intent-aware instruction
    action = _build_action_instruction(intake)

    # Build context from intake analysis (requirements, approach, lessons)
    intake_context = _build_intake_context(intake)

    # Build context-aware rules (web rules only for web projects, fix rules for fixes)
    rules = _build_rules(intake)

    # Dynamic max_turns based on complexity
    max_turns = _resolve_max_turns(intake, has_plan=bool(plan_text))

    # Inject microagent context if available (OpenHands pattern)
    microagent_section = ""
    micro_ctx = state.get("microagent_context", [])
    if micro_ctx:
        microagent_section = "\n\n" + "\n".join(micro_ctx) + "\n"

    response = await agent.invoke(
        prompt=f"""{action}

Task: {state["task"]}
Working directory: {state["working_dir"]}

{f"Plan:{chr(10)}{plan_text}" if plan_text else ""}\
{f"{chr(10)}{intake_context}" if intake_context else ""}\
{microagent_section}
{rules}""",
        system_prompt=get_specialist_prompt("fullstack"),
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=max_turns,
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
    from openseed_claude.agent import ClaudeAgent

    agent = ClaudeAgent()

    summaries = "\n\n".join(f"--- {r.summary[:200]} ---" for r in specialist_results)

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
8. CORS origin matches the actual frontend dev server port — if the frontend runs on a \
different port than expected, the CORS config must accept it. Prefer env-var-based origin \
or a permissive localhost default for dev.
9. Every API call in the frontend code has a matching route handler in the backend. \
Grep the frontend for fetch/axios calls and verify each URL path exists as a backend route.
10. Every REST resource has both PUT and PATCH endpoints if the frontend performs updates.

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
    from openseed_codex.agent import CodexAgent

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
    from openseed_claude.agent import ClaudeAgent
    from openseed_codex.agent import CodexAgent

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


# ─── Self-Verify: lint/type check after implementation ─────────────────────


async def _self_verify_and_fix(
    state: PipelineState,
    impl: Implementation,
    label: str,
) -> tuple[Implementation, list[str]]:
    """
    Run lint/type checks on the implementation output and auto-fix errors.

    This catches basic mistakes (syntax errors, type errors, missing imports)
    BEFORE the expensive QA Gate runs. If lint errors are found, asks Claude
    to fix them immediately in the same working directory.

    Returns:
        (possibly_updated_implementation, extra_messages)
    """
    working_dir = state["working_dir"]
    extra_messages: list[str] = []

    try:
        from openseed_guard.evidence import auto_detect_lint_commands, verify_command

        lint_commands = await auto_detect_lint_commands(working_dir)
        if not lint_commands:
            return impl, extra_messages

        # Run each lint command and collect failures
        failures: list[str] = []
        for cmd in lint_commands:
            evidence = await verify_command(cmd, working_dir)
            if not evidence.passed:
                failures.append(f"{cmd}: {evidence.detail}")

        if not failures:
            extra_messages.append(f"Implement [{label}]: lint checks passed")
            return impl, extra_messages

        # Lint errors found — ask Claude to fix them immediately
        extra_messages.append(f"Implement [{label}]: {len(failures)} lint error(s) found, auto-fixing")

        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        error_text = "\n".join(f"- {f}" for f in failures[:10])

        await agent.invoke(
            prompt=f"""Lint/type checks found errors in the code you just wrote.
Fix ALL of these errors NOW.

Working directory: {working_dir}

Errors:
{error_text}

Rules:
- Read each file with errors, fix the issue, write the corrected file
- Do NOT change any logic or features — only fix the lint/type errors
- If an import is missing, add it. If a type is wrong, fix it.
- Do NOT add new features or refactor""",
            model="sonnet",
            working_dir=working_dir,
            max_turns=8,
        )

        # Re-check after fix
        still_failing = 0
        for cmd in lint_commands:
            evidence = await verify_command(cmd, working_dir)
            if not evidence.passed:
                still_failing += 1

        if still_failing == 0:
            extra_messages.append(f"Implement [{label}]: all lint errors fixed")
        else:
            extra_messages.append(f"Implement [{label}]: {still_failing}/{len(lint_commands)} lint issues remain")

    except Exception as exc:
        import logging

        logging.getLogger(__name__).debug("Self-verify skipped: %s", exc)

    return impl, extra_messages


# ─── Main Node ───────────────────────────────────────────────────────────────


async def implement_node(state: PipelineState) -> dict:
    """
    Execute the plan using domain specialists in parallel.

    Flow:
    1. If provider is "codex" or "both", use legacy modes (backward compat)
    2. If no plan or no tasks, use fullstack specialist directly
    3. Otherwise: route tasks to specialists via LLM, execute in parallel,
       then run integration check
    4. Self-verify: run lint/type checks and auto-fix basic errors before QA
    """
    provider = state.get("provider", "claude")

    # Legacy provider modes — backward compatibility
    if provider == "codex":
        await _emit("implement.start", phase="codex", message="Starting Codex implementation...")
        impl = await _implement_codex(state)
        await _emit("implement.verify", message="Running lint checks...")
        impl, extra = await _self_verify_and_fix(state, impl, "codex")
        await _emit("implement.done", message="Codex implementation complete")
        return {
            "implementation": impl,
            "messages": [f"Implement [codex]: {impl.summary[:300]}"] + extra,
        }
    if provider == "both":
        await _emit("implement.start", phase="both", message="Starting Claude + Codex implementation...")
        impl = await _implement_both(state)
        await _emit("implement.verify", message="Running lint checks...")
        impl, extra = await _self_verify_and_fix(state, impl, "both")
        await _emit("implement.done", message="Both-mode implementation complete")
        return {
            "implementation": impl,
            "messages": [f"Implement [both]: {impl.summary[:300]}"] + extra,
        }

    # ── Specialist-based implementation ──────────────────────────────────────

    plan = state.get("plan")

    # No plan or empty plan — use fullstack specialist directly
    if not plan or not plan.tasks:
        await _emit("implement.start", phase="fullstack", message="Starting fullstack implementation...")
        impl = await _implement_fullstack(state)
        await _emit("implement.verify", message="Running lint checks...")
        impl, extra = await _self_verify_and_fix(state, impl, "fullstack")
        await _emit("implement.done", message="Fullstack implementation complete")
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack]: {impl.summary[:300]}"] + extra,
        }

    # Route tasks to domain specialists via LLM
    from openseed_brain.task_router import route_tasks

    await _emit("implement.routing", message=f"Routing {len(plan.tasks)} tasks to specialists...")
    routed = await route_tasks(plan, state["task"])

    if not routed:
        # Routing returned nothing — fall back to fullstack
        await _emit("implement.start", phase="fullstack-fallback", message="Falling back to fullstack...")
        impl = await _implement_fullstack(state)
        await _emit("implement.verify", message="Running lint checks...")
        impl, extra = await _self_verify_and_fix(state, impl, "fullstack-fallback")
        await _emit("implement.done", message="Fullstack implementation complete")
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack-fallback]: {impl.summary[:300]}"] + extra,
        }

    # Execute specialists in parallel
    domain_tasks = [(domain, tasks) for domain, tasks in routed.items() if tasks]

    domains_used = [d for d, _ in domain_tasks]
    task_counts = {d: len(t) for d, t in domain_tasks}
    await _emit(
        "implement.specialists",
        message=f"Running {len(domain_tasks)} specialists in parallel: {', '.join(domains_used)}",
        specialists=task_counts,
    )

    async def _run_specialist_with_progress(domain: str, tasks: list[PlanTask], state: PipelineState) -> Implementation:
        task_desc = ", ".join(t.description[:60] for t in tasks[:3])
        await _emit("implement.specialist_start", specialist=domain, tasks=len(tasks), message=f"{domain}: {task_desc}")
        result = await _run_specialist(domain, tasks, state)
        await _emit("implement.specialist_done", specialist=domain, message=f"{domain} specialist finished")
        return result

    specialist_results: list[Implementation] = await asyncio.gather(
        *[_run_specialist_with_progress(domain, tasks, state) for domain, tasks in domain_tasks]
    )

    # Combine specialist summaries
    combined_summary = " | ".join(r.summary[:150] for r in specialist_results)
    combined_output = "\n\n".join(
        f"=== {domain} specialist ===\n{r.raw_output}"
        for (domain, _), r in zip(domain_tasks, specialist_results, strict=False)
    )

    # Integration check — verify parallel outputs are compatible
    if len(specialist_results) > 1:
        await _emit("implement.integration", message="Checking integration between specialists...")
        integration_result = await _integration_check(state, specialist_results)
        combined_output += f"\n\n=== Integration Check ===\n{integration_result.raw_output}"
        combined_summary += f" | {integration_result.summary[:100]}"
        await _emit("implement.integration_done", message="Integration check complete")

    impl = Implementation(
        summary=combined_summary[:500],
        raw_output=combined_output,
    )

    # Self-verify: lint/type check and auto-fix before QA Gate
    await _emit("implement.verify", message="Running lint and type checks...")
    label = f"specialists: {', '.join(domains_used)}"
    impl, extra = await _self_verify_and_fix(state, impl, label)
    await _emit("implement.done", message="Implementation complete")

    messages = [f"Implement [{label}]: {impl.summary[:300]}"] + extra

    return {
        "implementation": impl,
        "messages": messages,
    }
