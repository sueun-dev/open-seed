"""
Skill Loader — Scan and index official skills from Anthropic and OpenAI repos.

Reads SKILL.md files, parses frontmatter (name, description), and provides:
- list_all_skills(): returns all available skills with metadata
- get_skill_content(name): returns full SKILL.md content for a skill
- match_skills(task, gaps, tech_stack): AI selects relevant skills for a task
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Resolve skills directory relative to project root
_PROJECT_ROOT = Path(__file__).resolve().parents[4]  # packages/brain/src/openseed_brain -> root
_SKILLS_DIR = _PROJECT_ROOT / "skills"


@dataclass
class OfficialSkill:
    """Metadata for a single skill."""

    name: str
    description: str
    source: str  # "anthropic" or "openai"
    category: str  # "curated", "system", or "official"
    path: str  # absolute path to SKILL.md
    content: str = ""  # full SKILL.md content (loaded on demand)


# ─── Module-level cache ──────────────────────────────────────────────────────

_skills_cache: list[OfficialSkill] | None = None


def _parse_frontmatter(text: str) -> dict[str, str]:
    """Parse YAML-like frontmatter from SKILL.md (supports multiline values)."""
    if not text.startswith("---"):
        return {}
    end = text.find("---", 3)
    if end == -1:
        return {}
    block = text[3:end].strip()
    result: dict[str, str] = {}
    current_key = ""
    current_value_lines: list[str] = []

    for line in block.splitlines():
        # Indented line = continuation of multiline value
        if line.startswith("  ") and current_key:
            current_value_lines.append(line.strip())
            continue

        # Save previous key if exists
        if current_key and current_value_lines:
            result[current_key] = " ".join(current_value_lines)
        elif current_key:
            pass  # key with empty value

        # Parse new key:value
        current_key = ""
        current_value_lines = []
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                current_key = key
                if value and value != "|":
                    result[key] = value
                    current_key = "" if value != "|" else key
                elif value == "|":
                    current_value_lines = []  # will collect indented lines
                else:
                    result[key] = ""
                    current_key = ""

    # Don't forget last key
    if current_key and current_value_lines:
        result[current_key] = " ".join(current_value_lines)

    return result


def _scan_skills_dir() -> list[OfficialSkill]:
    """Scan skills/ directory and index all SKILL.md files."""
    skills: list[OfficialSkill] = []

    if not _SKILLS_DIR.is_dir():
        logger.debug("Project skills directory not found: %s (checking user skills)", _SKILLS_DIR)

    # Anthropic skills: skills/anthropic/skills/<name>/SKILL.md
    anthropic_dir = _SKILLS_DIR / "anthropic" / "skills"
    if anthropic_dir.is_dir():
        for entry in sorted(anthropic_dir.iterdir()):
            skill_md = entry / "SKILL.md"
            if entry.is_dir() and skill_md.exists():
                try:
                    text = skill_md.read_text(encoding="utf-8", errors="ignore")
                    fm = _parse_frontmatter(text)
                    skills.append(
                        OfficialSkill(
                            name=fm.get("name", entry.name),
                            description=fm.get("description", ""),
                            source="anthropic",
                            category="official",
                            path=str(skill_md),
                        )
                    )
                except Exception as exc:
                    logger.debug("Failed to load skill %s: %s", entry.name, exc)

    # OpenAI skills: skills/openai/skills/.curated/<name>/SKILL.md
    openai_curated = _SKILLS_DIR / "openai" / "skills" / ".curated"
    if openai_curated.is_dir():
        for entry in sorted(openai_curated.iterdir()):
            skill_md = entry / "SKILL.md"
            if entry.is_dir() and skill_md.exists():
                try:
                    text = skill_md.read_text(encoding="utf-8", errors="ignore")
                    fm = _parse_frontmatter(text)
                    skills.append(
                        OfficialSkill(
                            name=fm.get("name", entry.name),
                            description=fm.get("description", ""),
                            source="openai",
                            category="curated",
                            path=str(skill_md),
                        )
                    )
                except Exception as exc:
                    logger.debug("Failed to load skill %s: %s", entry.name, exc)

    # OpenAI system skills: skills/openai/skills/.system/<name>/SKILL.md
    openai_system = _SKILLS_DIR / "openai" / "skills" / ".system"
    if openai_system.is_dir():
        for entry in sorted(openai_system.iterdir()):
            skill_md = entry / "SKILL.md"
            if entry.is_dir() and skill_md.exists():
                try:
                    text = skill_md.read_text(encoding="utf-8", errors="ignore")
                    fm = _parse_frontmatter(text)
                    skills.append(
                        OfficialSkill(
                            name=fm.get("name", entry.name),
                            description=fm.get("description", ""),
                            source="openai",
                            category="system",
                            path=str(skill_md),
                        )
                    )
                except Exception as exc:
                    logger.debug("Failed to load skill %s: %s", entry.name, exc)

    # gstack skills: ~/.claude/skills/gstack/<name>/SKILL.md
    gstack_dir = Path.home() / ".claude" / "skills" / "gstack"
    if gstack_dir.is_dir():
        for entry in sorted(gstack_dir.iterdir()):
            skill_md = entry / "SKILL.md"
            if entry.is_dir() and skill_md.exists():
                try:
                    text = skill_md.read_text(encoding="utf-8", errors="ignore")
                    fm = _parse_frontmatter(text)
                    skills.append(
                        OfficialSkill(
                            name=fm.get("name", f"gstack-{entry.name}"),
                            description=fm.get("description", ""),
                            source="gstack",
                            category="community",
                            path=str(skill_md),
                        )
                    )
                except Exception as exc:
                    logger.debug("Failed to load gstack skill %s: %s", entry.name, exc)

    # User skills from ~/.claude/skills/ (non-gstack)
    user_skills_dir = Path.home() / ".claude" / "skills"
    if user_skills_dir.is_dir():
        for entry in sorted(user_skills_dir.iterdir()):
            if entry.name == "gstack" or not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if skill_md.exists():
                try:
                    text = skill_md.read_text(encoding="utf-8", errors="ignore")
                    fm = _parse_frontmatter(text)
                    skills.append(
                        OfficialSkill(
                            name=fm.get("name", entry.name),
                            description=fm.get("description", ""),
                            source="user",
                            category="custom",
                            path=str(skill_md),
                        )
                    )
                except Exception as exc:
                    logger.debug("Failed to load user skill %s: %s", entry.name, exc)

    logger.info(
        "Loaded %d skills (%d anthropic, %d openai, %d gstack, %d user)",
        len(skills),
        sum(1 for s in skills if s.source == "anthropic"),
        sum(1 for s in skills if s.source == "openai"),
        sum(1 for s in skills if s.source == "gstack"),
        sum(1 for s in skills if s.source == "user"),
    )
    return skills


def list_all_skills() -> list[OfficialSkill]:
    """Return all available skills (cached after first scan)."""
    global _skills_cache
    if _skills_cache is None:
        _skills_cache = _scan_skills_dir()
    return _skills_cache


def get_skill_content(name: str) -> str | None:
    """Load and return the full SKILL.md content for a skill by name."""
    for skill in list_all_skills():
        if skill.name == name:
            if not skill.content:
                try:
                    skill.content = Path(skill.path).read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    return None
            return skill.content
    return None


def build_skill_catalog() -> str:
    """Build a compact catalog string for AI to select from."""
    lines = []
    for skill in list_all_skills():
        desc = skill.description[:150] if skill.description else "No description"
        lines.append(f"- {skill.name} [{skill.source}]: {desc}")
    return "\n".join(lines)


async def select_skills_for_task(
    agent,
    task: str,
    gaps: list[dict],
    tech_stack: list[str],
    codebase_context: str,
) -> list[str]:
    """
    AI selects which skills are relevant for this task.
    Returns list of skill names.
    """
    catalog = build_skill_catalog()
    if not catalog:
        return []

    tech_hint = f"Tech stack: {', '.join(tech_stack)}" if tech_stack else ""
    gaps_text = "\n".join(f"- {g['topic']}: {g['why']}" for g in gaps) if gaps else "None"

    response = await agent.invoke(
        prompt=f"""You are selecting specialist skills for a coding task.

Available skills:
{catalog}

Task: {task}
{tech_hint}
{codebase_context[:500] if codebase_context else ""}

Knowledge gaps:
{gaps_text}

Select 1-5 skills that are MOST relevant for executing this task.
Only select skills that will directly help with implementation.
Do NOT select skills that are irrelevant (e.g., don't select 'pdf' for a web app task).

Respond with EXACTLY:
SKILLS: <skill-name-1>, <skill-name-2>, <skill-name-3>

Example: SKILLS: frontend-design, webapp-testing, cloudflare-deploy""",
        model="standard",
        max_turns=1,
    )

    return _parse_skill_selection(response.text)


def _parse_skill_selection(text: str) -> list[str]:
    """Parse SKILLS: line from AI response."""
    valid_names = {s.name for s in list_all_skills()}
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("SKILLS:"):
            raw = stripped.split(":", 1)[1].strip()
            names = [n.strip() for n in raw.split(",") if n.strip()]
            # Filter to only valid skill names
            return [n for n in names if n in valid_names]
    return []
