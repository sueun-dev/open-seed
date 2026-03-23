"""
Checkpoint utilities — time travel, fork, history.

Thin async wrappers around LangGraph's built-in checkpoint API.
Requires the compiled graph to have been created with a checkpointer
(see compile_graph(checkpoint_dir=...)).
"""

from __future__ import annotations

from typing import Any


async def get_state_history(
    graph: Any,
    thread_id: str,
    limit: int = 20,
) -> list[Any]:
    """
    Return up to `limit` checkpoint snapshots for a thread, newest first.

    Each snapshot is a LangGraph StateSnapshot with:
        .values  — the PipelineState dict at that point
        .config  — {"configurable": {"thread_id": ..., "checkpoint_id": ...}}
        .metadata — {"step": int, "source": "loop"|"input", ...}
        .next    — tuple of node names that would run next

    Args:
        graph: A compiled LangGraph (from compile_graph()).
        thread_id: The conversation/run thread identifier.
        limit: Maximum number of snapshots to return.

    Returns:
        List of StateSnapshot objects, most recent first.
    """
    config = {"configurable": {"thread_id": thread_id}}
    states: list[Any] = []
    async for snapshot in graph.aget_state_history(config):
        states.append(snapshot)
        if len(states) >= limit:
            break
    return states


async def get_latest_state(graph: Any, thread_id: str) -> Any | None:
    """
    Return the most recent checkpoint snapshot for a thread, or None if none exist.

    Args:
        graph: A compiled LangGraph (from compile_graph()).
        thread_id: The conversation/run thread identifier.

    Returns:
        The latest StateSnapshot, or None.
    """
    snapshots = await get_state_history(graph, thread_id, limit=1)
    return snapshots[0] if snapshots else None


async def fork_from_checkpoint(
    graph: Any,
    thread_id: str,
    checkpoint_id: str,
    new_thread_id: str,
) -> dict[str, Any]:
    """
    Create a new thread by forking from a historical checkpoint.

    Useful for replaying a run from a known-good state without modifying
    the original thread.

    Args:
        graph: A compiled LangGraph (from compile_graph()).
        thread_id: The source thread to fork from.
        checkpoint_id: The checkpoint_id to fork from (from snapshot.config).
        new_thread_id: Thread ID for the new forked run.

    Returns:
        The config dict for the new thread, ready to pass to graph.ainvoke().

    Example:
        history = await get_state_history(graph, "run-1")
        good_snapshot = history[2]  # third-most-recent
        ckpt_id = good_snapshot.config["configurable"]["checkpoint_id"]
        new_config = await fork_from_checkpoint(graph, "run-1", ckpt_id, "run-1-retry")
        result = await graph.ainvoke(None, config=new_config)
    """
    source_config = {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_id": checkpoint_id,
        }
    }
    snapshot = await graph.aget_state(source_config)
    if snapshot is None:
        raise ValueError(
            f"No checkpoint {checkpoint_id!r} found in thread {thread_id!r}"
        )

    new_config = {
        "configurable": {
            "thread_id": new_thread_id,
        }
    }
    # Copy the state from the historical checkpoint into the new thread
    await graph.aupdate_state(new_config, snapshot.values)
    return new_config


__all__ = [
    "get_state_history",
    "get_latest_state",
    "fork_from_checkpoint",
]
