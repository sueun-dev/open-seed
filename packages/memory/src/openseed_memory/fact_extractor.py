"""
LLM-driven fact extraction, dedup, and smart memory decisions.
Uses Claude (via Left Hand) to extract facts from raw content,
check for duplicates, and decide: ADD / UPDATE / DELETE / NOOP.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

logger = logging.getLogger(__name__)

from openseed_memory.types import MemoryEvent

if TYPE_CHECKING:
    from openseed_memory.store import MemoryStore


@dataclass
class MemoryDecision:
    """A single memory decision from the LLM fact extractor."""

    action: MemoryEvent
    content: str
    memory_id: str | None = None  # Set for UPDATE / DELETE
    memory_type: str = "semantic"
    metadata: dict[str, Any] = field(default_factory=dict)
    reasoning: str = ""


_EXTRACT_PROMPT = """\
You are a memory fact extractor. Given raw content, extract discrete facts worth remembering.

For each fact, search the existing memories and decide:
- ADD: new fact not in memory
- UPDATE: supersedes an existing memory (provide memory_id)
- DELETE: existing memory is now wrong/obsolete (provide memory_id)
- NOOP: already captured, no change needed

Return ONLY a valid JSON array. No commentary before or after.

Schema per item:
{{
  "action": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "content": "<the fact as a concise statement>",
  "memory_id": "<id of memory to update/delete, or null>",
  "memory_type": "semantic" | "episodic" | "procedural",
  "reasoning": "<one sentence why>"
}}

--- EXISTING MEMORIES ---
{existing}

--- RAW CONTENT ---
{content}

Return JSON array only:"""


class FactExtractor:
    """
    LLM-based fact extractor. Calls Claude Haiku to decompose raw content
    into discrete facts and decide how each should affect the memory store.
    """

    def __init__(self, cli_path: str | None = None, model: str = "gpt-5.4") -> None:
        self._cli_path = cli_path
        self._model = model

    def _get_cli(self) -> str | None:
        """Resolve CLI path, returning None if not available."""
        if self._cli_path:
            return self._cli_path
        try:
            from openseed_core.auth.openai import get_codex_cli_path

            return get_codex_cli_path()
        except Exception:
            return None

    async def extract(
        self,
        content: str,
        store: MemoryStore,
        user_id: str = "default",
    ) -> list[MemoryDecision]:
        """
        Extract facts from raw content and decide memory actions.

        Args:
            content: Raw text to extract facts from (conversation, log, note, etc.)
            store: MemoryStore for searching existing memories
            user_id: User namespace for memory lookup

        Returns:
            List of MemoryDecision items. Empty list on failure (graceful fallback).
        """
        cli = self._get_cli()
        if not cli:
            return []

        # Search existing memories relevant to this content for context
        existing_memories = await store.search(query=content[:500], user_id=user_id, limit=10)
        existing_text = "\n".join(f"[{r.entry.id}] {r.entry.content}" for r in existing_memories) or "(none)"

        prompt = _EXTRACT_PROMPT.format(
            existing=existing_text,
            content=content[:4000],
        )

        cmd = [
            cli,
            "exec",
            "--full-auto",
            "-m",
            self._model,
            prompt,
        ]

        try:
            from openseed_core.subprocess import run_streaming

            result = await run_streaming(cmd, timeout_seconds=60)
            raw_output = result.stdout.strip()
        except Exception as exc:
            logger.debug("Fact extraction LLM call failed: %s", exc)
            return []

        return self._parse_decisions(raw_output)

    def _parse_decisions(self, raw: str) -> list[MemoryDecision]:
        """Parse LLM JSON output into MemoryDecision list. Never raises."""
        if not raw:
            return []

        # Locate the JSON array in the output
        start = raw.find("[")
        end = raw.rfind("]")
        if start == -1 or end == -1:
            return []

        json_str = raw[start : end + 1]
        try:
            items = json.loads(json_str)
        except (json.JSONDecodeError, ValueError):
            return []

        if not isinstance(items, list):
            return []

        decisions: list[MemoryDecision] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            action_str = str(item.get("action", "NOOP")).upper()
            try:
                action = MemoryEvent(action_str)
            except ValueError:
                action = MemoryEvent.NONE

            decisions.append(
                MemoryDecision(
                    action=action,
                    content=str(item.get("content", "")),
                    memory_id=item.get("memory_id") or None,
                    memory_type=str(item.get("memory_type", "semantic")),
                    metadata=dict(item.get("metadata") or {}),
                    reasoning=str(item.get("reasoning", "")),
                )
            )

        return decisions
