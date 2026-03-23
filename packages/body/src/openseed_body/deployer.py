"""
Open Seed v2 — Deployment orchestrator.

Runs verified code through configured deploy channels.
Pattern from: OpenClaw infra/ (multi-channel delivery)
"""

from __future__ import annotations

from openseed_core.config import BodyConfig
from openseed_core.events import EventBus
from openseed_core.types import DeployResult
from openseed_body.channels.base import DeployChannel
from openseed_body.channels.git import GitChannel
from openseed_body.channels.webhook import WebhookChannel
from openseed_body.types import ChannelResult


def create_channels(config: BodyConfig) -> list[DeployChannel]:
    """Create deploy channel instances from config."""
    channels: list[DeployChannel] = []
    for name in config.channels:
        if name == "git":
            channels.append(GitChannel(config.git))
        elif name == "webhook" and config.webhook_url:
            channels.append(WebhookChannel(config.webhook_url))
    return channels


async def deploy(
    working_dir: str,
    message: str = "",
    config: BodyConfig | None = None,
    event_bus: EventBus | None = None,
) -> DeployResult:
    """
    Deploy through all configured channels.

    Args:
        working_dir: Project directory to deploy
        message: Deployment message (commit msg, notification text)
        config: Body configuration
        event_bus: For streaming events

    Returns:
        DeployResult with overall success/failure
    """
    cfg = config or BodyConfig()
    channels = create_channels(cfg)

    if not channels:
        return DeployResult(success=True, channel="none", message="No deploy channels configured")

    results: list[ChannelResult] = []
    for channel in channels:
        available = await channel.check()
        if not available:
            results.append(ChannelResult(channel=channel.name, success=False, message="Channel not available"))
            continue
        result = await channel.deploy(working_dir, message)
        results.append(result)

    all_success = all(r.success for r in results)
    summary = "; ".join(f"{r.channel}: {r.message}" for r in results)

    return DeployResult(
        success=all_success,
        channel=",".join(r.channel for r in results),
        message=summary,
    )
