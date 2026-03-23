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
    agent_description: str = ""  # For evidence traceability — what this agent specializes in
    findings: list[dict[str, Any]] = field(default_factory=list)
    raw_output: str = ""
    success: bool = True
    error: str = ""
    duration_ms: int = 0


@dataclass
class SynthesisStats:
    """Statistics from the synthesis process."""
    total_raw_findings: int = 0
    agents_succeeded: int = 0
    agents_failed: int = 0
    conflicts_resolved: int = 0
    false_positives_removed: int = 0
    llm_used: bool = False
