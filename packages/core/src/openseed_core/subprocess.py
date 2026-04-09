"""
Open Seed v2 — Shared subprocess runner.

Async subprocess execution with timeout, streaming, and OOM guard.
Two timeout layers:
  1. Hard timeout — total wall-clock limit (kills process)
  2. Idle timeout — kills if no output for N seconds (catches hangs)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import dataclass, field
from typing import Any


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
    idle_timeout_seconds: int = 120,
    on_line: Any | None = None,
) -> SubprocessResult:
    """
    Run a subprocess with streaming output.

    Args:
        command: Command and arguments
        cwd: Working directory
        env: Environment variables (merged with current)
        timeout_seconds: Max total wall-clock time
        idle_timeout_seconds: Kill if no output for this many seconds
        on_line: Optional async callback for each StreamLine

    Returns:
        SubprocessResult with exit code and captured output
    """
    import os

    full_env = {**os.environ, **(env or {})}
    full_env.pop("CLAUDECODE", None)

    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=full_env,
    )
    if process.stdin:
        process.stdin.close()

    lines: list[StreamLine] = []
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    last_activity = time.monotonic()

    async def read_stream(stream: asyncio.StreamReader, source: str) -> None:
        nonlocal last_activity
        while True:
            line_bytes = await stream.readline()
            if not line_bytes:
                break
            last_activity = time.monotonic()
            text = line_bytes.decode("utf-8", errors="replace").rstrip("\n")
            if source == "stdout":
                stdout_parts.append(text)
            else:
                stderr_parts.append(text)

            # Try to parse as JSON (NDJSON protocol) — only accept dicts
            parsed = None
            with contextlib.suppress(json.JSONDecodeError, ValueError):
                val = json.loads(text)
                if isinstance(val, dict):
                    parsed = val

            sl = StreamLine(source=source, text=text, parsed=parsed)
            lines.append(sl)

            if on_line:
                with contextlib.suppress(Exception):
                    await on_line(sl)

    async def idle_watchdog() -> None:
        """Kill process if no output for idle_timeout_seconds."""
        while process.returncode is None:
            await asyncio.sleep(5)
            idle = time.monotonic() - last_activity
            if idle > idle_timeout_seconds:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                return

    timed_out = False
    try:
        assert process.stdout is not None
        assert process.stderr is not None

        # Run readers + idle watchdog, with hard timeout on top
        await asyncio.wait_for(
            asyncio.gather(
                read_stream(process.stdout, "stdout"),
                read_stream(process.stderr, "stderr"),
                idle_watchdog(),
            ),
            timeout=timeout_seconds,
        )
        await process.wait()
    except (TimeoutError, asyncio.CancelledError):
        timed_out = True
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await process.wait()
    except Exception:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await process.wait()
        raise

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
