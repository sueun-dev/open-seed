"""
Open Seed v2 — Event bus for real-time pipeline streaming.

asyncio.Queue-based. Zero dependencies. Fire-and-forget events
for CLI HUD and web UI. Does NOT affect pipeline state.

Fire-and-forget events for CLI HUD and web UI.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4


class EventType(StrEnum):
    # Pipeline lifecycle
    PIPELINE_START = "pipeline.start"
    PIPELINE_COMPLETE = "pipeline.complete"
    PIPELINE_FAIL = "pipeline.fail"

    # Node lifecycle
    NODE_START = "node.start"
    NODE_COMPLETE = "node.complete"
    NODE_FAIL = "node.fail"

    # Agent output
    AGENT_TEXT = "agent.text"
    AGENT_TOOL_CALL = "agent.tool_call"
    AGENT_TOOL_RESULT = "agent.tool_result"
    AGENT_THINKING = "agent.thinking"

    # QA Gate
    QA_AGENT_START = "qa.agent_start"
    QA_AGENT_COMPLETE = "qa.agent_complete"
    QA_VERDICT = "qa.verdict"
    QA_AGENTS_SELECTED = "qa.agents_selected"
    QA_SYNTHESIS_COMPLETE = "qa.synthesis_complete"

    # Sentinel
    SENTINEL_RETRY = "sentinel.retry"
    SENTINEL_STAGNATION = "sentinel.stagnation"
    SENTINEL_ESCALATE = "sentinel.escalate"
    SENTINEL_STUCK = "sentinel.stuck"

    # Security
    SECURITY_CHECK = "security.check"

    # Metrics
    METRICS_UPDATE = "metrics.update"

    # Healing
    HEAL_START = "heal.start"
    HEAL_DIAGNOSIS = "heal.diagnosis"
    HEAL_COMMAND = "heal.command"
    HEAL_RESULT = "heal.result"

    # Memory
    MEMORY_STORE = "memory.store"
    MEMORY_RECALL = "memory.recall"

    # User interaction
    USER_INPUT_NEEDED = "user.input_needed"
    USER_INPUT_RECEIVED = "user.input_received"

    # Debug
    DEBUG = "debug"


@dataclass
class Event:
    """A pipeline event for real-time streaming.

    Causality tracking (OpenHands pattern): each event has a unique id
    and an optional cause_id linking to the event that triggered it.
    This enables post-hoc causal chain analysis for debugging.
    """

    type: EventType
    node: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)
    id: str = field(default_factory=lambda: str(uuid4()))
    cause_id: str | None = None


# Type alias for event handlers
EventHandler = Callable[[Event], Awaitable[None]]


class EventBus:
    """
    Async event bus for pipeline streaming.

    Usage:
        bus = EventBus()

        # Subscribe
        async def on_event(event: Event):
            print(f"{event.type}: {event.data}")
        bus.subscribe(on_event)

        # Emit
        await bus.emit(Event(type=EventType.NODE_START, node="plan", data={"task": "..."}))

        # Stream all events (for WebSocket/SSE)
        async for event in bus.stream():
            send_to_client(event)
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._handlers: list[EventHandler] = []
        self._closed = False

    def subscribe(self, handler: EventHandler) -> None:
        """Register an event handler."""
        self._handlers.append(handler)

    async def emit(self, event: Event) -> None:
        """Emit an event to all handlers and the stream queue."""
        if self._closed:
            return
        # Fire handlers (non-blocking)
        for handler in self._handlers:
            try:
                await handler(event)
            except Exception:
                pass  # Handlers must not crash the pipeline
        # Push to stream queue
        await self._queue.put(event)

    async def emit_simple(
        self, event_type: EventType, node: str = "", cause_id: str | None = None, **data: Any
    ) -> None:
        """Convenience: emit an event with keyword data and optional causality."""
        await self.emit(Event(type=event_type, node=node, data=data, cause_id=cause_id))

    async def stream(self) -> asyncio.AsyncIterator[Event]:
        """Yield events as they arrive. Ends when close() is called."""
        while True:
            event = await self._queue.get()
            if event is None:
                break
            yield event

    async def close(self) -> None:
        """Signal end of stream."""
        self._closed = True
        await self._queue.put(None)
