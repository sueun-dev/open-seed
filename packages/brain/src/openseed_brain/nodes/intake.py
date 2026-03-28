"""
Intake node — Analyze task, recall memories, classify intent, ask clarifications.

Two-phase intake:
  1. intake_node: analyze + generate clarification questions (always)
  2. intake_with_answers_node: re-analyze with user's answers, then proceed

All routing decisions are made by the LLM — no regex, no hardcoded extension checks.
"""

from __future__ import annotations

import logging

from openseed_brain.state import PipelineState

logger = logging.getLogger(__name__)


async def intake_node(state: PipelineState) -> dict:
    """
    First node: recall memories + analyze task via Claude.
    1. Search memory for similar past tasks/failures
    2. Ask Claude to classify intent, complexity, and whether planning can be skipped
    3. Return analysis + recalled memories + skip_planning flag
    """
    task = state["task"]
    working_dir = state["working_dir"]

    # ── Step 1: Classify intent via Sentinel Intent Gate ──
    intent_info = ""
    try:
        from openseed_guard.intent_gate import classify_intent
        intent = await classify_intent(task)
        intent_info = (
            f"\nIntent classification: {intent.intent_type.value} "
            f"(confidence: {intent.confidence:.1f})\n"
            f"Suggested approach: {intent.suggested_approach}\n"
        )
    except Exception as exc:
        logger.debug("Intent gate unavailable, proceeding without it: %s", exc)

    # ── Step 2: Recall relevant memories ──
    memory_context = ""
    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures
        store = MemoryStore()
        await store.initialize()

        # Search for similar tasks (uses LLM reranking automatically)
        results = await store.search(task, limit=5)
        if results:
            memory_context += "\n\nRelevant past experiences:\n"
            for r in results:
                memory_context += f"- {r.entry.content[:200]} (score: {r.score:.2f})\n"

        # Check for known failure patterns
        patterns = await recall_similar_failures(store, task, [])
        if patterns:
            memory_context += "\nKnown failure patterns for similar tasks:\n"
            for p in patterns:
                memory_context += f"- {p.error_type[:200]} → fix: {p.successful_fix}\n"

        # Recall structured wisdom from past runs
        try:
            from openseed_memory.wisdom import recall_wisdom, format_wisdom_for_prompt
            wisdoms = await recall_wisdom(store, task, limit=5)
            if wisdoms:
                wisdom_text = format_wisdom_for_prompt(wisdoms)
                if wisdom_text:
                    memory_context += wisdom_text
        except Exception:
            pass  # Wisdom recall is best-effort
    except Exception as exc:
        logger.debug("Memory unavailable, proceeding without it: %s", exc)

    # ── Step 3: Scan existing codebase + detect tech stack ──
    codebase_context = ""
    detected_tech_stack: list[str] = []
    try:
        codebase_context, detected_tech_stack = _scan_working_dir(working_dir)
        if codebase_context:
            logger.info("Codebase scan: %s", codebase_context[:100])
    except Exception as exc:
        logger.debug("Codebase scan skipped: %s", exc)

    # ── Step 4: Load microagents from working directory (OpenHands pattern) ──
    microagent_context: list[str] = []
    try:
        from openseed_core.microagent import (
            load_microagents,
            select_relevant_microagents,
            format_microagent_context,
        )
        all_agents = load_microagents(working_dir)
        relevant_agents = await select_relevant_microagents(all_agents, task)
        if relevant_agents:
            formatted = format_microagent_context(relevant_agents)
            microagent_context = [formatted]
            logger.info("Loaded %d microagents from %s", len(relevant_agents), working_dir)
    except Exception as exc:
        logger.debug("Microagent loading skipped: %s", exc)

    # ── Step 5: Research current trends (for first pass only) ──
    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()

    has_answers = bool(state.get("clarification_answers"))

    research_context = ""
    if not has_answers:
        try:
            research_response = await agent.invoke(
                prompt=f"""Research current best practices and trends for this task.
Use web search to find the latest approaches, popular tools, and modern patterns.

Task: {task}
{codebase_context}

Respond with a concise summary (max 300 words):
TRENDS:
- <current trend/best practice 1>
- <current trend/best practice 2>
- <current trend/best practice 3>
- <current trend/best practice 4>
POPULAR_TOOLS:
- <tool/library 1 with brief reason>
- <tool/library 2 with brief reason>
MODERN_PATTERNS:
- <pattern 1>
- <pattern 2>

Focus on what's popular RIGHT NOW. Include specific library names and versions where relevant.
Be factual and concise. No fluff.""",
                model="sonnet",  # Sonnet for speed on research
                max_turns=3,  # Allow tool use for web search
            )
            research_context = f"\n\nCurrent trends and best practices (from web research):\n{research_response.text[:800]}\n"
            logger.info("Trend research complete: %s", research_response.text[:100])
        except Exception as exc:
            logger.debug("Trend research skipped: %s", exc)

    # ── Step 6: Analyse task ──
    answers_context = ""
    if has_answers:
        answers = state["clarification_answers"]
        questions = state.get("clarification_questions", [])
        answers_context = "\n\nUser's clarification answers:\n"
        for i, (q, a) in enumerate(zip(questions, answers)):
            answers_context += f"Q{i+1}: {q}\nA{i+1}: {a}\n"

    # ── Phase 1: Questions (first pass) ──
    # ── Phase 2: Plan document (after user answers) ──
    if not has_answers:
        prompt = f"""Analyze this task and classify it.

Task: {task}
Working directory: {working_dir}
{intent_info}{memory_context}
{codebase_context}{research_context}

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
QUESTIONS:
- <question text> | OPTIONS: <A. option>, <B. option>, <C. option>
- <question text> | OPTIONS: <A. option>, <B. option>, <C. option>
- <question text> | OPTIONS: <A. option>, <B. option>

Rules for QUESTIONS:
- Always generate 2-4 clarification questions.
- EVERY question MUST have 2-4 concrete OPTIONS separated by commas after "OPTIONS:".
- Each option should be a specific, actionable choice (library name, pattern name, concrete approach).
- Reference current trends and tools from the research above.
- The LAST option can be "Other (specify)" to allow custom answers.
- Example: "How should users authenticate? | OPTIONS: A. Passkey/WebAuthn (modern, passwordless), B. JWT + refresh tokens (most common), C. OAuth social login (Google/GitHub), D. Other (specify)"
- Do NOT ask vague or yes/no questions. Every question must be a decision point.

Rules for SKIP_PLANNING:
- yes ONLY when: complexity is simple AND single scoped change
- no for everything else

Rules for EXISTING_PROJECT:
- If working directory has source files, this is MODIFICATION not building from scratch.

Be concise. No extra prose outside the structure."""
    else:
        prompt = f"""You previously analyzed this task and the user answered your questions.
Now generate a detailed execution plan.

Task: {task}
Working directory: {working_dir}
{intent_info}{memory_context}
{codebase_context}{research_context}{answers_context}

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
- DONE_WHEN must be concrete and verifiable (e.g. "Server starts without errors", "All tests pass", "Login page renders at /login").
- DO_NOT_TOUCH should include core config files, unrelated modules, etc.
- No QUESTIONS section needed. The user already answered.

Be concise. No extra prose outside the structure."""

    response = await agent.invoke(prompt=prompt, model="opus", max_turns=1)

    analysis_text = response.text
    skip_planning = _parse_skip_planning(analysis_text)
    intake_analysis = _parse_analysis(analysis_text)

    # Parse phase-specific outputs
    questions: list[dict] = []
    if not has_answers:
        questions = _parse_questions_with_options(analysis_text)
    else:
        intake_analysis["plan"] = _parse_section(analysis_text, "PLAN")
        intake_analysis["scope"] = _parse_scope(analysis_text)
        intake_analysis["done_when"] = _parse_list_section(analysis_text, "DONE_WHEN")

    # Inject detected tech stack into analysis for downstream nodes
    if detected_tech_stack:
        intake_analysis["tech_stack"] = ", ".join(detected_tech_stack)

    result: dict = {
        "skip_planning": skip_planning,
        "intake_analysis": intake_analysis,
        "messages": [f"Intake: {analysis_text[:500]}"],
    }
    if not has_answers and questions:
        result["clarification_questions"] = questions
    if microagent_context:
        result["microagent_context"] = microagent_context
    return result


def _scan_working_dir(working_dir: str) -> tuple[str, list[str]]:
    """
    Scan the working directory for existing files and detect tech stack.

    Returns:
        Tuple of (context_string, detected_tech_stack_list).
        - context_string: human-readable summary for the LLM prompt
        - detected_tech_stack_list: e.g. ["React", "Express", "TypeScript"]
    """
    import os
    import json

    if not os.path.isdir(working_dir):
        return "", []

    # List top-level files/dirs (skip hidden, node_modules, etc.)
    skip = {".git", "node_modules", "__pycache__", ".venv", "dist", ".next", "build"}
    try:
        entries = [e for e in os.listdir(working_dir) if e not in skip and not e.startswith(".")]
    except OSError:
        return "", []

    if not entries:
        return "\nExisting codebase: EMPTY directory (building from scratch)\n", []

    # Count files recursively
    file_count = 0
    extensions: dict[str, int] = {}
    for root, dirs, files in os.walk(working_dir):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            file_count += 1
            ext = os.path.splitext(f)[1].lower()
            if ext:
                extensions[ext] = extensions.get(ext, 0) + 1

    # Detect tech stack from config files
    tech_stack: list[str] = []
    detected_configs: list[str] = []

    # Node.js / JavaScript
    pkg_json = os.path.join(working_dir, "package.json")
    if os.path.exists(pkg_json):
        detected_configs.append("package.json")
        try:
            data = json.loads(open(pkg_json).read())
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

    # Python
    if os.path.exists(os.path.join(working_dir, "pyproject.toml")):
        detected_configs.append("pyproject.toml")
        tech_stack.append("Python")
    if os.path.exists(os.path.join(working_dir, "requirements.txt")):
        detected_configs.append("requirements.txt")
        tech_stack.append("Python")
    if os.path.exists(os.path.join(working_dir, "manage.py")):
        tech_stack.append("Django")
    if os.path.exists(os.path.join(working_dir, "app.py")) or os.path.exists(os.path.join(working_dir, "main.py")):
        # Check for Flask/FastAPI
        for fname in ["app.py", "main.py"]:
            fpath = os.path.join(working_dir, fname)
            if os.path.exists(fpath):
                try:
                    content = open(fpath).read(500)
                    if "flask" in content.lower():
                        tech_stack.append("Flask")
                    if "fastapi" in content.lower():
                        tech_stack.append("FastAPI")
                except Exception:
                    pass

    # Docker
    if os.path.exists(os.path.join(working_dir, "Dockerfile")):
        detected_configs.append("Dockerfile")
        tech_stack.append("Docker")
    if os.path.exists(os.path.join(working_dir, "docker-compose.yml")) or os.path.exists(os.path.join(working_dir, "docker-compose.yaml")):
        tech_stack.append("Docker Compose")

    # Build context string
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

    return "\n".join(parts) + "\n", tech_stack


def _parse_analysis(text: str) -> dict:
    """
    Parse Claude's structured intake response into a dict.
    Extracts: INTENT, COMPLEXITY, REQUIREMENTS, APPROACH, LESSONS, EXISTING_PROJECT.
    Downstream nodes (plan_node, implement_node) can read these.
    """
    analysis: dict = {}
    requirements: list[str] = []
    current_key = ""

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        # Key: value lines
        for key in ["INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT", "APPROACH", "LESSONS"]:
            if stripped.upper().startswith(f"{key}:"):
                value = stripped.split(":", 1)[1].strip()
                analysis[key.lower()] = value
                current_key = key.lower()
                break
        else:
            if stripped.upper().startswith("REQUIREMENTS:"):
                current_key = "requirements"
            elif current_key == "requirements" and stripped.startswith("- "):
                requirements.append(stripped[2:].strip())

    if requirements:
        analysis["requirements"] = requirements

    return analysis


def _parse_questions_with_options(text: str) -> list[dict]:
    """
    Extract QUESTIONS with OPTIONS from Claude's structured response.

    Format: "- question text | OPTIONS: A. opt1, B. opt2, C. opt3"
    Returns: [{"question": "...", "options": ["A. opt1", "B. opt2", "C. opt3"]}]
    """
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
                    # No options provided, treat as open-ended
                    questions.append({"question": content, "options": []})
            elif stripped and not stripped.startswith("-"):
                break
    return questions


def _split_options(raw: str) -> list[str]:
    """
    Split options string intelligently.
    Handles: "A. foo (bar, baz), B. qux, C. Other"
    Splits on ", <letter>." pattern instead of bare commas.
    """
    import re
    # Split on ", " followed by a capital letter and period (e.g. ", B.")
    parts = re.split(r',\s*(?=[A-Z]\.)', raw)
    return [p.strip() for p in parts if p.strip()]


def _parse_section(text: str, section_name: str) -> str:
    """Extract a multi-line section by name (e.g., PLAN:)."""
    lines: list[str] = []
    in_section = False
    known_sections = {"INTENT", "COMPLEXITY", "SKIP_PLANNING", "EXISTING_PROJECT",
                      "REQUIREMENTS", "APPROACH", "LESSONS", "PLAN", "SCOPE",
                      "DONE_WHEN", "QUESTIONS", "MODIFY", "CREATE", "DO_NOT_TOUCH"}
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith(f"{section_name}:"):
            in_section = True
            # Check for inline content after colon
            after = stripped.split(":", 1)[1].strip()
            if after:
                lines.append(after)
            continue
        if in_section:
            # Stop at next known section
            if any(stripped.upper().startswith(f"{s}:") for s in known_sections if s != section_name):
                break
            if stripped:
                lines.append(stripped.lstrip("- ").strip() if stripped.startswith("- ") else stripped)
    return "\n".join(lines)


def _parse_list_section(text: str, section_name: str) -> list[str]:
    """Extract a bulleted list section."""
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
    """Extract SCOPE section with MODIFY, CREATE, DO_NOT_TOUCH sub-fields."""
    scope: dict = {"modify": [], "create": [], "do_not_touch": []}
    in_scope = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SCOPE:"):
            in_scope = True
            continue
        if in_scope:
            # Stop at any known section after SCOPE
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
    """
    Extract the SKIP_PLANNING decision from Claude's structured response.

    Looks for the literal line 'SKIP_PLANNING: yes' (case-insensitive).
    Falls back to False (do full planning) if the line is absent or malformed.
    """
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SKIP_PLANNING:"):
            value = stripped.split(":", 1)[1].strip().lower()
            return value == "yes"
    return False
