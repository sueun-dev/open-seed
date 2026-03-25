"""Docker build + push channel."""

from __future__ import annotations

import os
from openseed_deploy.channels.base import DeployChannel
from openseed_deploy.types import ChannelResult
from openseed_core.subprocess import run_simple


class DockerChannel(DeployChannel):
    def __init__(self, image_tag: str = "", push: bool = False) -> None:
        self._tag = image_tag
        self._push = push

    @property
    def name(self) -> str:
        return "docker"

    async def check(self) -> bool:
        result = await run_simple(["docker", "version"], timeout_seconds=5)
        return result.exit_code == 0

    async def deploy(self, working_dir: str, message: str = "") -> ChannelResult:
        if not os.path.exists(os.path.join(working_dir, "Dockerfile")):
            return ChannelResult(channel="docker", success=False, message="No Dockerfile")

        tag = self._tag or f"openseed-build:{os.path.basename(working_dir)}"

        build = await run_simple(["docker", "build", "-t", tag, "."], cwd=working_dir, timeout_seconds=300)
        if build.exit_code != 0:
            return ChannelResult(channel="docker", success=False, message=f"Docker build failed: {build.stderr[:200]}")

        if self._push:
            push = await run_simple(["docker", "push", tag], cwd=working_dir, timeout_seconds=120)
            if push.exit_code != 0:
                return ChannelResult(channel="docker", success=False, message=f"Docker push failed: {push.stderr[:200]}")
            return ChannelResult(channel="docker", success=True, message=f"Built and pushed {tag}")

        return ChannelResult(channel="docker", success=True, message=f"Built {tag}")
