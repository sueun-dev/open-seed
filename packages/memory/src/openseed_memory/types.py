"""Memory types."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class MemoryType(StrEnum):
    SEMANTIC = "semantic"  # Facts, preferences, knowledge
    EPISODIC = "episodic"  # Events, conversations
    PROCEDURAL = "procedural"  # Workflows, how-to, skills


class MemoryEvent(StrEnum):
    ADD = "ADD"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    NONE = "NONE"


@dataclass
class MemoryEntry:
    """A single memory entry."""

    id: str = ""
    content: str = ""
    memory_type: MemoryType = MemoryType.SEMANTIC
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)


@dataclass
class HistoryRecord:
    """A single history record tracking memory changes."""

    id: str = ""
    memory_id: str = ""
    old_content: str = ""
    new_content: str = ""
    event: MemoryEvent = MemoryEvent.ADD
    created_at: datetime = field(default_factory=datetime.now)


@dataclass
class SearchResult:
    """A memory search result with relevance score."""

    entry: MemoryEntry
    score: float = 0.0


@dataclass
class FailurePattern:
    """A learned failure pattern from past pipeline runs."""

    task_pattern: str = ""
    error_type: str = ""
    root_cause: str = ""
    successful_fix: str = ""
    occurrences: int = 1
    last_seen: datetime = field(default_factory=datetime.now)
