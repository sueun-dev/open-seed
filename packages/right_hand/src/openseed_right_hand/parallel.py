"""
Open Seed v2 — Parallel code generation with multiple Codex agents.

Pattern from: codex-rs multi_agents/spawn.rs + parallel.rs
Spawn multiple Codex agents with disjoint file scopes, run in parallel.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from openseed_core.config import CodexConfig
from openseed_core.events import EventBus
from openseed_right_hand.agent import CodexAgent, CodexResponse


@dataclass
class ParallelTask:
    """A single task for parallel execution."""
    prompt: str
    role: str = "implementer"
    files: list[str] = field(default_factory=list)  # Disjoint file scope


@dataclass
class ParallelResult:
    """Aggregated result from parallel Codex agents."""
    responses: list[CodexResponse] = field(default_factory=list)
    total_files_created: list[str] = field(default_factory=list)
    total_files_modified: list[str] = field(default_factory=list)
    all_succeeded: bool = True


async def run_parallel(
    tasks: list[ParallelTask],
    working_dir: str,
    config: CodexConfig | None = None,
    event_bus: EventBus | None = None,
    max_concurrent: int = 3,
) -> ParallelResult:
    """
    Run multiple Codex agents in parallel with bounded concurrency.

    Each task gets its own Codex agent instance.
    File scopes should be disjoint to prevent conflicts.

    Args:
        tasks: List of parallel tasks
        working_dir: Shared working directory
        config: Codex configuration
        event_bus: Event streaming
        max_concurrent: Max agents running simultaneously

    Returns:
        Aggregated ParallelResult
    """
    semaphore = asyncio.Semaphore(max_concurrent)
    responses: list[CodexResponse] = []

    async def run_one(task: ParallelTask) -> CodexResponse:
        async with semaphore:
            agent = CodexAgent(config=config, event_bus=event_bus)
            # Augment prompt with file scope hint
            scoped_prompt = task.prompt
            if task.files:
                scoped_prompt += f"\n\nYour file scope (only modify these): {', '.join(task.files)}"
            return await agent.invoke(scoped_prompt, working_dir=working_dir)

    # Run all tasks concurrently
    results = await asyncio.gather(
        *[run_one(task) for task in tasks],
        return_exceptions=True,
    )

    all_created: list[str] = []
    all_modified: list[str] = []
    all_succeeded = True

    for r in results:
        if isinstance(r, Exception):
            all_succeeded = False
            responses.append(CodexResponse(text=str(r), exit_code=1))
        else:
            responses.append(r)
            all_created.extend(r.files_created)
            all_modified.extend(r.files_modified)
            if r.exit_code != 0:
                all_succeeded = False

    return ParallelResult(
        responses=responses,
        total_files_created=all_created,
        total_files_modified=all_modified,
        all_succeeded=all_succeeded,
    )
