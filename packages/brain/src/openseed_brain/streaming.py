"""
Streaming support for the Open Seed pipeline.
Pattern from: LangGraph stream modes (research/langgraph/libs/langgraph/langgraph/types.py).

LangGraph StreamMode is a Literal type alias — valid values:
  "values"      — full state snapshot after each node
  "updates"     — node name + its state delta only
  "messages"    — token-by-token LLM output + metadata
  "tasks"       — task lifecycle (start/end/error per node)
  "custom"      — custom data emitted via StreamWriter inside nodes
  "checkpoints" — checkpoint created events
  "debug"       — combined checkpoints + tasks

Our PipelineStreamMode enum wraps the four modes we care about.
The "updates" mode is the default: lightweight, one event per node.

Usage:
    async for event in stream_pipeline(graph, state, mode=PipelineStreamMode.UPDATES):
        print(event.node, event.data)

    # Multiple modes at once
    async for event in stream_pipeline(
        graph, state,
        mode=[PipelineStreamMode.UPDATES, PipelineStreamMode.MESSAGES],
    ):
        if event.mode == PipelineStreamMode.MESSAGES:
            sys.stdout.write(event.data.get("content", ""))
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class PipelineStreamMode(StrEnum):
    """Streaming modes supported by the Open Seed pipeline.

    Maps 1-to-1 to LangGraph's StreamMode literal strings so they can be
    passed directly to `compiled_graph.astream(stream_mode=...)`.
    """

    UPDATES = "updates"
    """Node name + state delta only. Lightweight — one event per node. Default."""

    VALUES = "values"
    """Full state snapshot after each node. Heavy but complete."""

    MESSAGES = "messages"
    """Token-by-token LLM output with metadata. Best for streaming text to UI."""

    TASKS = "tasks"
    """Task lifecycle events (start / end / error) per node."""

    CUSTOM = "custom"
    """Custom data emitted inside nodes via LangGraph StreamWriter."""


@dataclass
class StreamEvent:
    """A single streaming event from the pipeline.

    Attributes:
        mode: Which streaming mode produced this event.
        node: Name of the graph node that emitted it (empty for pipeline-level events).
        data: Event payload — shape varies by mode (see _parse_chunk).
        timestamp_ms: Unix epoch milliseconds when the event was created.
    """

    mode: PipelineStreamMode
    node: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    timestamp_ms: int = 0


# ---------------------------------------------------------------------------
# Core streaming function
# ---------------------------------------------------------------------------


async def stream_pipeline(
    compiled_graph: Any,
    initial_state: dict[str, Any],
    thread_id: str = "default",
    mode: PipelineStreamMode | list[PipelineStreamMode] = PipelineStreamMode.UPDATES,
    event_bus: Any = None,
) -> AsyncIterator[StreamEvent]:
    """Stream pipeline execution events from a compiled LangGraph.

    Wraps `compiled_graph.astream()` and yields typed `StreamEvent` objects.
    Optionally bridges every event to an `EventBus` for real-time UI delivery.

    Args:
        compiled_graph: A compiled LangGraph (output of `compile_graph()`).
        initial_state: Initial pipeline state dict.
        thread_id: Checkpointer thread ID for crash-recovery continuity.
        mode: One or more `PipelineStreamMode` values. When multiple modes are
            given, each yielded event carries the `mode` that produced it.
        event_bus: Optional `openseed_core.events.EventBus`. When provided,
            every stream event is also emitted as `EventType.PIPELINE_STREAM`.

    Yields:
        `StreamEvent` — one per LangGraph stream chunk.

    Notes:
        - On any exception the generator yields a single error `StreamEvent`
          with `node="pipeline"` and `data={"error": ..., "type": "pipeline_error"}`
          rather than propagating the exception, so callers can always iterate
          to completion and check for errors in the data.
    """
    config: dict[str, Any] = {"configurable": {"thread_id": thread_id}}

    # Normalise to list
    modes: list[PipelineStreamMode] = [mode] if isinstance(mode, PipelineStreamMode) else list(mode)

    # LangGraph expects the raw string values
    lg_modes: list[str] = [m.value for m in modes]
    multi_mode = len(lg_modes) > 1

    try:
        async for chunk in compiled_graph.astream(
            initial_state,
            config=config,
            stream_mode=lg_modes if multi_mode else lg_modes[0],
        ):
            ts = int(time.time() * 1000)

            if multi_mode and isinstance(chunk, tuple):
                # LangGraph emits (mode_name_str, data) tuples in multi-mode
                mode_name, data = chunk
                event = _parse_chunk(mode_name, data, ts)
            else:
                # Single mode — chunk IS the data
                event = _parse_chunk(lg_modes[0], chunk, ts)

            yield event

            # Bridge to EventBus (fire-and-forget, must not crash iteration)
            if event_bus is not None:
                try:
                    from openseed_core.events import EventType  # lazy import

                    await event_bus.emit_simple(
                        EventType.PIPELINE_STREAM,
                        node=event.node,
                        mode=event.mode.value,
                        data=event.data,
                    )
                except Exception:
                    pass  # EventBus errors must not interrupt streaming

    except Exception as exc:
        yield StreamEvent(
            mode=PipelineStreamMode.TASKS,
            node="pipeline",
            data={"error": str(exc), "type": "pipeline_error"},
            timestamp_ms=int(time.time() * 1000),
        )


# ---------------------------------------------------------------------------
# High-level convenience runner
# ---------------------------------------------------------------------------


async def run_pipeline_streaming(
    task: str,
    working_dir: str,
    provider: str = "claude",
    checkpoint_dir: str | None = None,
    thread_id: str = "default",
    mode: PipelineStreamMode | list[PipelineStreamMode] = PipelineStreamMode.UPDATES,
    event_bus: Any = None,
) -> AsyncIterator[StreamEvent]:
    """Compile the graph and stream pipeline execution.

    This is the primary entry point for the CLI and API server.
    It compiles a fresh graph (with optional checkpointing), builds the
    initial state, then delegates to `stream_pipeline`.

    Args:
        task: Natural-language task description.
        working_dir: Absolute path to the project directory.
        provider: LLM provider — "claude" or "openai".
        checkpoint_dir: Directory for SQLite checkpointer. Pass `None` to
            disable crash-recovery (useful in tests).
        thread_id: Checkpointer thread ID. Use a stable ID to resume a
            previous run.
        mode: Streaming mode(s). Defaults to `UPDATES` (lightweight).
        event_bus: Optional `EventBus` for real-time UI bridging.

    Yields:
        `StreamEvent` objects — same as `stream_pipeline`.

    Example::

        async for event in run_pipeline_streaming(
            task="Add dark-mode toggle",
            working_dir="/home/user/myapp",
            mode=PipelineStreamMode.UPDATES,
        ):
            print(f"[{event.node}] {event.data}")
    """
    from openseed_brain.graph import compile_graph
    from openseed_brain.state import initial_state

    graph = compile_graph(checkpoint_dir=checkpoint_dir)
    state = initial_state(task=task, working_dir=working_dir, provider=provider)

    async for event in stream_pipeline(
        graph,
        state,
        thread_id=thread_id,
        mode=mode,
        event_bus=event_bus,
    ):
        yield event


# ---------------------------------------------------------------------------
# Internal chunk parser
# ---------------------------------------------------------------------------


def _parse_chunk(mode_name: str, chunk: Any, ts: int) -> StreamEvent:
    """Convert a raw LangGraph stream chunk to a `StreamEvent`.

    LangGraph chunk shapes by mode:
    - "updates"  → ``{node_name: {key: value, ...}, ...}``
    - "values"   → full state dict (same shape as PipelineState)
    - "messages" → ``(message_chunk, metadata)`` tuple
    - "tasks"    → ``PregelTask`` namedtuple / dict with name + state
    - "custom"   → arbitrary value emitted by StreamWriter inside a node
    - others     → passed through as ``{"raw": str(chunk)}``

    When a chunk contains multiple nodes (possible in "updates"), only the
    first key is used for `event.node`; callers that need all nodes should
    use "tasks" mode or inspect `data` directly.
    """
    # Resolve PipelineStreamMode safely — unknown modes fall back to UPDATES
    try:
        resolved_mode = PipelineStreamMode(mode_name)
    except ValueError:
        resolved_mode = PipelineStreamMode.UPDATES

    if mode_name == "updates":
        if isinstance(chunk, dict) and chunk:
            # Pick the first (and almost always only) node name
            node_name = next(iter(chunk))
            update = chunk[node_name]
            return StreamEvent(
                mode=PipelineStreamMode.UPDATES,
                node=node_name,
                data=update if isinstance(update, dict) else {"value": update},
                timestamp_ms=ts,
            )
        return StreamEvent(
            mode=PipelineStreamMode.UPDATES,
            data={"raw": str(chunk)},
            timestamp_ms=ts,
        )

    if mode_name == "values":
        return StreamEvent(
            mode=PipelineStreamMode.VALUES,
            node="snapshot",
            data=chunk if isinstance(chunk, dict) else {"value": chunk},
            timestamp_ms=ts,
        )

    if mode_name == "messages":
        # LangGraph emits (AIMessageChunk | ToolMessage, metadata_dict)
        if isinstance(chunk, tuple) and len(chunk) == 2:
            msg_chunk, metadata = chunk
            content = getattr(msg_chunk, "content", "")
            node_name: str = metadata.get("langgraph_node", "") if isinstance(metadata, dict) else ""
            return StreamEvent(
                mode=PipelineStreamMode.MESSAGES,
                node=node_name,
                data={
                    "content": content,
                    "type": type(msg_chunk).__name__,
                    "metadata": metadata if isinstance(metadata, dict) else {},
                },
                timestamp_ms=ts,
            )
        # Fallback: bare message object
        content = getattr(chunk, "content", str(chunk))
        return StreamEvent(
            mode=PipelineStreamMode.MESSAGES,
            data={"content": content},
            timestamp_ms=ts,
        )

    if mode_name == "tasks":
        # PregelTask has .name, .error, .state (or similar attrs); also may be dict
        if isinstance(chunk, dict):
            return StreamEvent(
                mode=PipelineStreamMode.TASKS,
                node=chunk.get("name", chunk.get("id", "")),
                data=chunk,
                timestamp_ms=ts,
            )
        node_name = getattr(chunk, "name", getattr(chunk, "id", ""))
        return StreamEvent(
            mode=PipelineStreamMode.TASKS,
            node=str(node_name),
            data={"raw": str(chunk)},
            timestamp_ms=ts,
        )

    if mode_name == "custom":
        if isinstance(chunk, dict):
            return StreamEvent(
                mode=PipelineStreamMode.CUSTOM,
                node=chunk.get("node", ""),
                data=chunk,
                timestamp_ms=ts,
            )
        return StreamEvent(
            mode=PipelineStreamMode.CUSTOM,
            data={"value": chunk},
            timestamp_ms=ts,
        )

    # Catch-all for "checkpoints", "debug", or any future LangGraph modes
    return StreamEvent(
        mode=resolved_mode,
        data={"raw": str(chunk)},
        timestamp_ms=ts,
    )
