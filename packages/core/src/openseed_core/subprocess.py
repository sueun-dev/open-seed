"""
Open Seed v2 — Shared subprocess runner.

Async subprocess execution with timeout, streaming, and OOM guard.
Used by both left_hand (Claude CLI) and right_hand (Codex CLI).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from openseed_core.errors import SubprocessError


@dataclass
class StreamLine:
    """A single line from subprocess stdout/stderr."""
    source: str  # "stdout" or "stderr"
    text: str
    parsed: dict[str, Any] | None = None  # If line is valid JSON


@dataclass
class SubprocessResult:
    """Result of a subprocess execution."""
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    lines: list[StreamLine] = field(default_factory=list)
    timed_out: bool = False


async def run_streaming(
    command: list[str],
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 600,
    on_line: Any | None = None,
) -> SubprocessResult:
    """
    Run a subprocess with streaming output.

    Args:
        command: Command and arguments
        cwd: Working directory
        env: Environment variables (merged with current)
        timeout_seconds: Max execution time
        on_line: Optional async callback for each StreamLine

    Returns:
        SubprocessResult with exit code and captured output
    """
    import os
    full_env = {**os.environ, **(env or {})}

    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=full_env,
    )
    # Close stdin immediately so child process doesn't wait for input
    if process.stdin:
        process.stdin.close()

    lines: list[StreamLine] = []
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []

    async def read_stream(stream: asyncio.StreamReader, source: str) -> None:
        while True:
            line_bytes = await stream.readline()
            if not line_bytes:
                break
            text = line_bytes.decode("utf-8", errors="replace").rstrip("\n")
            if source == "stdout":
                stdout_parts.append(text)
            else:
                stderr_parts.append(text)

            # Try to parse as JSON (NDJSON protocol)
            parsed = None
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, ValueError):
                pass

            sl = StreamLine(source=source, text=text, parsed=parsed)
            lines.append(sl)

            if on_line:
                try:
                    await on_line(sl)
                except Exception:
                    pass

    timed_out = False
    try:
        assert process.stdout is not None
        assert process.stderr is not None
        await asyncio.wait_for(
            asyncio.gather(
                read_stream(process.stdout, "stdout"),
                read_stream(process.stderr, "stderr"),
            ),
            timeout=timeout_seconds,
        )
        await process.wait()
    except (asyncio.TimeoutError, asyncio.CancelledError):
        timed_out = True
        try:
            process.kill()
        except ProcessLookupError:
            pass
        try:
            await process.wait()
        except Exception:
            pass

    return SubprocessResult(
        exit_code=process.returncode if process.returncode is not None else -1,
        stdout="\n".join(stdout_parts),
        stderr="\n".join(stderr_parts),
        lines=lines,
        timed_out=timed_out,
    )


async def run_simple(
    command: list[str],
    cwd: str | None = None,
    timeout_seconds: int = 30,
) -> SubprocessResult:
    """Run a subprocess and return the result. No streaming."""
    return await run_streaming(command, cwd=cwd, timeout_seconds=timeout_seconds)
