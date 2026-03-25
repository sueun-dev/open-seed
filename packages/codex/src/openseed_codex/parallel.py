"""
Open Seed v2 — Parallel code generation with workspace isolation.

Each parallel Codex agent gets its own git worktree to prevent conflicts.
After completion, changes are merged back.

Pattern from: codex-rs multi_agents/spawn.rs + parallel.rs
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import uuid
from dataclasses import dataclass, field

from openseed_core.config import CodexConfig
from openseed_core.events import EventBus
from openseed_codex.agent import CodexAgent, CodexResponse


@dataclass
class ParallelTask:
    """A single task for parallel execution."""
    prompt: str
    role: str = "implementer"
    files: list[str] = field(default_factory=list)


@dataclass
class ParallelResult:
    """Aggregated result from parallel Codex agents."""
    responses: list[CodexResponse] = field(default_factory=list)
    total_files_created: list[str] = field(default_factory=list)
    total_files_modified: list[str] = field(default_factory=list)
    all_succeeded: bool = True


def _create_worktree(working_dir: str, task_id: str) -> str | None:
    """Create a git worktree for isolated parallel execution."""
    worktree_path = os.path.join("/tmp", f"openseed-wt-{task_id}")
    try:
        # Ensure working_dir is a git repo
        if not os.path.isdir(os.path.join(working_dir, ".git")):
            subprocess.run(["git", "init"], cwd=working_dir, capture_output=True)
            subprocess.run(["git", "add", "-A"], cwd=working_dir, capture_output=True)
            subprocess.run(
                ["git", "commit", "--allow-empty", "-m", "init"],
                cwd=working_dir, capture_output=True,
                env={**os.environ, "GIT_AUTHOR_NAME": "openseed", "GIT_AUTHOR_EMAIL": "a@b",
                     "GIT_COMMITTER_NAME": "openseed", "GIT_COMMITTER_EMAIL": "a@b"},
            )

        result = subprocess.run(
            ["git", "worktree", "add", worktree_path, "HEAD"],
            cwd=working_dir, capture_output=True, text=True,
        )
        if result.returncode == 0:
            return worktree_path
    except Exception:
        pass
    return None


def _remove_worktree(working_dir: str, worktree_path: str) -> None:
    """Remove a git worktree."""
    try:
        subprocess.run(["git", "worktree", "remove", worktree_path, "--force"],
                        cwd=working_dir, capture_output=True)
    except Exception:
        pass


def _merge_worktree(working_dir: str, worktree_path: str) -> bool:
    """Merge worktree changes back into main working dir."""
    try:
        # Get the worktree branch name
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=worktree_path, capture_output=True, text=True,
        )
        if result.returncode != 0:
            return False

        # Copy changed files back (simple approach: rsync non-git files)
        for root, dirs, files in os.walk(worktree_path):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
            for f in files:
                src = os.path.join(root, f)
                rel = os.path.relpath(src, worktree_path)
                dst = os.path.join(working_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                import shutil
                shutil.copy2(src, dst)
        return True
    except Exception:
        return False


async def run_parallel(
    tasks: list[ParallelTask],
    working_dir: str,
    config: CodexConfig | None = None,
    event_bus: EventBus | None = None,
    max_concurrent: int = 3,
    use_worktrees: bool = True,
) -> ParallelResult:
    """
    Run multiple Codex agents in parallel with workspace isolation.

    Each task gets its own git worktree. Changes are merged back after completion.
    """
    semaphore = asyncio.Semaphore(max_concurrent)
    responses: list[CodexResponse] = []

    async def run_one(task: ParallelTask) -> CodexResponse:
        async with semaphore:
            task_id = uuid.uuid4().hex[:8]
            agent = CodexAgent(config=config, event_bus=event_bus)

            # Create isolated worktree
            wt_path = _create_worktree(working_dir, task_id) if use_worktrees else None
            exec_dir = wt_path or working_dir

            try:
                scoped_prompt = task.prompt
                if task.files:
                    scoped_prompt += f"\n\nYour file scope (only modify these): {', '.join(task.files)}"
                if task.role != "implementer":
                    scoped_prompt += f"\n\nYour role: {task.role}"

                result = await agent.invoke(scoped_prompt, working_dir=exec_dir)

                # Merge worktree back
                if wt_path:
                    _merge_worktree(working_dir, wt_path)

                return result
            finally:
                if wt_path:
                    _remove_worktree(working_dir, wt_path)

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
