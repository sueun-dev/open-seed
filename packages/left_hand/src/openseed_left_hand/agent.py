"""
Open Seed v2 — Claude Agent (Left Hand).

Deep reasoning via Opus. Implementation via Sonnet.
Spawns Claude CLI as subprocess via claude-agent-sdk pattern.

Pattern from: claude-code-sdk-python ClaudeSDKClient + query()
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator

from openseed_core.auth.claude import require_claude_auth
from openseed_core.config import ClaudeConfig
from openseed_core.events import EventBus, EventType
from openseed_core.subprocess import StreamLine, run_streaming


@dataclass
class ClaudeResponse:
    """Response from a Claude agent invocation."""
    text: str = ""
    tool_results: list[dict[str, Any]] = None  # type: ignore[assignment]
    thinking: str = ""
    model: str = ""

    def __post_init__(self) -> None:
        if self.tool_results is None:
            self.tool_results = []


class ClaudeAgent:
    """
    Claude agent — invokes Claude CLI for deep reasoning and implementation.

    Usage:
        agent = ClaudeAgent(config)
        response = await agent.invoke("Analyze this architecture", model="opus")
    """

    def __init__(
        self,
        config: ClaudeConfig | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.config = config or ClaudeConfig()
        self.event_bus = event_bus
        self._cli_path: str | None = None

    def _resolve_cli(self) -> str:
        """Find and verify Claude CLI."""
        if not self._cli_path:
            self._cli_path = require_claude_auth(self.config.cli_path)
        return self._cli_path

    def _resolve_model(self, model: str | None) -> str:
        """Resolve model shorthand to full model ID."""
        if model == "opus":
            return self.config.opus_model
        if model == "sonnet":
            return self.config.sonnet_model
        if model == "haiku":
            return self.config.haiku_model
        return model or self.config.default_model

    async def invoke(
        self,
        prompt: str,
        model: str | None = None,
        system_prompt: str | None = None,
        working_dir: str | None = None,
        allowed_tools: list[str] | None = None,
        max_turns: int | None = None,
    ) -> ClaudeResponse:
        """
        Invoke Claude for a single task.

        Args:
            prompt: The task/question
            model: "opus", "sonnet", "haiku", or full model ID
            system_prompt: Custom system instructions
            working_dir: Working directory for file operations
            allowed_tools: Tool allowlist (e.g., ["Read", "Write", "Bash"])
            max_turns: Max conversation turns

        Returns:
            ClaudeResponse with text, tool results, and thinking
        """
        cli = self._resolve_cli()
        resolved_model = self._resolve_model(model)

        cmd = [cli, "--print", "--output-format", "stream-json"]
        if resolved_model:
            cmd.extend(["--model", resolved_model])
        if system_prompt:
            cmd.extend(["--system-prompt", system_prompt])
        if max_turns:
            cmd.extend(["--max-turns", str(max_turns)])
        if allowed_tools:
            for tool in allowed_tools:
                cmd.extend(["--allowedTools", tool])
        cmd.extend(["--prompt", prompt])

        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_results: list[dict[str, Any]] = []

        async def on_line(line: StreamLine) -> None:
            if line.parsed:
                msg_type = line.parsed.get("type", "")
                if msg_type == "assistant" and "content" in line.parsed:
                    for block in line.parsed["content"]:
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "thinking":
                            thinking_parts.append(block.get("thinking", ""))
                        elif block.get("type") == "tool_result":
                            tool_results.append(block)
                # Stream to event bus
                if self.event_bus:
                    await self.event_bus.emit_simple(
                        EventType.AGENT_TEXT, node="claude",
                        text=line.text[:500], model=resolved_model,
                    )

        result = await run_streaming(
            cmd,
            cwd=working_dir,
            timeout_seconds=self.config.max_turns * 60,  # Generous timeout
            on_line=on_line,
        )

        return ClaudeResponse(
            text="\n".join(text_parts),
            tool_results=tool_results,
            thinking="\n".join(thinking_parts),
            model=resolved_model,
        )
