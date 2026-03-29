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

from openseed_brain.state import PipelineState

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════════
# Main Entry Point
# ═══════════════════════════════════════════════════════════════════════════════


async def intake_node(state: PipelineState) -> dict:
    """
    Multi-step intake: context → gaps → research → questions (or plan if answers exist).
    """
    # ── Fast path: plan already approved by user (from frontend Phase 2) ──
    existing = state.get("intake_analysis")
    if existing and existing.get("plan"):
        logger.info("Intake: using pre-approved plan, skipping analysis")
        return {
            "skip_planning": True,  # Skip plan_node — plan is already done
            "intake_analysis": existing,
            "messages": ["Intake: using user-approved plan"],
        }

    task = state["task"]
    working_dir = state["working_dir"]
    has_answers = bool(state.get("clarification_answers"))

    # ── Step 1: Context Collection (always runs) ──
    context = await _collect_context(task, working_dir)

    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()

    if has_answers:
        # Phase 2: Generate execution plan from user's answers
        return await _phase2_plan(agent, state, context)

    # ── Step 2: Gap Analysis — AI identifies what it doesn't know ──
    gaps = await _identify_gaps(agent, task, context)
    logger.info("Identified %d knowledge gaps", len(gaps))

    # ── Step 2.5: Select Skills — pick relevant official skills for this task ──
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
            "messages": [f"Intake: simple task, no clarification needed"],
        }

    # ── Step 3: Per-Gap Research — parallel web search for each gap ──
    research_results = await _research_gaps(agent, task, gaps, context)
    logger.info("Completed research for %d gaps", len(research_results))

    # ── Step 4: Formulate Questions — dynamic count, research-backed options ──
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
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures
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
            from openseed_memory.wisdom import recall_wisdom, format_wisdom_for_prompt
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
            load_microagents,
            select_relevant_microagents,
            format_microagent_context,
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
    agent, task: str, gaps: list[dict], context: dict,
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
Decision: {gap['topic']}
Why it matters: {gap['why']}

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
    agent, task: str, context: dict, gaps: list[dict], research_results: list[dict],
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
    for i, (q, a) in enumerate(zip(questions, answers)):
        answers_context += f"Q{i+1}: {q}\nA{i+1}: {a}\n"

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
        max_turns=1,
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
    import os
    import json

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
    if os.path.exists(os.path.join(working_dir, "docker-compose.yml")) or os.path.exists(os.path.join(working_dir, "docker-compose.yaml")):
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
    ".py", ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte",
    ".go", ".rs", ".java", ".rb", ".php", ".swift", ".kt",
    ".css", ".scss", ".html", ".sql", ".graphql",
}

_ENTRY_POINTS = {
    "main.py", "app.py", "server.py", "manage.py", "wsgi.py", "asgi.py",
    "index.ts", "index.js", "index.tsx", "index.jsx",
    "main.ts", "main.tsx", "main.js",
    "server.ts", "server.js",
    "App.tsx", "App.jsx", "App.vue",
}

_STOPWORDS = {
    "the", "a", "an", "is", "it", "to", "for", "in", "on", "of", "and", "or",
    "fix", "add", "create", "build", "make", "update", "implement", "bug",
    "issue", "please", "can", "you", "i", "my", "we", "should", "need",
    "want", "would", "like", "this", "that", "with", "from", "into", "not",
    "all", "some", "new", "use", "using", "help", "get", "set", "has", "have",
}


def _extract_task_keywords(task: str) -> list[str]:
    import re
    words = re.findall(r'[a-zA-Z]{3,}', task.lower())
    return [w for w in words if w not in _STOPWORDS]


def _smart_truncate(content: str, max_chars: int) -> str:
    if len(content) <= max_chars:
        return content
    lines = content.splitlines()
    head = lines[:20]
    sig_patterns = ("def ", "async def ", "class ", "export ", "function ",
                    "interface ", "type ", "const ", "router.", "@app.")
    signatures = [
        ln for ln in lines[20:]
        if any(ln.lstrip().startswith(p) for p in sig_patterns)
    ]
    result = "\n".join(head)
    if signatures:
        result += "\n\n# ... (truncated) key signatures:\n" + "\n".join(signatures[:30])
    return result[:max_chars]


def _read_key_files(
    working_dir: str, task: str, tech_stack: list[str], all_paths: list[str],
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
    _END_SECTIONS = {"INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT",
                     "APPROACH", "LESSONS", "QUESTIONS", "PLAN", "SCOPE", "DONE_WHEN"}

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
    parts = re.split(r',\s*(?=[A-Z]\.)', raw)
    return [p.strip() for p in parts if p.strip()]


def _parse_section(text: str, section_name: str) -> str:
    lines: list[str] = []
    in_section = False
    known_sections = {"INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT",
                      "REQUIREMENTS", "APPROACH", "LESSONS", "PLAN", "SCOPE",
                      "DONE_WHEN", "QUESTIONS", "MODIFY", "CREATE", "DO_NOT_TOUCH"}
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
    known_sections = {"INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT",
                      "REQUIREMENTS", "APPROACH", "LESSONS", "PLAN", "SCOPE",
                      "DONE_WHEN", "QUESTIONS", "MODIFY", "CREATE", "DO_NOT_TOUCH"}
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
            if any(stripped.upper().startswith(f"{s}:") for s in
                   ["DONE_WHEN", "QUESTIONS", "PLAN", "LESSONS", "INTENT"]):
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
