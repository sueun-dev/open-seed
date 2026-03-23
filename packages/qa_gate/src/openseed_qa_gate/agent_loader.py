"""
Open Seed v2 — TOML agent definition loader.

Loads specialist agent definitions from config/agents/*.toml.
Pattern from: awesome-codex-subagents TOML format.

Each TOML file defines:
  name, description, model, model_reasoning_effort, sandbox_mode,
  instructions.text, [mcp_servers.*]

Directory layout supported:

  agents/                      ← flat (legacy)
    backend-developer.toml
    ...

  agents/                      ← categorised (new)
    01-core-development/
      backend-developer.toml
    02-language-specialists/
      python-pro.toml
    ...
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from openseed_qa_gate.types import AgentDefinition


def load_agent(toml_path: Path) -> AgentDefinition:
    """Load a single agent definition from a TOML file."""
    with open(toml_path, "rb") as f:
        data = tomllib.load(f)

    instructions = ""
    if isinstance(data.get("instructions"), dict):
        instructions = data["instructions"].get("text", "")
    elif isinstance(data.get("instructions"), str):
        instructions = data["instructions"]

    return AgentDefinition(
        name=data.get("name", toml_path.stem),
        description=data.get("description", ""),
        model=data.get("model", "gpt-5.4"),
        model_reasoning_effort=data.get("model_reasoning_effort", "high"),
        sandbox_mode=data.get("sandbox_mode", "read-only"),
        instructions=instructions,
        mcp_servers=data.get("mcp_servers", {}),
    )


def load_agents_from_dir(agents_dir: Path) -> dict[str, AgentDefinition]:
    """Load all agent definitions from a single directory of TOML files.

    Only scans the immediate directory — does not recurse into subdirectories.
    TOML filenames beginning with ``_`` (e.g. ``_registry.toml``) are skipped.
    """
    agents: dict[str, AgentDefinition] = {}
    if not agents_dir.is_dir():
        return agents

    for toml_file in sorted(agents_dir.glob("*.toml")):
        if toml_file.name.startswith("_"):
            continue  # Skip _registry.toml etc.
        try:
            agent = load_agent(toml_file)
            agents[agent.name] = agent
        except Exception:
            pass  # Skip malformed TOML files

    return agents


def load_all_agents(base_dir: Path) -> dict[str, AgentDefinition]:
    """Load agents from all category subdirectories under *base_dir*.

    Walks every immediate subdirectory (e.g. ``01-core-development/``) and
    merges all agents into a single name-keyed dict.  If the same agent name
    appears in multiple categories, the later category (higher sort order) wins.

    Also loads any ``.toml`` files that live directly in *base_dir* (legacy flat
    layout) so that existing configs continue to work without migration.
    """
    agents: dict[str, AgentDefinition] = {}

    # Legacy flat files at the base level
    agents.update(load_agents_from_dir(base_dir))

    # Category subdirectories
    if base_dir.is_dir():
        for subdir in sorted(base_dir.iterdir()):
            if subdir.is_dir() and not subdir.name.startswith("_"):
                agents.update(load_agents_from_dir(subdir))

    return agents


def load_agents_by_category(base_dir: Path, category: str) -> dict[str, AgentDefinition]:
    """Load agents from a specific category subdirectory.

    Args:
        base_dir:  Root agents directory (e.g. ``config/agents/``).
        category:  Category directory name or ``AgentCategory`` enum value
                   (e.g. ``"04-quality-security"``).

    Returns:
        Name-keyed dict of agents in that category, or an empty dict if the
        directory does not exist.
    """
    cat_dir = base_dir / category
    return load_agents_from_dir(cat_dir)


def load_active_agents(
    agents_dir: Path,
    active_names: list[str],
) -> list[AgentDefinition]:
    """Load only the specified active agents.

    Searches the flat layout and all category subdirectories, then filters to
    the requested names.
    """
    all_agents = load_all_agents(agents_dir)
    return [all_agents[name] for name in active_names if name in all_agents]
