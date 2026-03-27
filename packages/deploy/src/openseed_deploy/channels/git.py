"""
Open Seed v2 — Git deploy channel.

Commits and pushes code. Pattern from: OpenClaw infra/git-root.ts
"""

from __future__ import annotations

from openseed_core.config import GitDeployConfig
from openseed_core.subprocess import run_simple
from openseed_deploy.channels.base import DeployChannel
from openseed_deploy.types import ChannelResult


class GitChannel(DeployChannel):
    """Git commit + push deployment channel."""

    def __init__(self, config: GitDeployConfig | None = None) -> None:
        self.config = config or GitDeployConfig()

    @property
    def name(self) -> str:
        return "git"

    async def check(self) -> bool:
        """Check git is available."""
        result = await run_simple(["git", "--version"], timeout_seconds=5)
        return result.exit_code == 0

    async def deploy(self, working_dir: str, message: str = "") -> ChannelResult:
        """Commit all changes and optionally push."""
        commit_msg = message or f"{self.config.commit_prefix} automated deployment"

        # Ensure git repo exists
        import os
        if not os.path.isdir(os.path.join(working_dir, ".git")):
            init = await run_simple(["git", "init"], cwd=working_dir)
            if init.exit_code != 0:
                return ChannelResult(channel="git", success=False, message=f"git init failed: {init.stderr}")

        # Stage all changes (use "." instead of "-A" to respect .gitignore)
        stage = await run_simple(["git", "add", "."], cwd=working_dir)
        if stage.exit_code != 0:
            # Fallback: use bash -c for shell glob expansion
            stage = await run_simple(
                ["bash", "-c", "git add *.js *.jsx *.ts *.tsx *.json *.html *.css *.py *.md 2>/dev/null; git add -u"],
                cwd=working_dir,
            )
            if stage.exit_code != 0:
                return ChannelResult(channel="git", success=False, message=f"git add failed: {stage.stderr[:200]}")

        # Check if there's anything to commit
        status = await run_simple(["git", "status", "--porcelain"], cwd=working_dir)
        if not status.stdout.strip():
            return ChannelResult(channel="git", success=True, message="Nothing to commit")

        # Commit
        commit = await run_simple(
            ["git", "commit", "-m", commit_msg],
            cwd=working_dir,
        )
        if commit.exit_code != 0:
            return ChannelResult(channel="git", success=False, message=f"git commit failed: {commit.stderr}")

        # Push (only if configured)
        if self.config.auto_push:
            push = await run_simple(
                ["git", "push", "origin", self.config.branch],
                cwd=working_dir,
                timeout_seconds=30,
            )
            if push.exit_code != 0:
                return ChannelResult(channel="git", success=False, message=f"git push failed: {push.stderr}")
            return ChannelResult(channel="git", success=True, message=f"Committed and pushed to {self.config.branch}")

        return ChannelResult(channel="git", success=True, message=f"Committed (push disabled)")
