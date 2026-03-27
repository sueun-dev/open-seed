"""
Intake node — Analyze task, recall memories, classify intent.
REAL implementation — calls Claude + Memory recall.

Sets skip_planning=True when Claude determines the task is trivial (complexity:
simple/trivial with a single well-scoped change). All routing decisions are
made by the LLM — no regex, no hardcoded extension checks.
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

    # ── Step 5: Analyse task via Claude ──
    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"""Analyze this task and classify it.

Task: {task}
Working directory: {working_dir}
{intent_info}{memory_context}
{codebase_context}

Respond with EXACTLY this structure (fill in each line):
INTENT: <implementation|fix|research|investigation|evaluation|open_ended>
COMPLEXITY: <simple|moderate|complex>
SKIP_PLANNING: <yes|no>
EXISTING_PROJECT: <yes|no>
REQUIREMENTS:
- <requirement 1>
- <requirement 2>
APPROACH: <1-2 sentence approach>
LESSONS: <any relevant lessons from past experiences, or "none">

Rules for SKIP_PLANNING:
- yes ONLY when: complexity is simple AND the task is a single, clearly scoped change
  (e.g. fix one bug in one file, add one small function, update one config value)
- no for everything else: new features, multi-file changes, refactors, research tasks

Rules for EXISTING_PROJECT:
- If the working directory already has source files, treat this as MODIFICATION of
  an existing project, not building from scratch.
- Read the existing tech stack and adapt your approach to match it.

Be concise. No extra prose outside the above structure.""",
        model="opus",  # Top-level orchestration uses Opus for best judgment
        max_turns=1,
    )

    analysis_text = response.text
    skip_planning = _parse_skip_planning(analysis_text)
    intake_analysis = _parse_analysis(analysis_text)

    # Inject detected tech stack into analysis for downstream nodes
    if detected_tech_stack:
        intake_analysis["tech_stack"] = ", ".join(detected_tech_stack)

    result: dict = {
        "skip_planning": skip_planning,
        "intake_analysis": intake_analysis,
        "messages": [f"Intake: {analysis_text[:500]}"],
    }
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
