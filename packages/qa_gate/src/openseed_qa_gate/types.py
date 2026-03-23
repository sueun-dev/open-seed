"""QA Gate types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentDefinition:
    """
    A specialist agent loaded from TOML.
    Pattern from: awesome-codex-subagents TOML format.
    """
    name: str
    description: str
    model: str = "gpt-5.4"
    model_reasoning_effort: str = "high"
    sandbox_mode: str = "read-only"  # "read-only" or "workspace-write"
    instructions: str = ""
    mcp_servers: dict[str, Any] = field(default_factory=dict)


@dataclass
class SpecialistResult:
    """Result from a single specialist agent run."""
    agent_name: str
    findings: list[dict[str, Any]] = field(default_factory=list)
    raw_output: str = ""
    success: bool = True
    error: str = ""
    duration_ms: int = 0
