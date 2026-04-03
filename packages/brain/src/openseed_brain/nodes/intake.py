"""
Intake node — Multi-step reasoning for intelligent task analysis and clarification.

Three-step process for Phase 1 (no answers yet):
  Step 1: Context Collection — codebase scan, memory recall, intent classification
  Step 2: Gap Analysis — AI identifies what it doesn't know to execute perfectly
  Step 3: Per-Gap Research — independent web search for each knowledge gap
  Step 4: Question Formulation — dynamic question count based on complexity,
          each option backed by research rationale

Phase 2 (with answers): re-analyze with user's answers → generate execution plan

All routing decisions are made by the LLM — no regex, no hardcoded extension checks.
"""

from __future__ import annotations

import asyncio
import logging

from openseed_brain.progress import emit_progress
from openseed_brain.state import PipelineState

logger = logging.getLogger(__name__)


async def _emit(event_type: str, **data) -> None:
    await emit_progress(event_type, node="intake", **data)


# ═══════════════════════════════════════════════════════════════════════════════
# Main Entry Point
# ═══════════════════════════════════════════════════════════════════════════════


async def intake_node(state: PipelineState) -> dict:
    """
    Multi-step intake: context → gaps → research → questions (or plan if answers exist).
    """
    # ── Fast path: plan already approved by user (from frontend Phase 2) ──
    existing_raw = state.get("intake_analysis")
    existing = existing_raw if isinstance(existing_raw, dict) else None
    if existing and existing.get("plan"):
        logger.info("Intake: using pre-approved plan, sending to plan_node for structuring")
        return {
            "skip_planning": False,  # Still go through plan_node to convert text → Plan object
            "intake_analysis": existing,
            "messages": ["Intake: using user-approved plan"],
        }

    task = state["task"]
    working_dir = state["working_dir"]
    has_answers = bool(state.get("clarification_answers"))

    # ── Step 1: Context Collection (always runs) ──
    await _emit("intake.context", message="Scanning codebase, recalling memories...")
    context = await _collect_context(task, working_dir)

    # ── Harness quality check (deterministic, no blocking) ──
    harness_needs_setup = False
    try:
        from openseed_core.harness.checker import check_harness_quality

        harness_score = check_harness_quality(working_dir)
        harness_needs_setup = not harness_score.passing
        if harness_needs_setup:
            await _emit("intake.harness", message=f"Harness: {harness_score.total}/100 — will include setup in questions")
        else:
            await _emit("intake.harness", message=f"Harness OK ({harness_score.total}/100)")
    except Exception:
        pass

    from openseed_claude.agent import ClaudeAgent

    agent = ClaudeAgent()

    if has_answers:
        # Phase 2: Generate harness (if needed) + execution plan from user's answers
        await _emit("intake.plan", message="Generating execution plan from your answers...")

        # Build harness from ALL answers before generating plan
        if harness_needs_setup:
            await _emit("intake.harness.setup", message="Setting up harness from your answers...")
            all_answers = state.get("clarification_answers", [])
            all_questions = state.get("clarification_questions", [])
            # Combine all Q&A as project description for AI
            qa_context = "\n".join(
                f"Q: {q}\nA: {a}" for q, a in zip(all_questions, all_answers, strict=False) if a
            )
            await _auto_harness_setup(working_dir, state.get("provider", "claude"), qa_context)
            # Re-collect context now that AGENTS.md exists
            context = await _collect_context(task, working_dir)

        return await _phase2_plan(agent, state, context)

    # ── Step 2: Gap Analysis — AI identifies what it doesn't know ──
    await _emit("intake.gaps", message="Analyzing task for knowledge gaps...")
    gaps = await _identify_gaps(agent, task, context)
    logger.info("Identified %d knowledge gaps", len(gaps))

    # ── Step 2.5: Add harness gap if harness is insufficient ──
    if harness_needs_setup:
        gaps.append({
            "topic": "Project description for harness setup",
            "why": "No AGENTS.md found — need to understand the project to generate coding guidelines, "
                   "boundaries, and verification commands for AI agents",
        })
        logger.info("Added harness setup gap (total: %d gaps)", len(gaps))

    # ── Step 2.5: Select Skills — pick relevant official skills for this task ──
    await _emit("intake.skills", message="Selecting relevant skills...")
    selected_skills = await _select_skills(agent, task, gaps, context)
    logger.info("Selected %d skills: %s", len(selected_skills), selected_skills)

    if not gaps:
        # No gaps = simple task, skip questions entirely
        analysis = await _quick_classify(agent, task, context)
        if selected_skills:
            analysis["selected_skills"] = selected_skills
        return {
            "skip_planning": analysis.get("skip_planning", True),
            "intake_analysis": analysis,
            "clarification_questions": [],
            "messages": ["Intake: simple task, no clarification needed"],
        }

    # ── Step 3: Per-Gap Research — parallel web search for each gap ──
    await _emit("intake.research", message=f"Researching {len(gaps)} gaps in parallel...", count=len(gaps))
    research_results = await _research_gaps(agent, task, gaps, context)
    logger.info("Completed research for %d gaps", len(research_results))

    # ── Step 4: Formulate Questions — dynamic count, research-backed options ──
    await _emit("intake.questions", message="Formulating clarification questions...")
    result = await _formulate_questions(agent, task, context, gaps, research_results)

    # Inject selected skills into intake_analysis
    if selected_skills and "intake_analysis" in result:
        result["intake_analysis"]["selected_skills"] = selected_skills

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Context Collection
# ═══════════════════════════════════════════════════════════════════════════════


async def _collect_context(task: str, working_dir: str) -> dict:
    """Gather all available context: codebase, memory, intent, microagents."""
    context: dict = {
        "intent_info": "",
        "memory_context": "",
        "codebase_context": "",
        "detected_tech_stack": [],
        "all_paths": [],
        "microagent_context": [],
    }

    # Intent classification
    try:
        from openseed_guard.intent_gate import classify_intent

        intent = await classify_intent(task)
        context["intent_info"] = (
            f"\nIntent classification: {intent.intent_type.value} "
            f"(confidence: {intent.confidence:.1f})\n"
            f"Suggested approach: {intent.suggested_approach}\n"
        )
    except Exception as exc:
        logger.debug("Intent gate unavailable: %s", exc)

    # Memory recall
    try:
        from openseed_memory.failure import recall_similar_failures
        from openseed_memory.store import MemoryStore

        store = MemoryStore()
        await store.initialize()

        results = await store.search(task, limit=5)
        if results:
            context["memory_context"] += "\n\nRelevant past experiences:\n"
            for r in results:
                context["memory_context"] += f"- {r.entry.content[:200]} (score: {r.score:.2f})\n"

        patterns = await recall_similar_failures(store, task, [])
        if patterns:
            context["memory_context"] += "\nKnown failure patterns for similar tasks:\n"
            for p in patterns:
                context["memory_context"] += f"- {p.error_type[:200]} → fix: {p.successful_fix}\n"

        try:
            from openseed_memory.wisdom import format_wisdom_for_prompt, recall_wisdom

            wisdoms = await recall_wisdom(store, task, limit=5)
            if wisdoms:
                wisdom_text = format_wisdom_for_prompt(wisdoms)
                if wisdom_text:
                    context["memory_context"] += wisdom_text
        except Exception:
            pass
    except Exception as exc:
        logger.debug("Memory unavailable: %s", exc)

    # Codebase scan
    try:
        codebase_context, detected_tech_stack, all_paths = _scan_working_dir(working_dir)
        context["codebase_context"] = codebase_context
        context["detected_tech_stack"] = detected_tech_stack
        context["all_paths"] = all_paths
        if codebase_context:
            logger.info("Codebase scan: %s", codebase_context[:100])
        if len(all_paths) > 3:
            file_contents = _read_key_files(working_dir, task, detected_tech_stack, all_paths)
            if file_contents:
                context["codebase_context"] += file_contents
                logger.info("Read %d chars of key source files", len(file_contents))
    except Exception as exc:
        logger.debug("Codebase scan skipped: %s", exc)

    # Microagents
    try:
        from openseed_core.microagent import (
            format_microagent_context,
            load_microagents,
            select_relevant_microagents,
        )

        all_agents = load_microagents(working_dir)
        relevant_agents = await select_relevant_microagents(all_agents, task)
        if relevant_agents:
            context["microagent_context"] = [format_microagent_context(relevant_agents)]
            logger.info("Loaded %d microagents", len(relevant_agents))
    except Exception as exc:
        logger.debug("Microagent loading skipped: %s", exc)

    return context


def _build_context_block(context: dict) -> str:
    """Format collected context into a single text block for prompts."""
    parts = []
    if context["intent_info"]:
        parts.append(context["intent_info"])
    if context["memory_context"]:
        parts.append(context["memory_context"])
    if context["codebase_context"]:
        parts.append(context["codebase_context"])
    return "\n".join(parts)


# ═══════════════════════════════════════════════════════════════════════════════
# Step 2.5: Skill Selection
# ═══════════════════════════════════════════════════════════════════════════════


async def _select_skills(agent, task: str, gaps: list[dict], context: dict) -> list[str]:
    """Select relevant official skills from Anthropic/OpenAI repos."""
    try:
        from openseed_brain.skill_loader import select_skills_for_task

        return await select_skills_for_task(
            agent,
            task=task,
            gaps=gaps,
            tech_stack=context.get("detected_tech_stack", []),
            codebase_context=context.get("codebase_context", ""),
        )
    except Exception as exc:
        logger.debug("Skill selection skipped: %s", exc)
        return []


# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Gap Analysis
# ═══════════════════════════════════════════════════════════════════════════════


async def _identify_gaps(agent, task: str, context: dict) -> list[dict]:
    """
    Ask AI to deeply analyze the task and identify what it doesn't know.
    Returns a list of knowledge gaps, each with a topic and why it matters.
    """
    context_block = _build_context_block(context)

    logger.info("Gap analysis: invoking AI for task: %s", task[:80])
    response = await agent.invoke(
        prompt=f"""You are about to execute this task autonomously. Before starting, identify
what you DON'T know — the decisions that cannot be made without the user's input.

Task: {task}
{context_block}

Think carefully:
- What architectural decisions need user preference? (only if building something new)
- What ambiguities exist in the task description?
- What trade-offs should the user decide? (performance vs simplicity, etc.)
- Are there multiple valid approaches where the user's preference matters?

If the task is straightforward and unambiguous (e.g. "fix the typo", "update the version",
"add a console.log"), respond with:
GAPS: none

Otherwise, list ONLY the genuine unknowns:
GAPS:
- TOPIC: <short topic name> | WHY: <why this decision matters for the outcome>
- TOPIC: <short topic name> | WHY: <why this decision matters for the outcome>

Rules:
- Do NOT invent gaps for simple tasks. "Fix the bug in auth.ts" has zero gaps.
- Do NOT ask about things you can determine from the codebase scan above.
- Each gap must represent a REAL decision point where different choices lead to different outcomes.
- Maximum 8 gaps even for the most complex tasks.
- Be brutally honest: if you can make a good default decision yourself, it's NOT a gap.""",
        model="opus",
        max_turns=1,
    )

    return _parse_gaps(response.text)


def _parse_gaps(text: str) -> list[dict]:
    """Parse GAPS section from AI response."""
    gaps = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper() == "GAPS: NONE" or stripped.upper() == "GAPS:NONE":
            return []
        if stripped.startswith("- TOPIC:") and "| WHY:" in stripped:
            parts = stripped.split("| WHY:", 1)
            topic = parts[0].replace("- TOPIC:", "").strip()
            why = parts[1].strip()
            if topic:
                gaps.append({"topic": topic, "why": why})
    return gaps


# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Per-Gap Research
# ═══════════════════════════════════════════════════════════════════════════════


async def _research_gaps(
    agent,
    task: str,
    gaps: list[dict],
    context: dict,
) -> list[dict]:
    """
    Research each gap independently via web search.
    Runs all searches in parallel for speed.
    """
    tech_stack = context.get("detected_tech_stack", [])
    tech_hint = f" (tech stack: {', '.join(tech_stack)})" if tech_stack else ""

    async def _research_one(gap: dict) -> dict:
        try:
            response = await agent.invoke(
                prompt=f"""Research the best current options for this specific decision.
Use web search to find what's recommended RIGHT NOW (2025-2026).

Task context: {task}{tech_hint}
Decision: {gap["topic"]}
Why it matters: {gap["why"]}

Find 2-4 concrete options. For each option, provide:
OPTION: <name>
RATIONALE: <1-2 sentences: why this is a good choice, based on your research>
TRADE_OFF: <1 sentence: the main downside or when NOT to use this>

Focus on specific tools, libraries, patterns — not vague advice.
Include version numbers where relevant.""",
                model="sonnet",
                max_turns=3,  # Allow web search tool use
            )
            return {"topic": gap["topic"], "why": gap["why"], "research": response.text}
        except Exception as exc:
            logger.debug("Research failed for gap '%s': %s", gap["topic"], exc)
            return {"topic": gap["topic"], "why": gap["why"], "research": ""}

    results = await asyncio.gather(*[_research_one(g) for g in gaps])
    return list(results)


# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Question Formulation
# ═══════════════════════════════════════════════════════════════════════════════


async def _formulate_questions(
    agent,
    task: str,
    context: dict,
    gaps: list[dict],
    research_results: list[dict],
) -> dict:
    """
    Generate research-backed questions with dynamic count based on complexity.
    Each option includes a rationale from the research phase.
    """
    context_block = _build_context_block(context)

    # Build research summary for the prompt
    research_block = "\n\nResearch findings per decision:\n"
    for r in research_results:
        research_block += f"\n### {r['topic']}\n{r['research'][:600]}\n"

    response = await agent.invoke(
        prompt=f"""Based on your analysis and research, generate clarification questions for the user.

Task: {task}
{context_block}{research_block}

Knowledge gaps identified:
{chr(10).join(f"- {g['topic']}: {g['why']}" for g in gaps)}

Respond with EXACTLY this structure:

INTENT: <implementation|fix|research|investigation|evaluation|open_ended>
COMPLEXITY: <simple|moderate|complex>
SKIP_PLANNING: no
EXISTING_PROJECT: <yes|no>
REQUIREMENTS:
- <requirement 1>
- <requirement 2>
APPROACH: <1-2 sentence approach>
LESSONS: <any relevant lessons from past experiences, or "none">
QUESTIONS:
- <question text> | OPTIONS: <A. option (rationale)>, <B. option (rationale)>, <C. option (rationale)>
- <question text> | OPTIONS: <A. option (rationale)>, <B. option (rationale)>

Rules for QUESTIONS:
- Generate exactly ONE question per knowledge gap. {len(gaps)} gaps = {len(gaps)} questions.
- EVERY option must include a brief rationale in parentheses, derived from your research.
  Example: "A. Passkey/WebAuthn (passwordless, best UX, adopted by Google/Apple in 2025)"
- Options must be concrete and specific — library names, pattern names, version numbers.
- The LAST option can be "Other (specify)" for custom answers.
- Do NOT add questions beyond the identified gaps.
- Do NOT ask vague or yes/no questions. Every question is a decision point.

Rules for EXISTING_PROJECT:
- If working directory has source files, this is MODIFICATION not building from scratch.""",
        model="opus",
        max_turns=1,
    )

    analysis_text = response.text
    skip_planning = _parse_skip_planning(analysis_text)
    intake_analysis = _parse_analysis(analysis_text)
    questions = _parse_questions_with_options(analysis_text)

    if context["detected_tech_stack"]:
        intake_analysis["tech_stack"] = ", ".join(context["detected_tech_stack"])

    result: dict = {
        "skip_planning": skip_planning,
        "intake_analysis": intake_analysis,
        "messages": [f"Intake: {analysis_text[:500]}"],
    }
    if questions:
        result["clarification_questions"] = questions
    if context["microagent_context"]:
        result["microagent_context"] = context["microagent_context"]
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Quick Classify (for simple tasks with no gaps)
# ═══════════════════════════════════════════════════════════════════════════════


async def _quick_classify(agent, task: str, context: dict) -> dict:
    """Fast classification for simple tasks — no questions needed."""
    context_block = _build_context_block(context)

    response = await agent.invoke(
        prompt=f"""Classify this simple task.

Task: {task}
{context_block}

Respond with:
INTENT: <implementation|fix|research|investigation|evaluation|open_ended>
COMPLEXITY: simple
SKIP_PLANNING: yes
EXISTING_PROJECT: <yes|no>
REQUIREMENTS:
- <requirement 1>
APPROACH: <1 sentence approach>
LESSONS: none""",
        model="sonnet",  # Sonnet is fine for simple classification
        max_turns=1,
    )

    analysis = _parse_analysis(response.text)
    analysis["skip_planning"] = True
    return analysis


# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Plan Generation (with user's answers)
# ═══════════════════════════════════════════════════════════════════════════════


async def _phase2_plan(agent, state: PipelineState, context: dict) -> dict:
    """Generate execution plan after user answered clarification questions."""
    task = state["task"]
    working_dir = state["working_dir"]
    context_block = _build_context_block(context)

    answers = state["clarification_answers"]
    questions = state.get("clarification_questions", [])
    answers_context = "\n\nUser's clarification answers:\n"
    for i, (q, a) in enumerate(zip(questions, answers, strict=False)):
        answers_context += f"Q{i + 1}: {q}\nA{i + 1}: {a}\n"

    response = await agent.invoke(
        prompt=f"""You previously analyzed this task and the user answered your questions.
Now generate a detailed execution plan.

Task: {task}
Working directory: {working_dir}
{context_block}{answers_context}

Respond with EXACTLY this structure:
INTENT: <implementation|fix|research|investigation|evaluation|open_ended>
COMPLEXITY: <simple|moderate|complex>
SKIP_PLANNING: <yes|no>
EXISTING_PROJECT: <yes|no>
REQUIREMENTS:
- <requirement 1>
- <requirement 2>
APPROACH: <1-2 sentence approach>
LESSONS: <any relevant lessons from past experiences, or "none">

PLAN:
<A clear, step-by-step execution plan in 3-8 steps. Each step should be one sentence.>

SCOPE:
- MODIFY: <comma-separated list of existing files/dirs that WILL be changed>
- CREATE: <comma-separated list of new files/dirs to create>
- DO_NOT_TOUCH: <comma-separated list of files/dirs that must NOT be modified>

DONE_WHEN:
- <success criterion 1: specific, testable condition>
- <success criterion 2>
- <success criterion 3>

Rules:
- PLAN must incorporate the user's answers to your earlier questions.
- SCOPE must be specific. List actual file paths where possible based on codebase analysis.
- DONE_WHEN must be concrete and verifiable (e.g. "Server starts without errors", "All tests pass").
- DO_NOT_TOUCH should include core config files, unrelated modules, etc.

Be concise. No extra prose outside the structure.""",
        model="opus",
        max_turns=3,
    )

    analysis_text = response.text
    skip_planning = _parse_skip_planning(analysis_text)
    intake_analysis = _parse_analysis(analysis_text)
    intake_analysis["plan"] = _parse_section(analysis_text, "PLAN")
    intake_analysis["scope"] = _parse_scope(analysis_text)
    intake_analysis["done_when"] = _parse_list_section(analysis_text, "DONE_WHEN")

    if context["detected_tech_stack"]:
        intake_analysis["tech_stack"] = ", ".join(context["detected_tech_stack"])

    result: dict = {
        "skip_planning": skip_planning,
        "intake_analysis": intake_analysis,
        "messages": [f"Intake: {analysis_text[:500]}"],
    }
    if context["microagent_context"]:
        result["microagent_context"] = context["microagent_context"]
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Codebase Scanning (unchanged from original)
# ═══════════════════════════════════════════════════════════════════════════════


def _scan_working_dir(working_dir: str) -> tuple[str, list[str], list[str]]:
    """
    Scan the working directory for existing files and detect tech stack.

    Returns:
        Tuple of (context_string, detected_tech_stack_list, all_relative_paths).
    """
    import json
    import os

    if not os.path.isdir(working_dir):
        return "", [], []

    skip = {".git", "node_modules", "__pycache__", ".venv", "dist", ".next", "build"}
    try:
        entries = [e for e in os.listdir(working_dir) if e not in skip and not e.startswith(".")]
    except OSError:
        return "", [], []

    if not entries:
        return "\nExisting codebase: EMPTY directory (building from scratch)\n", [], []

    file_count = 0
    extensions: dict[str, int] = {}
    all_paths: list[str] = []
    for root, dirs, files in os.walk(working_dir):
        dirs[:] = [d for d in dirs if d not in skip]
        rel_root = os.path.relpath(root, working_dir)
        for f in files:
            file_count += 1
            rel_path = f if rel_root == "." else os.path.join(rel_root, f)
            all_paths.append(rel_path)
            ext = os.path.splitext(f)[1].lower()
            if ext:
                extensions[ext] = extensions.get(ext, 0) + 1

    tech_stack: list[str] = []
    detected_configs: list[str] = []

    pkg_json = os.path.join(working_dir, "package.json")
    if os.path.exists(pkg_json):
        detected_configs.append("package.json")
        try:
            with open(pkg_json) as f:
                data = json.loads(f.read())
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if "react" in deps:
                tech_stack.append("React")
            if "vue" in deps:
                tech_stack.append("Vue")
            if "next" in deps:
                tech_stack.append("Next.js")
            if "express" in deps:
                tech_stack.append("Express")
            if "fastify" in deps:
                tech_stack.append("Fastify")
            if "vite" in deps:
                tech_stack.append("Vite")
            if "typescript" in deps:
                tech_stack.append("TypeScript")
            if "better-sqlite3" in deps or "sqlite3" in deps:
                tech_stack.append("SQLite")
            if "prisma" in deps or "@prisma/client" in deps:
                tech_stack.append("Prisma")
            if "tailwindcss" in deps:
                tech_stack.append("Tailwind CSS")
        except Exception:
            tech_stack.append("Node.js")

    if os.path.exists(os.path.join(working_dir, "pyproject.toml")):
        detected_configs.append("pyproject.toml")
        tech_stack.append("Python")
    if os.path.exists(os.path.join(working_dir, "requirements.txt")):
        detected_configs.append("requirements.txt")
        tech_stack.append("Python")
    if os.path.exists(os.path.join(working_dir, "manage.py")):
        tech_stack.append("Django")
    if os.path.exists(os.path.join(working_dir, "app.py")) or os.path.exists(os.path.join(working_dir, "main.py")):
        for fname in ["app.py", "main.py"]:
            fpath = os.path.join(working_dir, fname)
            if os.path.exists(fpath):
                try:
                    with open(fpath) as ff:
                        content = ff.read(500)
                    if "flask" in content.lower():
                        tech_stack.append("Flask")
                    if "fastapi" in content.lower():
                        tech_stack.append("FastAPI")
                except Exception:
                    pass

    if os.path.exists(os.path.join(working_dir, "Dockerfile")):
        detected_configs.append("Dockerfile")
        tech_stack.append("Docker")
    if os.path.exists(os.path.join(working_dir, "docker-compose.yml")) or os.path.exists(
        os.path.join(working_dir, "docker-compose.yaml")
    ):
        tech_stack.append("Docker Compose")

    top_exts = sorted(extensions.items(), key=lambda x: -x[1])[:5]
    ext_summary = ", ".join(f"{ext}({cnt})" for ext, cnt in top_exts)

    parts = ["\nExisting codebase analysis:"]
    parts.append(f"- Files: {file_count} total ({ext_summary})")
    parts.append(f"- Top-level: {', '.join(sorted(entries)[:15])}")
    if tech_stack:
        parts.append(f"- Tech stack detected: {', '.join(tech_stack)}")
    if detected_configs:
        parts.append(f"- Config files: {', '.join(detected_configs)}")
    parts.append(
        f"- Status: {'EXISTING PROJECT — modify/extend, do NOT rebuild from scratch' if file_count > 3 else 'Near-empty — build from scratch'}"
    )

    return "\n".join(parts) + "\n", tech_stack, all_paths


# ─── Smart File Reading ──────────────────────────────────────────────────────

MAX_FILE_CONTENT_CHARS = 12_000
MAX_SINGLE_FILE_CHARS = 3_000
MAX_FILES_TO_READ = 8

_SOURCE_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".vue",
    ".svelte",
    ".go",
    ".rs",
    ".java",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".css",
    ".scss",
    ".html",
    ".sql",
    ".graphql",
}

_ENTRY_POINTS = {
    "main.py",
    "app.py",
    "server.py",
    "manage.py",
    "wsgi.py",
    "asgi.py",
    "index.ts",
    "index.js",
    "index.tsx",
    "index.jsx",
    "main.ts",
    "main.tsx",
    "main.js",
    "server.ts",
    "server.js",
    "App.tsx",
    "App.jsx",
    "App.vue",
}

_STOPWORDS = {
    "the",
    "a",
    "an",
    "is",
    "it",
    "to",
    "for",
    "in",
    "on",
    "of",
    "and",
    "or",
    "fix",
    "add",
    "create",
    "build",
    "make",
    "update",
    "implement",
    "bug",
    "issue",
    "please",
    "can",
    "you",
    "i",
    "my",
    "we",
    "should",
    "need",
    "want",
    "would",
    "like",
    "this",
    "that",
    "with",
    "from",
    "into",
    "not",
    "all",
    "some",
    "new",
    "use",
    "using",
    "help",
    "get",
    "set",
    "has",
    "have",
}


def _extract_task_keywords(task: str) -> list[str]:
    import re

    words = re.findall(r"[a-zA-Z]{3,}", task.lower())
    return [w for w in words if w not in _STOPWORDS]


def _smart_truncate(content: str, max_chars: int) -> str:
    if len(content) <= max_chars:
        return content
    lines = content.splitlines()
    head = lines[:20]
    sig_patterns = (
        "def ",
        "async def ",
        "class ",
        "export ",
        "function ",
        "interface ",
        "type ",
        "const ",
        "router.",
        "@app.",
    )
    signatures = [ln for ln in lines[20:] if any(ln.lstrip().startswith(p) for p in sig_patterns)]
    result = "\n".join(head)
    if signatures:
        result += "\n\n# ... (truncated) key signatures:\n" + "\n".join(signatures[:30])
    return result[:max_chars]


def _read_key_files(
    working_dir: str,
    task: str,
    tech_stack: list[str],
    all_paths: list[str],
) -> str:
    import os

    keywords = _extract_task_keywords(task)

    scored: list[tuple[float, str]] = []
    for rel_path in all_paths:
        ext = os.path.splitext(rel_path)[1].lower()
        if ext not in _SOURCE_EXTENSIONS:
            continue
        lower_path = rel_path.lower()
        score = 0.0
        basename = os.path.basename(rel_path)
        if basename in _ENTRY_POINTS:
            score += 5.0
        for kw in keywords:
            if kw in lower_path:
                score += 3.0
        for pattern in ("model", "schema", "types", "interface", "route", "url", "config"):
            if pattern in lower_path:
                score += 1.5
                break
        depth = rel_path.count(os.sep)
        score -= depth * 0.3

        if score > 0:
            scored.append((score, rel_path))

    if not scored:
        return ""

    scored.sort(key=lambda x: -x[0])
    selected = scored[:MAX_FILES_TO_READ]

    parts = ["\nKey source files (auto-selected for relevance):"]
    budget_remaining = MAX_FILE_CONTENT_CHARS

    for _score, rel_path in selected:
        if budget_remaining <= 0:
            break
        full_path = os.path.join(working_dir, rel_path)
        try:
            with open(full_path, encoding="utf-8", errors="ignore") as f:
                raw = f.read(MAX_SINGLE_FILE_CHARS + 500)
            truncated = _smart_truncate(raw, min(MAX_SINGLE_FILE_CHARS, budget_remaining))
            parts.append(f"\n--- {rel_path} ---\n{truncated}")
            budget_remaining -= len(truncated)
        except OSError:
            continue

    if len(parts) == 1:
        return ""
    return "\n".join(parts) + "\n"


# ═══════════════════════════════════════════════════════════════════════════════
# Parsers
# ═══════════════════════════════════════════════════════════════════════════════


def _parse_analysis(text: str) -> dict:
    analysis: dict = {}
    requirements: list[str] = []
    current_key = ""
    _END_SECTIONS = {
        "INTENT",
        "COMPLEXITY",
        "SKIP_PLANNING",
        "EXISTING_PROJECT",
        "APPROACH",
        "LESSONS",
        "QUESTIONS",
        "PLAN",
        "SCOPE",
        "DONE_WHEN",
    }

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        matched_section = False
        for key in ["INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT", "APPROACH", "LESSONS"]:
            if stripped.upper().startswith(f"{key}:"):
                value = stripped.split(":", 1)[1].strip()
                analysis[key.lower()] = value
                current_key = key.lower()
                matched_section = True
                break

        if not matched_section:
            if stripped.upper().startswith("REQUIREMENTS:"):
                current_key = "requirements"
            elif current_key == "requirements":
                if any(stripped.upper().startswith(f"{s}:") for s in _END_SECTIONS):
                    current_key = ""
                elif stripped.startswith("- "):
                    requirements.append(stripped[2:].strip())

    if requirements:
        analysis["requirements"] = requirements

    return analysis


def _parse_questions_with_options(text: str) -> list[dict]:
    questions: list[dict] = []
    in_questions = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("QUESTIONS:"):
            in_questions = True
            continue
        if in_questions:
            if stripped.startswith("- ") and len(stripped) > 4:
                content = stripped[2:].strip()
                if "| OPTIONS:" in content or "|OPTIONS:" in content:
                    parts = content.split("| OPTIONS:" if "| OPTIONS:" in content else "|OPTIONS:", 1)
                    question_text = parts[0].strip()
                    options = _split_options(parts[1].strip())
                    questions.append({"question": question_text, "options": options})
                else:
                    questions.append({"question": content, "options": []})
            elif stripped and not stripped.startswith("-"):
                break
    return questions


def _split_options(raw: str) -> list[str]:
    import re

    parts = re.split(r",\s*(?=[A-Z]\.)", raw)
    return [p.strip() for p in parts if p.strip()]


def _parse_section(text: str, section_name: str) -> str:
    lines: list[str] = []
    in_section = False
    known_sections = {
        "INTENT",
        "COMPLEXITY",
        "SKIP_PLANNING",
        "EXISTING_PROJECT",
        "REQUIREMENTS",
        "APPROACH",
        "LESSONS",
        "PLAN",
        "SCOPE",
        "DONE_WHEN",
        "QUESTIONS",
        "MODIFY",
        "CREATE",
        "DO_NOT_TOUCH",
    }
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith(f"{section_name}:"):
            in_section = True
            after = stripped.split(":", 1)[1].strip()
            if after:
                lines.append(after)
            continue
        if in_section:
            if any(stripped.upper().startswith(f"{s}:") for s in known_sections if s != section_name):
                break
            if stripped:
                lines.append(stripped.lstrip("- ").strip() if stripped.startswith("- ") else stripped)
    return "\n".join(lines)


def _parse_list_section(text: str, section_name: str) -> list[str]:
    items: list[str] = []
    in_section = False
    known_sections = {
        "INTENT",
        "COMPLEXITY",
        "SKIP_PLANNING",
        "EXISTING_PROJECT",
        "REQUIREMENTS",
        "APPROACH",
        "LESSONS",
        "PLAN",
        "SCOPE",
        "DONE_WHEN",
        "QUESTIONS",
        "MODIFY",
        "CREATE",
        "DO_NOT_TOUCH",
    }
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith(f"{section_name}:"):
            in_section = True
            continue
        if in_section:
            if any(stripped.upper().startswith(f"{s}:") for s in known_sections if s != section_name):
                break
            if stripped.startswith("- ") and len(stripped) > 3:
                items.append(stripped[2:].strip())
    return items


def _parse_scope(text: str) -> dict:
    scope: dict = {"modify": [], "create": [], "do_not_touch": []}
    in_scope = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SCOPE:"):
            in_scope = True
            continue
        if in_scope:
            if any(
                stripped.upper().startswith(f"{s}:") for s in ["DONE_WHEN", "QUESTIONS", "PLAN", "LESSONS", "INTENT"]
            ):
                break
            for key in ["MODIFY", "CREATE", "DO_NOT_TOUCH"]:
                if stripped.upper().startswith(f"- {key}:") or stripped.upper().startswith(f"{key}:"):
                    val = stripped.split(":", 1)[1].strip()
                    scope[key.lower()] = [v.strip() for v in val.split(",") if v.strip()]
                    break
    return scope


def _parse_skip_planning(text: str) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SKIP_PLANNING:"):
            value = stripped.split(":", 1)[1].strip().lower()
            return value == "yes"
    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Harness Gate — must pass before AGI/Pair can proceed
# ═══════════════════════════════════════════════════════════════════════════════


async def _harness_gate(
    working_dir: str,
    provider: str = "claude",
    harness_confirmed: bool = False,
    project_description: str = "",
) -> dict | None:
    """Check harness quality. If insufficient, ask user before setting up.

    Returns None if harness passes (proceed normally).
    Returns a dict (intake result) if harness needs user input first.

    Flow:
      1. Score check (deterministic)
      2. If passing → proceed
      3. If not passing and not confirmed → ask user (return questions)
      4. If not passing and confirmed → auto-setup with user's description
    """
    import os

    try:
        from openseed_core.harness.checker import check_harness_quality

        score = check_harness_quality(working_dir)
        logger.info("Harness gate: %d/100 (pass=%s)", score.total, score.passing)

        if score.passing:
            await _emit("intake.harness.pass", message=f"Harness OK ({score.total}/100)")
            return None  # Pass — proceed to intake

        # ── Not passing: need user confirmation first ──

        if not harness_confirmed:
            # Gather context to show user what we detected
            has_readme = os.path.isfile(os.path.join(working_dir, "README.md"))
            readme_preview = ""
            if has_readme:
                try:
                    with open(os.path.join(working_dir, "README.md")) as f:
                        readme_preview = f.read(500).strip()
                except Exception:
                    pass

            context_msg = ""
            if has_readme and readme_preview:
                context_msg = (
                    f"README.md found. Preview:\n> {readme_preview[:200]}...\n\n"
                    f"We can use this to generate your harness. "
                    f"Or describe your project in your own words for more accurate results."
                )
            else:
                context_msg = (
                    "No README.md found. Please describe your project so we can "
                    "generate an accurate harness."
                )

            await _emit(
                "intake.harness.ask",
                message=f"Harness quality low ({score.total}/100). Asking user...",
                score=score.total,
            )

            return {
                "skip_planning": True,
                "intake_analysis": {
                    "skip_planning": True,
                    "harness_needs_setup": True,
                    "harness_score": score.total,
                    "harness_missing": score.missing,
                },
                "clarification_questions": [
                    {
                        "question": (
                            f"Your project needs a harness setup ({score.total}/100, minimum: 60).\n\n"
                            f"{context_msg}\n\n"
                            f"Missing:\n"
                            + "\n".join(f"- {m}" for m in score.missing)
                        ),
                        "options": [
                            "Auto-generate from README" if has_readme else "",
                            "Let me describe the project",
                        ],
                        "input_placeholder": "Describe your project (optional — improves accuracy)",
                        "category": "harness",
                    }
                ],
                "messages": ["Harness setup needed. Please confirm or describe your project."],
            }

        # ── User confirmed: run auto-setup ──

        await _emit(
            "intake.harness.setup",
            message=f"Setting up harness ({score.total}/100)...",
        )
        await _auto_harness_setup(working_dir, provider, project_description)

        # Re-check after setup
        new_score = check_harness_quality(working_dir)
        logger.info("Harness gate after setup: %d/100", new_score.total)

        if new_score.passing:
            await _emit(
                "intake.harness.pass",
                message=f"Harness setup complete ({score.total} → {new_score.total}/100)",
            )
            return None  # Pass — proceed to intake

        # Still insufficient after auto-setup
        await _emit(
            "intake.harness.blocked",
            message=f"Harness still insufficient ({new_score.total}/100).",
        )
        return {
            "skip_planning": True,
            "intake_analysis": {
                "skip_planning": True,
                "harness_blocked": True,
                "harness_score": new_score.total,
                "harness_missing": new_score.missing,
            },
            "clarification_questions": [
                {
                    "question": (
                        f"Auto-setup completed but harness is still at {new_score.total}/100.\n\n"
                        f"Missing:\n" + "\n".join(f"- {m}" for m in new_score.missing)
                        + "\n\nPlease set these up manually."
                    ),
                    "options": [],
                    "category": "harness",
                }
            ],
            "messages": ["Harness auto-setup incomplete. Manual setup needed."],
        }

    except Exception as exc:
        logger.debug("Harness gate skipped (non-blocking): %s", exc)
        return None


# ═══════════════════════════════════════════════════════════════════════════════
# Harness Auto-Setup
# ═══════════════════════════════════════════════════════════════════════════════


async def _auto_harness_setup(
    working_dir: str,
    provider: str = "claude",
    project_description: str = "",
) -> None:
    """Generate harness scaffold for a project.

    When scaffold is needed, AI (Claude or Codex) is used to enhance the
    deterministic scaffold with project-specific context.
    """
    try:
        from openseed_core.harness.checker import check_harness_quality
        from openseed_core.harness.generator import generate_scaffold, get_ai_guide, scan_project

        score = check_harness_quality(working_dir)
        logger.info("Harness quality: %d/100 (pass=%s)", score.total, score.passing)

        if score.passing:
            return  # Harness is good enough

        await _emit(
            "intake.harness.setup",
            message=f"Harness quality low ({score.total}/100). Setting up...",
            score=score.total,
            missing=score.missing,
        )

        # Step 1: Deterministic scan + scaffold
        scan = scan_project(working_dir)
        scaffold_files = generate_scaffold(scan)

        # Step 2: AI enhancement — fill TODOs with project-specific content
        ai_guide = get_ai_guide()
        enhanced_files = await _enhance_scaffold_with_ai(
            scaffold_files, scan, ai_guide, working_dir, provider, project_description,
        )

        # Step 3: Write files to disk
        import os

        for f in enhanced_files:
            full_path = os.path.join(working_dir, f.path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w") as fh:
                fh.write(f.content)
            logger.info("Harness: wrote %s", f.path)

        # Step 4: Create CLAUDE.md symlink if missing
        claude_md = os.path.join(working_dir, "CLAUDE.md")
        agents_md = os.path.join(working_dir, "AGENTS.md")
        if not os.path.exists(claude_md) and os.path.exists(agents_md):
            try:
                os.symlink("AGENTS.md", claude_md)
                logger.info("Harness: created CLAUDE.md -> AGENTS.md symlink")
            except OSError:
                pass  # Symlink not supported (Windows without dev mode)

        # Verify improvement
        new_score = check_harness_quality(working_dir)
        await _emit(
            "intake.harness.done",
            message=f"Harness setup complete ({score.total} → {new_score.total}/100)",
            before=score.total,
            after=new_score.total,
        )
        logger.info("Harness improved: %d → %d", score.total, new_score.total)

    except Exception as exc:
        logger.debug("Harness auto-setup skipped: %s", exc)


async def _enhance_scaffold_with_ai(
    scaffold_files: list,
    scan,
    ai_guide: str,
    working_dir: str,
    provider: str,
    project_description: str = "",
) -> list:
    """Use AI to replace [TODO] placeholders with project-specific content.

    Uses (in priority order):
    1. User's project description (if provided)
    2. README.md content
    3. Scan results only (fallback)
    """
    import os

    # Gather project context for AI
    context_parts: list[str] = []

    # User description takes priority
    if project_description.strip():
        context_parts.append(f"User's project description:\n{project_description}")

    readme = os.path.join(working_dir, "README.md")
    if os.path.isfile(readme):
        try:
            with open(readme) as f:
                context_parts.append(f"README.md:\n{f.read(3000)}")
        except Exception:
            pass

    # Find root AGENTS.md scaffold
    root_agents = None
    for f in scaffold_files:
        if f.path == "AGENTS.md":
            root_agents = f
            break

    if not root_agents:
        return scaffold_files

    # Build AI prompt
    prompt = (
        f"You are setting up a harness for a project. Follow the guide below EXACTLY.\n\n"
        f"## AI Harness Guide\n{ai_guide}\n\n"
        f"## Detected Project Info\n"
        f"- Name: {scan.name}\n"
        f"- Languages: {', '.join(scan.languages) or 'unknown'}\n"
        f"- Frameworks: {', '.join(scan.frameworks) or 'none'}\n"
        f"- Package manager: {scan.package_manager or 'unknown'}\n"
        f"- Monorepo: {scan.is_monorepo} ({scan.monorepo_tool or 'n/a'})\n"
        f"- Commands: {scan.commands}\n\n"
    )
    if context_parts:
        prompt += f"## Project Context\n{''.join(context_parts)}\n\n"

    prompt += (
        f"## Current AGENTS.md (scaffold with TODOs)\n"
        f"```markdown\n{root_agents.content}\n```\n\n"
        f"Replace ALL [TODO: ...] placeholders with accurate project-specific content. "
        f"Return ONLY the complete AGENTS.md content, no explanations. "
        f"Keep it under 150 lines. Follow the 5 principles from the guide."
    )

    try:
        if provider == "codex":
            from openseed_codex.agent import CodexAgent

            agent = CodexAgent()
            response = await agent.invoke(prompt=prompt, max_turns=3)
        else:
            from openseed_claude.agent import ClaudeAgent

            agent = ClaudeAgent()
            response = await agent.invoke(prompt=prompt, model="sonnet", max_turns=3)

        enhanced_content = response.text.strip()

        # Validate: don't use error messages as content
        if not enhanced_content or "error" in enhanced_content.lower()[:50] or len(enhanced_content) < 50:
            logger.debug("AI enhancement produced invalid content, keeping scaffold")
            return scaffold_files

        # Extract markdown content if wrapped in code fence
        if "```markdown" in enhanced_content:
            start = enhanced_content.index("```markdown") + len("```markdown")
            end = enhanced_content.rindex("```")
            enhanced_content = enhanced_content[start:end].strip()
        elif enhanced_content.startswith("```"):
            lines = enhanced_content.split("\n")
            enhanced_content = "\n".join(lines[1:-1]).strip()

        # Final validation: must look like AGENTS.md (has # heading)
        if not enhanced_content.startswith("#"):
            logger.debug("AI enhancement doesn't look like markdown, keeping scaffold")
            return scaffold_files

        # Replace root AGENTS.md with enhanced version
        for f in scaffold_files:
            if f.path == "AGENTS.md":
                f.content = enhanced_content
                break

        # Enhance sub-AGENTS.md files with AI
        sub_files = [f for f in scaffold_files if f.path != "AGENTS.md" and f.path.endswith("AGENTS.md")]
        if sub_files:
            await _enhance_sub_agents_with_ai(sub_files, scan, working_dir, provider)

    except Exception as exc:
        logger.debug("AI enhancement skipped: %s", exc)
        # Fall back to deterministic scaffold (still useful)

    return scaffold_files


async def _enhance_sub_agents_with_ai(
    sub_files: list,
    scan,
    working_dir: str,
    provider: str,
) -> None:
    """Enhance sub-package AGENTS.md files with AI-generated rules."""
    import os

    for f in sub_files:
        # Read key files from the package to give AI context
        pkg_dir = os.path.join(working_dir, os.path.dirname(f.path))
        pkg_context = ""
        for name in ["__init__.py", "index.ts", "index.js", "main.py", "app.py"]:
            entry = os.path.join(pkg_dir, name)
            if not os.path.isfile(entry):
                # Check src/ subdirectory
                for src_sub in os.listdir(pkg_dir) if os.path.isdir(pkg_dir) else []:
                    candidate = os.path.join(pkg_dir, src_sub, name)
                    if os.path.isfile(candidate):
                        entry = candidate
                        break
            if os.path.isfile(entry):
                try:
                    with open(entry) as fh:
                        pkg_context = fh.read(2000)
                    break
                except Exception:
                    pass

        if not pkg_context:
            continue  # No context to enhance with — keep deterministic version

        prompt = (
            f"You are writing a sub-package AGENTS.md for {f.path}.\n\n"
            f"## Rules\n"
            f"- Under 30 lines total\n"
            f"- Sections: Scope (1 line), Rules (package-specific only), Testing\n"
            f"- Do NOT include toolchain rules (linter, formatter)\n"
            f"- Only include what agents cannot infer from code\n\n"
            f"## Package entry point code:\n```\n{pkg_context}\n```\n\n"
            f"## Current scaffold:\n```markdown\n{f.content}\n```\n\n"
            f"Replace [TODO] with accurate rules based on the code. "
            f"Return ONLY the markdown content."
        )

        try:
            if provider == "codex":
                from openseed_codex.agent import CodexAgent

                agent = CodexAgent()
                response = await agent.invoke(prompt=prompt, max_turns=3)
            else:
                from openseed_claude.agent import ClaudeAgent

                agent = ClaudeAgent()
                response = await agent.invoke(prompt=prompt, model="haiku", max_turns=3)

            content = response.text.strip()
            if "```markdown" in content:
                start = content.index("```markdown") + len("```markdown")
                end = content.rindex("```")
                content = content[start:end].strip()
            elif content.startswith("```"):
                lines = content.split("\n")
                content = "\n".join(lines[1:-1]).strip()

            if content and len(content.splitlines()) <= 35:
                f.content = content
        except Exception as exc:
            logger.debug("Sub-AGENTS.md AI enhancement skipped for %s: %s", f.path, exc)
