"""Deploy channels."""

from openseed_body.channels.git import GitChannel
from openseed_body.channels.webhook import WebhookChannel

__all__ = ["GitChannel", "WebhookChannel"]
