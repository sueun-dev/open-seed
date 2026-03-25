"""
Hooks system for the Claude Agent.
Pattern from: claude-code-sdk hooks (10 event types).

We implement the 5 most useful hooks:
1. PreToolUse   — before a tool is called (can modify/block)
2. PostToolUse  — after a tool completes (can inspect result)
3. Stop         — when the agent finishes (final result)
4. OnError      — when an error occurs
5. OnThinking   — when extended thinking is detected

Each hook is an async callable that receives a HookContext.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)


class HookEvent(str, Enum):
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    STOP = "Stop"
    ON_ERROR = "OnError"
    ON_THINKING = "OnThinking"


@dataclass
class HookContext:
    """Context passed to hook callbacks."""
    event: HookEvent
    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    tool_result: str = ""
    is_error: bool = False
    text: str = ""
    thinking: str = ""
    model: str = ""
    session_id: str = ""


@dataclass
class HookResult:
    """Result from a hook callback — can modify behavior."""
    allow: bool = True                          # False = block the action
    modified_input: dict[str, Any] | None = None  # Override tool input
    reason: str = ""                            # Explanation if blocked


# Hook callback type
HookCallback = Callable[[HookContext], Awaitable[HookResult | None]]


class HookRegistry:
    """Registry of hooks for the Claude Agent.

    Usage::

        registry = HookRegistry()

        @registry.pre_tool_use
        async def guard(ctx: HookContext) -> HookResult:
            if ctx.tool_name == "Bash":
                return HookResult(allow=False, reason="Bash is disabled")
            return HookResult()

        agent = ClaudeAgent(hooks=registry)
    """

    def __init__(self) -> None:
        self._hooks: dict[HookEvent, list[HookCallback]] = {
            event: [] for event in HookEvent
        }

    def on(self, event: HookEvent, callback: HookCallback) -> None:
        """Register a hook callback for an event."""
        self._hooks[event].append(callback)

    def pre_tool_use(self, callback: HookCallback) -> HookCallback:
        """Decorator: register a PreToolUse hook."""
        self.on(HookEvent.PRE_TOOL_USE, callback)
        return callback

    def post_tool_use(self, callback: HookCallback) -> HookCallback:
        """Decorator: register a PostToolUse hook."""
        self.on(HookEvent.POST_TOOL_USE, callback)
        return callback

    def on_stop(self, callback: HookCallback) -> HookCallback:
        """Decorator: register a Stop hook."""
        self.on(HookEvent.STOP, callback)
        return callback

    def on_error(self, callback: HookCallback) -> HookCallback:
        """Decorator: register an OnError hook."""
        self.on(HookEvent.ON_ERROR, callback)
        return callback

    def on_thinking(self, callback: HookCallback) -> HookCallback:
        """Decorator: register an OnThinking hook."""
        self.on(HookEvent.ON_THINKING, callback)
        return callback

    async def fire(self, event: HookEvent, context: HookContext) -> HookResult:
        """Fire all hooks for an event. Returns combined result.

        Hooks are called in registration order. If any hook returns
        allow=False the combined result blocks the action. If multiple
        hooks return modified_input, the last one wins.

        Hooks must not crash the agent — all exceptions are swallowed
        and logged at DEBUG level.
        """
        combined = HookResult(allow=True)
        for callback in self._hooks[event]:
            try:
                result = await callback(context)
                if result is None:
                    continue
                if not result.allow:
                    combined.allow = False
                    combined.reason = result.reason
                if result.modified_input is not None:
                    combined.modified_input = result.modified_input
            except Exception as exc:  # noqa: BLE001
                logger.debug("Hook %s raised %r — ignoring", callback, exc)
        return combined

    def has_hooks(self, event: HookEvent) -> bool:
        """Return True if any callbacks are registered for this event."""
        return bool(self._hooks.get(event))
