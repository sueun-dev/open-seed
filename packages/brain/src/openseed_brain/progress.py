"""
Global progress callback for real-time sub-step event broadcasting.

Nodes call emit_progress() to send fine-grained events (e.g. specialist start/done)
that appear in the UI's Activity log during long-running operations.

The callback is wired up by api_server before pipeline execution.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

_callback: Callable[[dict[str, Any]], Awaitable[None]] | None = None


def set_progress_callback(cb: Callable[[dict[str, Any]], Awaitable[None]] | None) -> None:
    """Set the global progress callback (called from api_server)."""
    global _callback
    _callback = cb


async def emit_progress(event_type: str, node: str = "", **data: Any) -> None:
    """Emit a progress event if callback is set."""
    if _callback:
        try:
            await _callback({"type": event_type, "node": node, "data": data})
        except Exception:
            pass
