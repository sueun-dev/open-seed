"""
Open Seed v2 — Procedural memory.

Stores step-by-step procedures and workflows learned from successful runs.
When a fix works, the fix strategy is saved for reuse.

Pattern from: mem0 PROCEDURAL_MEMORY (configs/enums.py)
"""

from __future__ import annotations

from typing import Any

from openseed_memory.store import MemoryStore
from openseed_memory.types import MemoryType


async def store_procedure(
    store: MemoryStore,
    task_pattern: str,
    steps: list[str],
    outcome: str,
    metadata: dict[str, Any] | None = None,
) -> str | None:
    """
    Store a successful procedure for future reuse.

    Example: "When building a Node.js REST API, always create package.json first,
    then server.js, then install deps, then test."
    """
    content = f"Procedure for: {task_pattern}\n"
    content += f"Steps:\n"
    for i, step in enumerate(steps, 1):
        content += f"  {i}. {step}\n"
    content += f"Outcome: {outcome}\n"

    extra = metadata or {}
    extra["type"] = "procedure"
    extra["task_pattern"] = task_pattern[:100]
    extra["step_count"] = len(steps)

    return await store.add(
        content=content,
        user_id="system",
        agent_id="pipeline",
        memory_type=MemoryType.PROCEDURAL,
        metadata=extra,
    )


async def recall_procedures(
    store: MemoryStore,
    task: str,
    limit: int = 3,
) -> list[str]:
    """
    Recall relevant procedures for a task.
    Returns procedure texts sorted by relevance.
    """
    results = await store.search(f"procedure for {task}", user_id="system", limit=limit)
    return [r.entry.content for r in results if r.entry.metadata.get("type") == "procedure"]


async def store_fix_strategy(
    store: MemoryStore,
    error_pattern: str,
    fix_applied: str,
    success: bool,
) -> str | None:
    """
    Store a fix strategy — what worked (or didn't) for a specific error.

    This builds a knowledge base of "error X → fix Y works" patterns.
    Next time the same error appears, the system tries Y first.
    """
    content = (
        f"Error pattern: {error_pattern}\n"
        f"Fix applied: {fix_applied}\n"
        f"Result: {'SUCCESS — use this fix again' if success else 'FAILED — do NOT repeat this fix'}\n"
    )

    return await store.add(
        content=content,
        user_id="system",
        agent_id="sentinel",
        memory_type=MemoryType.PROCEDURAL,
        metadata={
            "type": "fix_strategy",
            "error_pattern": error_pattern[:200],
            "success": success,
        },
    )


async def recall_fix_strategies(
    store: MemoryStore,
    error: str,
    limit: int = 5,
) -> tuple[list[str], list[str]]:
    """
    Recall fix strategies for an error.

    Returns:
        (successful_fixes, failed_fixes) — try successful ones, avoid failed ones
    """
    results = await store.search(f"fix for error: {error}", user_id="system", limit=limit)

    successful: list[str] = []
    failed: list[str] = []

    for r in results:
        meta = r.entry.metadata or {}
        if meta.get("type") != "fix_strategy":
            continue
        if meta.get("success"):
            successful.append(r.entry.content)
        else:
            failed.append(r.entry.content)

    return successful, failed
