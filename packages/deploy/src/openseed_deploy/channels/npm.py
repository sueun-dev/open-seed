"""npm publish channel."""

from __future__ import annotations

import os

from openseed_core.subprocess import run_simple

from openseed_deploy.channels.base import DeployChannel
from openseed_deploy.types import ChannelResult


class NpmChannel(DeployChannel):
    @property
    def name(self) -> str:
        return "npm"

    async def check(self) -> bool:
        result = await run_simple(["npm", "whoami"], timeout_seconds=10)
        return result.exit_code == 0

    async def deploy(self, working_dir: str, message: str = "") -> ChannelResult:
        if not os.path.exists(os.path.join(working_dir, "package.json")):
            return ChannelResult(channel="npm", success=False, message="No package.json")

        result = await run_simple(["npm", "publish", "--access", "public"], cwd=working_dir, timeout_seconds=60)
        if result.exit_code == 0:
            return ChannelResult(channel="npm", success=True, message="Published to npm")
        return ChannelResult(channel="npm", success=False, message=f"npm publish failed: {result.stderr[:200]}")
