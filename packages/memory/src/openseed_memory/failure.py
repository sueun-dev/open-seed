"""
Open Seed v2 — Failure pattern learning.

Stores failed pipeline runs as procedural memories so the system
learns from mistakes and doesn't repeat them.

Pattern from: mem0 procedural memory + SQLite history
"""

from __future__ import annotations

from openseed_memory.store import MemoryStore
from openseed_memory.types import MemoryType, FailurePattern


async def record_failure(
    store: MemoryStore,
    task: str,
    errors: list[str],
    attempted_fixes: list[str],
    successful_fix: str = "",
    user_id: str = "system",
) -> None:
    """
    Record a pipeline failure as procedural memory.

    This enables the system to:
    1. Recognize similar failure patterns in future runs
    2. Skip approaches that already failed
    3. Apply fixes that worked before
    """
    content_parts = [
        f"Task: {task[:200]}",
        f"Errors: {'; '.join(errors[:5])}",
        f"Attempted fixes: {'; '.join(attempted_fixes[:5])}",
    ]
    if successful_fix:
        content_parts.append(f"Successful fix: {successful_fix}")
    else:
        content_parts.append("Status: UNRESOLVED")

    content = "\n".join(content_parts)

    await store.add(
        content=content,
        user_id=user_id,
        agent_id="sentinel",
        memory_type=MemoryType.PROCEDURAL,
        metadata={
            "type": "failure_pattern",
            "task_summary": task[:100],
            "error_count": len(errors),
            "resolved": bool(successful_fix),
        },
    )


async def recall_similar_failures(
    store: MemoryStore,
    task: str,
    errors: list[str],
    user_id: str = "system",
    limit: int = 5,
) -> list[FailurePattern]:
    """
    Search for similar past failures to inform the current fix attempt.

    Returns patterns that might help avoid repeating the same mistakes.
    """
    query = f"Failure pattern for: {task[:100]}. Errors: {'; '.join(errors[:3])}"
    results = await store.search(query=query, user_id=user_id, limit=limit)

    patterns: list[FailurePattern] = []
    for r in results:
        meta = r.entry.metadata or {}
        if meta.get("type") == "failure_pattern":
            patterns.append(FailurePattern(
                task_pattern=meta.get("task_summary", ""),
                error_type=r.entry.content[:200],
                root_cause="",
                successful_fix="resolved" if meta.get("resolved") else "unresolved",
                occurrences=1,
            ))

    return patterns
