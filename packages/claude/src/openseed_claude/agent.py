"""
Open Seed v2 — Claude Agent (Left Hand).

Deep reasoning via Opus. Implementation via Sonnet.
Spawns Claude CLI directly as a subprocess.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from openseed_core.auth.claude import require_claude_auth
from openseed_core.config import ClaudeConfig
from openseed_core.events import EventBus, EventType
from openseed_core.subprocess import StreamLine, run_streaming

from openseed_claude.hooks import HookContext, HookEvent, HookRegistry
from openseed_claude.mcp import MCPConfig
from openseed_claude.messages import (
    CostEstimate,
    ToolUseBlock,
    UsageStats,
    estimate_cost,
)
from openseed_claude.parser import parse_output


@dataclass
class ClaudeResponse:
    """Response from a Claude agent invocation."""
    text: str = ""
    thinking: str = ""
    tool_uses: list[ToolUseBlock] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""
    session_id: str = ""
    usage: UsageStats = field(default_factory=UsageStats)
    cost: CostEstimate = field(default_factory=CostEstimate)
    duration_ms: int = 0
    num_turns: int = 0


class ClaudeAgent:
    """
    Claude agent — invokes Claude CLI for deep reasoning and implementation.

    Usage:
        agent = ClaudeAgent(config)
        response = await agent.invoke("Analyze this architecture", model="opus")

        # Multi-turn session:
        response1 = await agent.invoke("Analyze this", session_id="my-session")
        response2 = await agent.invoke("Now fix it", continue_session=True)
    """

    def __init__(
        self,
        config: ClaudeConfig | None = None,
        event_bus: EventBus | None = None,
        hooks: HookRegistry | dict[str, Any] | None = None,
        mcp_config: MCPConfig | None = None,
    ) -> None:
        self.config = config or ClaudeConfig()
        self.event_bus = event_bus
        # Accept HookRegistry (new) or plain dict (legacy backward-compat).
        if isinstance(hooks, HookRegistry):
            self.hook_registry: HookRegistry = hooks
        else:
            # Wrap legacy dict-style hooks into a HookRegistry.
            self.hook_registry = HookRegistry()
            if hooks:
                legacy = hooks  # capture

                async def _legacy_pre(ctx: HookContext):  # type: ignore[no-untyped-def]
                    cb = legacy.get("PreToolUse")
                    if cb:
                        await cb(ctx.text or ctx.tool_name, ctx.tool_input)

                async def _legacy_post(ctx: HookContext):  # type: ignore[no-untyped-def]
                    cb = legacy.get("PostToolUse")
                    if cb:
                        await cb(ctx.text or ctx.tool_result, ctx.tool_input)

                if legacy.get("PreToolUse"):
                    self.hook_registry.on(HookEvent.PRE_TOOL_USE, _legacy_pre)
                if legacy.get("PostToolUse"):
                    self.hook_registry.on(HookEvent.POST_TOOL_USE, _legacy_post)

        # Keep self.hooks as a read-only alias for external callers that still
        # access agent.hooks["PreToolUse"] directly (legacy support).
        self.hooks: dict[str, Any] = hooks if isinstance(hooks, dict) else {}
        self.mcp_config: MCPConfig | None = mcp_config
        self._cli_path: str | None = None
        self._last_session_id: str | None = None

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
        role: str | None = None,
        session_id: str | None = None,
        continue_session: bool = False,
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
            role: Role name from roles.py (overrides model/system_prompt/tools)
            session_id: Session ID for multi-turn (creates new session)
            continue_session: Continue last session (uses _last_session_id)

        Returns:
            ClaudeResponse with text, tool uses, usage, cost, and timing
        """
        cli = self._resolve_cli()

        # Apply role if specified
        if role:
            from openseed_claude.roles import get_role
            try:
                r = get_role(role)
                model = model or r.model
                system_prompt = system_prompt or r.system_prompt
                if not allowed_tools and r.tools:
                    allowed_tools = r.tools
                if not max_turns:
                    # Use role's max_turns if defined; fall back to insight default
                    max_turns = r.max_turns or (5 if role == "insight" else None)
            except KeyError:
                pass

        resolved_model = self._resolve_model(model)

        # IMPORTANT: Use --print mode (proven stable).
        # Do NOT use --output-format stream-json — causes subprocess hangs.
        # --output-format json is attempted via post-parse; we keep --print
        # as the subprocess invocation to ensure reliable output.
        cmd = [cli, "--print", "--dangerously-skip-permissions"]

        # 1M context is GA (not beta) — always available with Opus/Sonnet
        # No --betas flag needed. Claude CLI uses 1M context by default.

        # Session support
        if continue_session and self._last_session_id:
            cmd.extend(["--resume", self._last_session_id])
        elif session_id:
            cmd.extend(["--session-id", session_id])
        if resolved_model:
            cmd.extend(["--model", resolved_model])
        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])
        if max_turns:
            cmd.extend(["--max-turns", str(max_turns)])

        # MCP server config — write a temp JSON file and pass its path
        _mcp_config_path: str | None = None
        if self.mcp_config and self.mcp_config.has_servers():
            _mcp_config_path = self.mcp_config.write_config_file()
            cmd.extend(["--mcp-config", _mcp_config_path])

        # Prompt as positional argument (after all flags)
        cmd.append(prompt)

        text_parts: list[str] = []

        async def on_line(line: StreamLine) -> None:
            # --print mode outputs plain text (not JSON)
            if line.source == "stdout" and line.text.strip():
                text_parts.append(line.text)

            if self.event_bus:
                await self.event_bus.emit_simple(
                    EventType.AGENT_TEXT, node="claude",
                    text=line.text[:500], model=resolved_model,
                )

        # Track wall-clock duration
        start = time.monotonic()

        try:
            result = await run_streaming(
                cmd,
                cwd=working_dir,
                timeout_seconds=self.config.max_turns * 60,
                on_line=on_line,
            )
        finally:
            # Clean up the temporary MCP config file (if one was written)
            if _mcp_config_path is not None:
                import os as _os
                try:
                    _os.unlink(_mcp_config_path)
                except OSError:
                    pass

        duration_ms = int((time.monotonic() - start) * 1000)

        # Parse output: --print gives plain text, but the parser also handles
        # NDJSON lines that the CLI may embed (e.g. session info).
        parsed = parse_output(result.stdout, stderr=result.stderr)

        # Capture session_id for multi-turn continuation
        # Prefer parsed session_id (from JSON lines), fall back to scanning raw lines
        if parsed.session_id:
            self._last_session_id = parsed.session_id
        else:
            for line in result.lines:
                if line.parsed and line.parsed.get("session_id"):
                    self._last_session_id = str(line.parsed["session_id"])
                    break

        # Compute cost estimate from usage (if we got any token counts)
        usage = parsed.usage
        cost = estimate_cost(usage, parsed.model or resolved_model)

        # ── Fire structured hooks based on parsed output ──────────────────────
        # These fire AFTER the subprocess completes; the CLI runs Claude
        # in --print mode so we can only inspect results post-hoc.

        # PreToolUse + PostToolUse: one pair per tool invocation found in output
        for tool_use in parsed.tool_uses:
            if self.hook_registry.has_hooks(HookEvent.PRE_TOOL_USE):
                await self.hook_registry.fire(
                    HookEvent.PRE_TOOL_USE,
                    HookContext(
                        event=HookEvent.PRE_TOOL_USE,
                        tool_name=tool_use.tool_name,
                        tool_input=tool_use.input,
                        model=parsed.model or resolved_model,
                        session_id=self._last_session_id or "",
                    ),
                )

        for tool_result in parsed.tool_results:
            if self.hook_registry.has_hooks(HookEvent.POST_TOOL_USE):
                await self.hook_registry.fire(
                    HookEvent.POST_TOOL_USE,
                    HookContext(
                        event=HookEvent.POST_TOOL_USE,
                        tool_result=tool_result.content,
                        is_error=tool_result.is_error,
                        model=parsed.model or resolved_model,
                        session_id=self._last_session_id or "",
                    ),
                )

        # OnError: fire if the result is marked as an error
        if parsed.is_error and self.hook_registry.has_hooks(HookEvent.ON_ERROR):
            await self.hook_registry.fire(
                HookEvent.ON_ERROR,
                HookContext(
                    event=HookEvent.ON_ERROR,
                    is_error=True,
                    text=parsed.text,
                    model=parsed.model or resolved_model,
                    session_id=self._last_session_id or "",
                ),
            )

        # OnThinking: fire if extended thinking was captured
        if parsed.thinking and self.hook_registry.has_hooks(HookEvent.ON_THINKING):
            await self.hook_registry.fire(
                HookEvent.ON_THINKING,
                HookContext(
                    event=HookEvent.ON_THINKING,
                    thinking=parsed.thinking,
                    model=parsed.model or resolved_model,
                    session_id=self._last_session_id or "",
                ),
            )

        # Stop: always fire when the invocation completes successfully
        if self.hook_registry.has_hooks(HookEvent.STOP):
            await self.hook_registry.fire(
                HookEvent.STOP,
                HookContext(
                    event=HookEvent.STOP,
                    text=parsed.text,
                    model=parsed.model or resolved_model,
                    session_id=self._last_session_id or "",
                ),
            )

        # ─────────────────────────────────────────────────────────────────────

        # Emit richer event with token/cost data
        if self.event_bus:
            await self.event_bus.emit_simple(
                EventType.NODE_COMPLETE, node="claude",
                model=resolved_model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                total_tokens=usage.total_tokens,
                cost_usd=cost.total_cost,
                duration_ms=duration_ms,
            )

        # --print mode text (from streaming on_line) is the canonical response text
        # when we're not in JSON mode. If the parser found structured text, prefer it.
        response_text = parsed.text or "\n".join(text_parts)

        return ClaudeResponse(
            text=response_text,
            thinking=parsed.thinking,
            tool_uses=parsed.tool_uses,
            tool_results=[],  # Legacy field; structured tool results in tool_uses
            model=parsed.model or resolved_model,
            session_id=self._last_session_id or "",
            usage=usage,
            cost=cost,
            duration_ms=duration_ms,
            num_turns=parsed.num_turns,
        )
