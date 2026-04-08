"""
Open Seed v2 — Codex Agent (Primary Engine).

Fast code generation via Codex CLI with OAuth.
Uses -o (output-last-message) for clean AI response extraction.
"""

from __future__ import annotations

import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any

from openseed_core.auth.openai import require_openai_auth
from openseed_core.config import CodexConfig
from openseed_core.events import EventBus, EventType
from openseed_core.subprocess import StreamLine, run_streaming


@dataclass
class CodexResponse:
    """Response from a Codex agent invocation."""

    text: str = ""
    files_created: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    commands_run: list[str] = field(default_factory=list)
    exit_code: int = 0
    model: str = ""
    session_id: str = ""
    duration_ms: int = 0
    num_turns: int = 0


class CodexAgent:
    """
    Codex agent — invokes Codex CLI for code generation and reasoning.

    Usage:
        agent = CodexAgent()
        response = await agent.invoke("Analyze architecture", model="xhigh")  # gpt-5.4-pro
        response = await agent.invoke("Implement the API", model="high")      # gpt-5.4
    """

    def __init__(
        self,
        config: CodexConfig | None = None,
        event_bus: EventBus | None = None,
        metrics: Any | None = None,
    ) -> None:
        self.config = config or CodexConfig()
        self.event_bus = event_bus
        self.metrics = metrics
        self._cli_path: str | None = None
        self._last_session_id: str | None = None

    def _resolve_cli(self) -> str:
        if not self._cli_path:
            self._cli_path = require_openai_auth(self.config.cli_path)
        return self._cli_path

    def _resolve_model(self, model: str | None) -> str:
        """Resolve model shorthand to full model ID.

        Shorthands:
          - "xhigh" / "heavy"    → config.xhigh_model (gpt-5.4-pro)
          - "high"  / "standard" / "light" → config.high_model (gpt-5.4)
        """
        if model in ("xhigh", "heavy"):
            return self.config.xhigh_model
        if model in ("high", "standard", "light"):
            return self.config.high_model
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
        auto_mode: bool | None = None,
    ) -> CodexResponse:
        """
        Invoke Codex for a task.

        Uses -o (output-last-message) to capture clean AI response
        without CLI headers/metadata mixed in.
        """
        cli = self._resolve_cli()
        resolved_model = self._resolve_model(model)
        use_auto = auto_mode if auto_mode is not None else self.config.auto_mode

        # Create temp file for clean output capture
        output_fd, output_path = tempfile.mkstemp(prefix="codex-out-", suffix=".txt")
        os.close(output_fd)

        try:
            cmd = [cli, "exec"]
            if use_auto:
                cmd.append("--full-auto")
            cmd.append("--ephemeral")  # Don't persist session files

            # Model selection
            if resolved_model:
                cmd.extend(["-m", resolved_model])

            # Clean output capture
            cmd.extend(["-o", output_path])

            # Working directory
            if working_dir:
                cmd.extend(["-C", working_dir])

            # Build final prompt with system prompt prepended
            final_prompt = prompt
            if system_prompt:
                final_prompt = f"SYSTEM INSTRUCTIONS:\n{system_prompt}\n\nTASK:\n{prompt}"

            cmd.append(final_prompt)

            files_created: list[str] = []
            files_modified: list[str] = []
            commands_run: list[str] = []
            text_parts: list[str] = []

            async def on_line(line: StreamLine) -> None:
                if isinstance(line.parsed, dict):
                    event_type = line.parsed.get("type", "")
                    if event_type == "file_create":
                        files_created.append(line.parsed.get("path", ""))
                    elif event_type == "file_edit":
                        files_modified.append(line.parsed.get("path", ""))
                    elif event_type == "command":
                        commands_run.append(line.parsed.get("command", ""))

                if self.event_bus:
                    await self.event_bus.emit_simple(
                        EventType.AGENT_TEXT,
                        node="codex",
                        text=line.text[:500],
                    )

            # Timeout: use max_turns for calculation, or config default
            turns = max_turns or self.config.max_turns
            timeout = turns * 60

            start = time.monotonic()

            result = await run_streaming(
                cmd,
                cwd=None,  # -C handles working dir
                timeout_seconds=timeout,
                on_line=on_line,
            )

            duration_ms = int((time.monotonic() - start) * 1000)

            # Read clean response from -o file (no headers/metadata)
            response_text = ""
            try:
                with open(output_path) as f:
                    response_text = f.read().strip()
            except OSError:
                pass

            # Fallback: if -o file is empty, use streaming text
            if not response_text:
                response_text = "\n".join(text_parts)

            # Capture session ID from output (if available)
            for line in result.lines:
                if isinstance(line.parsed, dict) and line.parsed.get("session_id"):
                    self._last_session_id = str(line.parsed["session_id"])
                    break

            # Emit event
            if self.event_bus:
                await self.event_bus.emit_simple(
                    EventType.NODE_COMPLETE,
                    node="codex",
                    model=resolved_model,
                    duration_ms=duration_ms,
                )

            # Metrics
            if self.metrics is not None:
                try:
                    self.metrics.add(
                        model=resolved_model,
                        cost_usd=0.0,
                        latency_ms=duration_ms,
                        node="codex",
                    )
                except Exception:
                    pass

            return CodexResponse(
                text=response_text,
                files_created=files_created,
                files_modified=files_modified,
                commands_run=commands_run,
                exit_code=result.exit_code,
                model=resolved_model,
                session_id=self._last_session_id or "",
                duration_ms=duration_ms,
            )
        finally:
            # Clean up temp file
            try:
                os.unlink(output_path)
            except OSError:
                pass
