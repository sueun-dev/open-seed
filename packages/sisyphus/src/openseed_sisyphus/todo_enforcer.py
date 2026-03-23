"""
Open Seed v2 — TODO enforcer.

Tracks plan tasks as TODOs. Detects when tasks stall.
Forces continuation when incomplete TODOs remain.

Pattern from: OmO todo-continuation-enforcer/session-state.ts
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class TodoItem:
    """A tracked TODO item from the plan."""
    id: str
    description: str
    status: str = "pending"  # pending, in_progress, completed, failed
    files: list[str] = field(default_factory=list)
    started_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass
class TodoSnapshot:
    """Point-in-time snapshot of TODO state."""
    total: int = 0
    pending: int = 0
    in_progress: int = 0
    completed: int = 0
    failed: int = 0


class TodoEnforcer:
    """
    Tracks plan tasks as TODOs and detects stalls.

    Key insight from OmO: Only count as "progress" if the TODO snapshot
    actually changed — not just because the agent claimed progress.
    """

    def __init__(self) -> None:
        self._todos: list[TodoItem] = []
        self._snapshots: list[TodoSnapshot] = []
        self._stagnation_count: int = 0
        self._consecutive_failures: int = 0

    def load_from_plan(self, tasks: list[dict[str, Any]]) -> None:
        """Initialize TODOs from plan tasks."""
        self._todos = [
            TodoItem(
                id=t.get("id", f"T{i}"),
                description=t.get("description", ""),
                files=t.get("files", []),
            )
            for i, t in enumerate(tasks)
        ]

    def mark_in_progress(self, todo_id: str) -> None:
        for t in self._todos:
            if t.id == todo_id:
                t.status = "in_progress"
                t.started_at = datetime.now()

    def mark_completed(self, todo_id: str) -> None:
        for t in self._todos:
            if t.id == todo_id:
                t.status = "completed"
                t.completed_at = datetime.now()

    def mark_failed(self, todo_id: str) -> None:
        for t in self._todos:
            if t.id == todo_id:
                t.status = "failed"

    def take_snapshot(self) -> TodoSnapshot:
        """Take a snapshot and detect stagnation."""
        snap = TodoSnapshot(
            total=len(self._todos),
            pending=sum(1 for t in self._todos if t.status == "pending"),
            in_progress=sum(1 for t in self._todos if t.status == "in_progress"),
            completed=sum(1 for t in self._todos if t.status == "completed"),
            failed=sum(1 for t in self._todos if t.status == "failed"),
        )

        # Compare with previous snapshot
        if self._snapshots:
            prev = self._snapshots[-1]
            if snap.completed == prev.completed and snap.failed == prev.failed:
                self._stagnation_count += 1
            else:
                self._stagnation_count = 0

        self._snapshots.append(snap)
        return snap

    @property
    def is_stagnated(self) -> bool:
        return self._stagnation_count >= 3

    @property
    def incomplete_count(self) -> int:
        return sum(1 for t in self._todos if t.status in ("pending", "in_progress"))

    @property
    def all_completed(self) -> bool:
        return all(t.status == "completed" for t in self._todos) if self._todos else False

    def build_continuation_prompt(self) -> str:
        """Build a prompt to continue incomplete work."""
        incomplete = [t for t in self._todos if t.status in ("pending", "in_progress")]
        if not incomplete:
            return ""
        lines = [f"You have {len(incomplete)} incomplete TODOs. Continue working:"]
        for t in incomplete:
            lines.append(f"- [{t.status}] {t.id}: {t.description}")
            if t.files:
                lines.append(f"  Files: {', '.join(t.files)}")
        return "\n".join(lines)

    def build_strategy_switch_prompt(self, attempt: int) -> str:
        """When stagnated, suggest a completely different approach."""
        failed = [t for t in self._todos if t.status == "failed"]
        return f"""STRATEGY SWITCH REQUIRED (attempt #{attempt}).

Previous approaches have stagnated. You MUST try a COMPLETELY DIFFERENT strategy.
Do NOT repeat what you already tried.

Failed tasks:
{chr(10).join(f'- {t.id}: {t.description}' for t in failed)}

Think of an alternative approach. Maybe:
- Different library/framework
- Simpler architecture
- Different file structure
- Fewer features (MVP first)
"""
