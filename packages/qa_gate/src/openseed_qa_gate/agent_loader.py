"""
Open Seed v2 — TOML agent definition loader.

Loads specialist agent definitions from config/agents/*.toml.
Pattern from: awesome-codex-subagents TOML format.

Each TOML file defines:
  name, description, model, model_reasoning_effort, sandbox_mode,
  instructions.text, [mcp_servers.*]
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
    """Load all agent definitions from a directory of TOML files."""
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


def load_active_agents(
    agents_dir: Path,
    active_names: list[str],
) -> list[AgentDefinition]:
    """Load only the specified active agents."""
    all_agents = load_agents_from_dir(agents_dir)
    return [all_agents[name] for name in active_names if name in all_agents]
