"""
Open Seed v2 — Webhook deploy channel.

Sends deployment notification to a webhook URL.
Pattern from: OpenClaw hooks/ webhook ingress
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime

from openseed_body.channels.base import DeployChannel
from openseed_body.types import ChannelResult


class WebhookChannel(DeployChannel):
    """Webhook notification channel."""

    def __init__(self, url: str, token: str = "") -> None:
        self.url = url
        self.token = token

    @property
    def name(self) -> str:
        return "webhook"

    async def check(self) -> bool:
        return bool(self.url)

    async def deploy(self, working_dir: str, message: str = "") -> ChannelResult:
        """Send deployment notification via webhook."""
        payload = json.dumps({
            "event": "deploy",
            "message": message or "Open Seed deployment",
            "working_dir": working_dir,
            "timestamp": datetime.now().isoformat(),
        }).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        try:
            req = urllib.request.Request(self.url, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
            return ChannelResult(
                channel="webhook",
                success=200 <= status < 300,
                message=f"Webhook sent (HTTP {status})",
                url=self.url,
            )
        except Exception as e:
            return ChannelResult(channel="webhook", success=False, message=str(e))
