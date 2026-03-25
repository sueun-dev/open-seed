"""
Open Seed v2 — Microagent System (OpenHands pattern).

Per-repo knowledge injection. Loads markdown files from the working
directory that provide project-specific context to the implementing agent.

Two types:
  - RepoMicroagent: Always injected (repo conventions, tech stack)
  - KnowledgeMicroagent: Injected when task matches triggers (LLM-based)

Also auto-detects: .cursorrules, AGENTS.md, CLAUDE.md

Pattern from: openhands/microagent/microagent.py
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Microagent:
    """A single microagent loaded from the working directory."""
    name: str = ""
    type: str = "repo"  # "repo" or "knowledge"
    triggers: list[str] = field(default_factory=list)  # Keywords for knowledge type
    content: str = ""
    source_file: str = ""


def load_microagents(working_dir: str) -> list[Microagent]:
    """
    Load all microagents from a working directory.

    Scans for:
    1. .openseed/agents/*.md files (primary)
    2. .cursorrules (Cursor IDE conventions)
    3. AGENTS.md (agent instructions)
    4. CLAUDE.md (Claude-specific instructions)

    Args:
        working_dir: Absolute path to the project directory

    Returns:
        List of loaded Microagent objects
    """
    agents: list[Microagent] = []
    wd = Path(working_dir)

    # 1. Load .openseed/agents/*.md files
    agents_dir = wd / ".openseed" / "agents"
    if agents_dir.is_dir():
        for md_file in sorted(agents_dir.glob("*.md")):
            try:
                agent = _parse_microagent_file(md_file)
                if agent:
                    agents.append(agent)
            except Exception:
                pass

    # 2. Auto-detect known convention files
    for filename, agent_name in [
        (".cursorrules", "cursor-rules"),
        ("AGENTS.md", "agents-md"),
        ("CLAUDE.md", "claude-md"),
        (".github/copilot-instructions.md", "copilot-instructions"),
    ]:
        filepath = wd / filename
        if filepath.is_file():
            try:
                content = filepath.read_text(encoding="utf-8")[:10_000]
                agents.append(Microagent(
                    name=agent_name,
                    type="repo",
                    content=content,
                    source_file=str(filepath),
                ))
            except Exception:
                pass

    return agents


def _parse_microagent_file(path: Path) -> Microagent | None:
    """
    Parse a microagent markdown file with optional YAML frontmatter.

    Expected format:
    ```
    ---
    name: my-agent
    type: knowledge
    triggers: [react, frontend, component]
    ---

    Agent content here...
    ```
    """
    try:
        text = path.read_text(encoding="utf-8")[:10_000]
    except Exception:
        return None

    name = path.stem
    agent_type = "repo"
    triggers: list[str] = []
    content = text

    # Parse YAML frontmatter if present
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = parts[1].strip()
            content = parts[2].strip()

            # Simple YAML-like parsing (no dependency on pyyaml in this file)
            for line in frontmatter.splitlines():
                line = line.strip()
                if line.startswith("name:"):
                    name = line.split(":", 1)[1].strip().strip("\"'")
                elif line.startswith("type:"):
                    agent_type = line.split(":", 1)[1].strip().strip("\"'")
                elif line.startswith("triggers:"):
                    raw = line.split(":", 1)[1].strip()
                    # Parse [a, b, c] or a, b, c
                    raw = raw.strip("[]")
                    triggers = [t.strip().strip("\"'") for t in raw.split(",") if t.strip()]

    if not content.strip():
        return None

    return Microagent(
        name=name,
        type=agent_type,
        triggers=triggers,
        content=content,
        source_file=str(path),
    )


async def select_relevant_microagents(
    agents: list[Microagent],
    task: str,
) -> list[Microagent]:
    """
    Select which microagents are relevant for a given task.

    - All 'repo' type agents are always included
    - 'knowledge' type agents are included if their triggers match the task
    - Trigger matching uses LLM (no regex) per the "all decisions by AI" rule

    Args:
        agents: All loaded microagents
        task: The user's task description

    Returns:
        Filtered list of relevant microagents
    """
    relevant: list[Microagent] = []

    # Repo agents always included
    repo_agents = [a for a in agents if a.type == "repo"]
    relevant.extend(repo_agents)

    # Knowledge agents: check triggers
    knowledge_agents = [a for a in agents if a.type == "knowledge" and a.triggers]
    if not knowledge_agents:
        return relevant

    # Use LLM to match triggers against task
    try:
        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        agent_list = "\n".join(
            f"- {a.name}: triggers={a.triggers}"
            for a in knowledge_agents
        )
        response = await agent.invoke(
            prompt=(
                f"Given this task: \"{task[:500]}\"\n\n"
                f"Which of these knowledge agents are relevant?\n{agent_list}\n\n"
                f"Return ONLY the agent names as a comma-separated list. "
                f"If none are relevant, return 'none'."
            ),
            model="haiku",
            max_turns=1,
        )
        selected_names = {
            n.strip().lower()
            for n in response.text.strip().split(",")
        }
        for a in knowledge_agents:
            if a.name.lower() in selected_names:
                relevant.append(a)
    except Exception:
        # Fallback: include all knowledge agents (safe default)
        relevant.extend(knowledge_agents)

    return relevant


def format_microagent_context(agents: list[Microagent]) -> str:
    """
    Format selected microagents into a string for prompt injection.

    Args:
        agents: Selected microagents to include

    Returns:
        Formatted string ready for inclusion in system prompt
    """
    if not agents:
        return ""

    parts = ["## Project-Specific Context (from repository microagents)\n"]
    for agent in agents:
        parts.append(f"### {agent.name} ({agent.type})")
        parts.append(agent.content[:3000])
        parts.append("")

    return "\n".join(parts)
