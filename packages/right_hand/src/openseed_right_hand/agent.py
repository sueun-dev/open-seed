"""
Open Seed v2 — Codex Agent (Right Hand).

Fast parallel code generation via Codex CLI in --full-auto mode.
Pattern from: codex-rs multi-agent spawn + parallel tools
"""

from __future__ import annotations

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


class CodexAgent:
    """
    Codex agent — invokes Codex CLI for fast parallel code generation.

    Usage:
        agent = CodexAgent(config)
        response = await agent.invoke("Implement the REST API endpoints", cwd="/path/to/project")
    """

    def __init__(
        self,
        config: CodexConfig | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.config = config or CodexConfig()
        self.event_bus = event_bus
        self._cli_path: str | None = None

    def _resolve_cli(self) -> str:
        if not self._cli_path:
            self._cli_path = require_openai_auth(self.config.cli_path)
        return self._cli_path

    async def invoke(
        self,
        prompt: str,
        working_dir: str | None = None,
        auto_mode: bool | None = None,
    ) -> CodexResponse:
        """
        Invoke Codex for code generation.

        Args:
            prompt: The implementation task
            working_dir: Working directory (sandbox scope)
            auto_mode: Override --full-auto setting

        Returns:
            CodexResponse with files created/modified
        """
        cli = self._resolve_cli()
        use_auto = auto_mode if auto_mode is not None else self.config.auto_mode

        cmd = [cli]
        if use_auto:
            cmd.append("--full-auto")
        cmd.extend(["--quiet", prompt])

        files_created: list[str] = []
        files_modified: list[str] = []
        commands_run: list[str] = []
        text_parts: list[str] = []

        async def on_line(line: StreamLine) -> None:
            if line.parsed:
                event_type = line.parsed.get("type", "")
                if event_type == "file_create":
                    files_created.append(line.parsed.get("path", ""))
                elif event_type == "file_edit":
                    files_modified.append(line.parsed.get("path", ""))
                elif event_type == "command":
                    commands_run.append(line.parsed.get("command", ""))
                elif event_type == "text":
                    text_parts.append(line.parsed.get("content", ""))
            else:
                text_parts.append(line.text)

            if self.event_bus:
                await self.event_bus.emit_simple(
                    EventType.AGENT_TEXT, node="codex",
                    text=line.text[:500],
                )

        result = await run_streaming(
            cmd,
            cwd=working_dir,
            timeout_seconds=600,
            on_line=on_line,
        )

        return CodexResponse(
            text="\n".join(text_parts),
            files_created=files_created,
            files_modified=files_modified,
            commands_run=commands_run,
            exit_code=result.exit_code,
        )
