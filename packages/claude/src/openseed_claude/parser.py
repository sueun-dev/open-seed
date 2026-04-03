"""
Open Seed v2 — Claude CLI output parser.

Parses raw subprocess output from Claude CLI into StructuredResponse.

Strategy:
  - Primary: --output-format json (NOT stream-json — known hang issue)
    Emits a final JSON object with messages[], usage, cost, session_id, etc.
  - Fallback: --print mode (plain text)
    No structured data; text only, no usage stats.

The JSON output format emits one JSON object per line (NDJSON) where each line
is a message of type: "assistant", "user", "system", "result".
We scan all lines, collect content blocks, and aggregate usage from
the final "result" message.

See research/claude-code-sdk-python for the canonical message schema.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from openseed_claude.messages import (
    StructuredResponse,
    ToolResultBlock,
    ToolUseBlock,
    UsageStats,
)

logger = logging.getLogger(__name__)


# ─── JSON (NDJSON) parser ─────────────────────────────────────────────────────


def _parse_content_blocks(
    blocks: list[dict[str, Any]],
    text_parts: list[str],
    thinking_parts: list[str],
    tool_uses: list[ToolUseBlock],
    tool_results: list[ToolResultBlock],
) -> None:
    """Extract typed content from a list of raw content block dicts (in-place)."""
    for block in blocks:
        btype = block.get("type", "")
        match btype:
            case "text":
                t = block.get("text", "")
                if t:
                    text_parts.append(t)
            case "thinking":
                th = block.get("thinking", "")
                if th:
                    thinking_parts.append(th)
            case "tool_use":
                tool_uses.append(
                    ToolUseBlock(
                        tool_id=block.get("id", ""),
                        tool_name=block.get("name", ""),
                        input=block.get("input") or {},
                    )
                )
            case "tool_result":
                raw_content = block.get("content", "")
                if isinstance(raw_content, list):
                    # Content can be a list of {type: "text", text: "..."} blocks
                    content_str = "\n".join(
                        c.get("text", "") for c in raw_content if isinstance(c, dict) and c.get("type") == "text"
                    )
                else:
                    content_str = str(raw_content) if raw_content is not None else ""
                tool_results.append(
                    ToolResultBlock(
                        tool_use_id=block.get("tool_use_id", ""),
                        content=content_str,
                        is_error=bool(block.get("is_error", False)),
                    )
                )
            case _:
                pass  # Forward-compatible: skip unknown block types


def _extract_usage(usage_dict: dict[str, Any] | None) -> UsageStats:
    """Convert a raw usage dict into UsageStats."""
    if not usage_dict:
        return UsageStats()
    return UsageStats(
        input_tokens=int(usage_dict.get("input_tokens", 0)),
        output_tokens=int(usage_dict.get("output_tokens", 0)),
        cache_read_tokens=int(usage_dict.get("cache_read_input_tokens", 0) or usage_dict.get("cache_read_tokens", 0)),
        cache_write_tokens=int(
            usage_dict.get("cache_creation_input_tokens", 0) or usage_dict.get("cache_write_tokens", 0)
        ),
    )


def parse_json_output(raw: str) -> StructuredResponse:
    """Parse --output-format json (NDJSON) output from Claude CLI.

    Each line is a JSON message object. We process:
      - type=assistant: content blocks (text, thinking, tool_use, tool_result)
      - type=result: usage stats, session_id, duration_ms, num_turns

    Raises:
        ValueError: If no parseable JSON messages are found in raw output.
    """
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_uses: list[ToolUseBlock] = []
    tool_results: list[ToolResultBlock] = []
    usage = UsageStats()
    model = ""
    session_id = ""
    duration_ms = 0
    num_turns = 0
    is_error = False
    raw_json: dict[str, Any] | None = None

    found_any = False

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue

        if not isinstance(data, dict):
            continue

        found_any = True
        msg_type = data.get("type", "")

        match msg_type:
            case "assistant":
                msg = data.get("message", {})
                if not model:
                    model = msg.get("model", "")
                content = msg.get("content", [])
                if isinstance(content, list):
                    _parse_content_blocks(content, text_parts, thinking_parts, tool_uses, tool_results)
                # Per-message usage (aggregated into result; use result message instead)
                # but capture here as fallback if no result message comes
                msg_usage = msg.get("usage")
                if msg_usage:
                    usage = _extract_usage(msg_usage)

            case "result":
                raw_json = data
                session_id = data.get("session_id", session_id)
                duration_ms = int(data.get("duration_ms", 0))
                num_turns = int(data.get("num_turns", 0))
                is_error = bool(data.get("is_error", False))
                result_usage = data.get("usage")
                if result_usage:
                    usage = _extract_usage(result_usage)
                # result.result is the final text for --print-style modes
                result_text = data.get("result")
                if result_text and not text_parts:
                    text_parts.append(str(result_text))

            case "system":
                # system messages carry session_id
                sid = data.get("session_id")
                if sid and not session_id:
                    session_id = str(sid)

            case _:
                pass

    if not found_any:
        raise ValueError("No JSON messages found in output")

    return StructuredResponse(
        text="\n".join(text_parts),
        thinking="\n".join(thinking_parts),
        tool_uses=tool_uses,
        tool_results=tool_results,
        usage=usage,
        model=model,
        session_id=session_id,
        duration_ms=duration_ms,
        num_turns=num_turns,
        is_error=is_error,
        raw_json=raw_json,
    )


# ─── Plain text (--print) parser ──────────────────────────────────────────────


def parse_text_output(raw: str) -> StructuredResponse:
    """Parse plain text output from Claude CLI --print mode.

    No structured data available; wraps raw text in a StructuredResponse.
    Usage stats will be zero (not available in this mode).
    """
    return StructuredResponse(text=raw.strip())


# ─── Stderr usage extraction ─────────────────────────────────────────────────


def _try_extract_usage_from_stderr(stderr: str) -> UsageStats | None:
    """Attempt to extract usage stats from stderr lines (opportunistic).

    The Claude CLI sometimes emits JSON usage info on stderr.
    Returns None if nothing useful is found.
    """
    for line in stderr.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            if isinstance(data, dict) and "input_tokens" in data:
                return _extract_usage(data)
        except (json.JSONDecodeError, ValueError):
            pass
    return None


# ─── Main entry point ─────────────────────────────────────────────────────────


def parse_output(raw: str, stderr: str = "") -> StructuredResponse:
    """Parse Claude CLI output — tries JSON first, falls back to plain text.

    Args:
        raw: Full stdout from the Claude CLI subprocess.
        stderr: Full stderr (may contain usage info in some CLI versions).

    Returns:
        StructuredResponse with all available fields populated.
    """
    # Try JSON (NDJSON) parse first
    try:
        response = parse_json_output(raw)
        # Augment with stderr usage if our JSON parse got no usage
        if response.usage.total_tokens == 0 and stderr:
            stderr_usage = _try_extract_usage_from_stderr(stderr)
            if stderr_usage:
                response.usage = stderr_usage
        return response
    except Exception as exc:
        logger.debug("JSON parse failed (%s), falling back to plain text", exc)

    # Fall back to plain text
    response = parse_text_output(raw)

    # Still try to get usage from stderr
    if stderr:
        stderr_usage = _try_extract_usage_from_stderr(stderr)
        if stderr_usage:
            response.usage = stderr_usage

    return response
