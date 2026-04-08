"""
Open Seed v2 — Wisdom Accumulation (Oh-My-OpenAgent pattern).

After each pipeline run, extract structured learnings and store them.
On the next run, recall relevant wisdom and inject into agent context.

5 categories:
  - conventions: code patterns, naming, architecture that worked
  - successes: approaches that worked well (reuse these)
  - failures: what didn't work and why (avoid repeating)
  - gotchas: unexpected issues, edge cases, tricky parts
  - commands: useful build/test/run commands discovered
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from openseed_memory.types import MemoryType

if TYPE_CHECKING:
    from openseed_memory.store import MemoryStore

logger = logging.getLogger(__name__)

_WISDOM_TYPE = "wisdom"


@dataclass
class Wisdom:
    """Structured wisdom extracted from a pipeline run."""

    conventions: list[str] = field(default_factory=list)
    successes: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    gotchas: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)


_EXTRACT_PROMPT = """\
You are a learning extractor. Given a pipeline run summary, extract structured wisdom.

## Pipeline Run Summary
{summary}

## Extract into 5 categories (only include genuinely useful insights, skip empty categories):

1. CONVENTIONS: Code patterns, naming, architecture choices that worked well in this project
2. SUCCESSES: Approaches, strategies, or techniques that produced good results
3. FAILURES: What didn't work and WHY — so it's not repeated
4. GOTCHAS: Unexpected issues, tricky edge cases, non-obvious requirements
5. COMMANDS: Useful build/test/deploy commands discovered or used

Output ONLY valid JSON:
{{"conventions": ["..."], "successes": ["..."], "failures": ["..."], "gotchas": ["..."], "commands": ["..."]}}

Rules:
- Each item should be a concise, actionable sentence
- Skip categories with nothing meaningful (use empty array)
- Focus on insights that help FUTURE tasks, not just this one
- Do NOT include generic advice — only project-specific learnings"""


async def extract_wisdom(
    task: str,
    plan_summary: str,
    qa_synthesis: str,
    retry_count: int,
    errors: list[str],
    tech_stack: str = "",
) -> Wisdom:
    """
    Use LLM to extract structured wisdom from a pipeline run.

    Falls back to basic heuristic extraction if LLM is unavailable.
    """
    summary_parts = [f"Task: {task}"]
    if tech_stack:
        summary_parts.append(f"Tech stack: {tech_stack}")
    if plan_summary:
        summary_parts.append(f"Plan: {plan_summary}")
    if qa_synthesis:
        summary_parts.append(f"QA result: {qa_synthesis}")
    summary_parts.append(f"Retries: {retry_count}")
    if errors:
        summary_parts.append(f"Errors: {'; '.join(errors[:5])}")

    summary = "\n".join(summary_parts)

    try:
        from openseed_codex.agent import CodexAgent

        agent = CodexAgent()
        response = await agent.invoke(
            prompt=_EXTRACT_PROMPT.format(summary=summary),
            model="light",
            max_turns=1,
        )
        return _parse_wisdom(response.text)
    except Exception as exc:
        logger.debug("Wisdom extraction LLM failed, using heuristic: %s", exc)
        return _heuristic_wisdom(task, retry_count, errors)


def _parse_wisdom(raw: str) -> Wisdom:
    """Parse LLM JSON output into Wisdom. Never raises."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1:
        return Wisdom()
    try:
        data = json.loads(raw[start : end + 1])
        return Wisdom(
            conventions=_to_str_list(data.get("conventions", [])),
            successes=_to_str_list(data.get("successes", [])),
            failures=_to_str_list(data.get("failures", [])),
            gotchas=_to_str_list(data.get("gotchas", [])),
            commands=_to_str_list(data.get("commands", [])),
        )
    except (json.JSONDecodeError, TypeError):
        return Wisdom()


def _to_str_list(val: Any) -> list[str]:
    """Safely convert to list[str]."""
    if not isinstance(val, list):
        return []
    return [str(v) for v in val if v]


def _heuristic_wisdom(task: str, retry_count: int, errors: list[str]) -> Wisdom:
    """Basic wisdom extraction without LLM."""
    w = Wisdom()
    if retry_count == 0:
        w.successes.append(f"Task completed on first attempt: {task[:100]}")
    elif retry_count >= 3:
        w.failures.append(f"Task required {retry_count} retries — approach likely needs rethinking")
    if errors:
        for e in errors[:3]:
            w.gotchas.append(f"Error encountered: {e[:150]}")
    return w


async def store_wisdom(
    store: MemoryStore,
    task: str,
    wisdom: Wisdom,
    tech_stack: str = "",
) -> str | None:
    """Store extracted wisdom as procedural memory."""
    parts: list[str] = []
    if wisdom.conventions:
        parts.append("Conventions: " + "; ".join(wisdom.conventions))
    if wisdom.successes:
        parts.append("Successes: " + "; ".join(wisdom.successes))
    if wisdom.failures:
        parts.append("Failures: " + "; ".join(wisdom.failures))
    if wisdom.gotchas:
        parts.append("Gotchas: " + "; ".join(wisdom.gotchas))
    if wisdom.commands:
        parts.append("Commands: " + "; ".join(wisdom.commands))

    if not parts:
        return None

    content = f"Wisdom from: {task[:100]}\n" + "\n".join(parts)

    return await store.add(
        content=content,
        user_id="system",
        agent_id="pipeline",
        memory_type=MemoryType.PROCEDURAL,
        metadata={
            "type": _WISDOM_TYPE,
            "task_summary": task[:100],
            "tech_stack": tech_stack,
            "has_conventions": bool(wisdom.conventions),
            "has_failures": bool(wisdom.failures),
        },
        infer=False,  # Store as-is, already structured
    )


async def recall_wisdom(
    store: MemoryStore,
    task: str,
    tech_stack: str = "",
    limit: int = 5,
) -> list[Wisdom]:
    """
    Recall relevant wisdom from past runs.

    Searches by task similarity and tech stack.
    """
    query = f"wisdom for: {task[:100]}"
    if tech_stack:
        query += f" ({tech_stack})"

    results = await store.search(query=query, user_id="system", limit=limit)

    wisdoms: list[Wisdom] = []
    for r in results:
        meta = r.entry.metadata or {}
        if meta.get("type") != _WISDOM_TYPE:
            continue
        wisdoms.append(_parse_stored_wisdom(r.entry.content))

    return wisdoms


def _parse_stored_wisdom(content: str) -> Wisdom:
    """Parse stored wisdom text back into Wisdom object."""
    w = Wisdom()
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("Conventions: "):
            w.conventions = [s.strip() for s in line[13:].split(";") if s.strip()]
        elif line.startswith("Successes: "):
            w.successes = [s.strip() for s in line[11:].split(";") if s.strip()]
        elif line.startswith("Failures: "):
            w.failures = [s.strip() for s in line[10:].split(";") if s.strip()]
        elif line.startswith("Gotchas: "):
            w.gotchas = [s.strip() for s in line[9:].split(";") if s.strip()]
        elif line.startswith("Commands: "):
            w.commands = [s.strip() for s in line[10:].split(";") if s.strip()]
    return w


def format_wisdom_for_prompt(wisdoms: list[Wisdom]) -> str:
    """Format recalled wisdom into a string for prompt injection."""
    if not wisdoms:
        return ""

    sections: list[str] = []
    all_conventions: list[str] = []
    all_successes: list[str] = []
    all_failures: list[str] = []
    all_gotchas: list[str] = []
    all_commands: list[str] = []

    for w in wisdoms:
        all_conventions.extend(w.conventions)
        all_successes.extend(w.successes)
        all_failures.extend(w.failures)
        all_gotchas.extend(w.gotchas)
        all_commands.extend(w.commands)

    # Deduplicate
    if all_conventions:
        sections.append("Conventions from past runs:\n" + "\n".join(f"- {c}" for c in dict.fromkeys(all_conventions)))
    if all_successes:
        sections.append("What worked before:\n" + "\n".join(f"- {s}" for s in dict.fromkeys(all_successes)))
    if all_failures:
        sections.append("What to AVOID (failed before):\n" + "\n".join(f"- {f}" for f in dict.fromkeys(all_failures)))
    if all_gotchas:
        sections.append("Watch out for:\n" + "\n".join(f"- {g}" for g in dict.fromkeys(all_gotchas)))
    if all_commands:
        sections.append("Useful commands:\n" + "\n".join(f"- {c}" for c in dict.fromkeys(all_commands)))

    if not sections:
        return ""

    return "\n\nWisdom from past pipeline runs:\n" + "\n\n".join(sections)
