"""
Open Seed v2 — Typed exception hierarchy.
"""

from __future__ import annotations


class OpenSeedError(Exception):
    """Base exception for all Open Seed errors."""


class AuthError(OpenSeedError):
    """OAuth authentication failed."""


class AgentError(OpenSeedError):
    """Agent (Claude/Codex) execution failed."""
    def __init__(self, agent: str, message: str) -> None:
        self.agent = agent
        super().__init__(f"[{agent}] {message}")


class QAGateError(OpenSeedError):
    """QA gate blocked the pipeline."""


class SisyphusError(OpenSeedError):
    """Sisyphus loop exhausted all retries."""


class DeployError(OpenSeedError):
    """Deployment failed."""


class MemoryError(OpenSeedError):
    """Memory store operation failed."""


class ConfigError(OpenSeedError):
    """Configuration invalid or missing."""


class SubprocessError(OpenSeedError):
    """CLI subprocess failed."""
    def __init__(self, command: str, exit_code: int, stderr: str = "") -> None:
        self.command = command
        self.exit_code = exit_code
        self.stderr = stderr
        super().__init__(f"Command `{command}` exited {exit_code}: {stderr[:200]}")
