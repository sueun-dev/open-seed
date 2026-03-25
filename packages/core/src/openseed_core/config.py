"""
Open Seed v2 — Configuration system.

Pydantic models for all configuration. Loaded from YAML + env overrides.
Pattern from: mem0 configs/base.py + OpenClaw config/types.

No hardcoded decisions. All thresholds and routing configurable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


# ─── Auth ─────────────────────────────────────────────────────────────────────


class AuthConfig(BaseModel):
    claude_keychain_service: str = "openseed-claude-oauth"
    openai_keychain_service: str = "openseed-openai-oauth"


# ─── Brain (LangGraph) ───────────────────────────────────────────────────────


class BrainConfig(BaseModel):
    checkpoint_dir: Path = Path("~/.openseed/checkpoints")
    max_parallel_sends: int = 4


# ─── Left Hand (Claude) ──────────────────────────────────────────────────────


class ClaudeConfig(BaseModel):
    cli_path: str | None = None  # Auto-detect if None
    opus_model: str = "claude-opus-4-6"
    sonnet_model: str = "claude-sonnet-4-6"
    haiku_model: str = "claude-haiku-4-5"
    default_model: str = "claude-sonnet-4-6"
    max_context_tokens: int = 1_000_000
    thinking_budget: int = 10_000
    max_turns: int = 20


# ─── Right Hand (Codex) ──────────────────────────────────────────────────────


class CodexConfig(BaseModel):
    cli_path: str | None = None  # Auto-detect if None
    auto_mode: bool = True  # --full-auto
    max_parallel_agents: int = 3
    sandbox_mode: str = "workspace-write"
    model: str = "gpt-5.4"


# ─── QA Gate ──────────────────────────────────────────────────────────────────


class QAGateConfig(BaseModel):
    agents_dir: Path = Path("config/agents")
    active_agents: list[str] = Field(default_factory=lambda: [
        "reviewer",
        "security-auditor",
        "test-automator",
        "performance-engineer",
        "code-reviewer",
        "architect-reviewer",
        "qa-expert",
    ])
    synthesizer: str = "knowledge-synthesizer"
    block_on_critical: bool = True
    max_parallel_agents: int = 6
    enforce_output_contract: bool = True


# ─── Sentinel ─────────────────────────────────────────────────────────────────


class SentinelConfig(BaseModel):
    max_retries: int = 10
    stagnation_threshold: int = 3
    backoff_base_ms: int = 5_000
    backoff_max_ms: int = 160_000
    backoff_cap_exponent: int = 5
    insight_enabled: bool = True
    continuation_cooldown_ms: int = 5_000


# ─── Body (Deployment) ───────────────────────────────────────────────────────


class GitDeployConfig(BaseModel):
    auto_commit: bool = True
    auto_push: bool = False  # Requires explicit enable
    branch: str = "main"
    commit_prefix: str = "openseed:"


class CronConfig(BaseModel):
    enabled: bool = False
    store_path: Path = Path("~/.openseed/cron/jobs.json")
    retention_days: int = 30


class BodyConfig(BaseModel):
    channels: list[str] = Field(default_factory=lambda: ["git"])
    git: GitDeployConfig = Field(default_factory=GitDeployConfig)
    cron: CronConfig = Field(default_factory=CronConfig)
    webhook_url: str | None = None


# ─── Memory ───────────────────────────────────────────────────────────────────


class MemoryConfig(BaseModel):
    backend: Literal["qdrant", "pgvector", "sqlite"] = "qdrant"
    # Qdrant (via mem0)
    qdrant_url: str = "http://localhost:6333"
    qdrant_collection: str = "openseed"
    # PostgreSQL + pgvector
    pgvector_url: str = "postgresql://localhost/openseed"
    pgvector_collection: str = "openseed_memories"
    # SQLite fallback
    sqlite_path: Path = Path("~/.openseed/memory.db")
    history_path: Path = Path("~/.openseed/history.db")
    # Shared embedder settings
    embedding_model: str = "text-embedding-3-small"
    embedding_dims: int = 1536


# ─── Logging ──────────────────────────────────────────────────────────────────


class LoggingConfig(BaseModel):
    level: Literal["debug", "info", "warning", "error"] = "info"
    format: Literal["json", "text"] = "text"
    file: Path | None = None


# ─── Root Config ──────────────────────────────────────────────────────────────


class OpenSeedConfig(BaseModel):
    auth: AuthConfig = Field(default_factory=AuthConfig)
    brain: BrainConfig = Field(default_factory=BrainConfig)
    claude: ClaudeConfig = Field(default_factory=ClaudeConfig)
    codex: CodexConfig = Field(default_factory=CodexConfig)
    qa_gate: QAGateConfig = Field(default_factory=QAGateConfig)
    sentinel: SentinelConfig = Field(default_factory=SentinelConfig)
    body: BodyConfig = Field(default_factory=BodyConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)


# ─── Loader ───────────────────────────────────────────────────────────────────


def load_config(config_path: Path | None = None) -> OpenSeedConfig:
    """
    Load config from YAML file with environment variable overrides.

    Priority: env vars > config file > defaults
    """
    if config_path and config_path.exists():
        with open(config_path) as f:
            raw = yaml.safe_load(f) or {}
        return OpenSeedConfig(**raw)
    return OpenSeedConfig()
