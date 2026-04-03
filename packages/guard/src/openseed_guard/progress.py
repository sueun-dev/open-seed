"""
Open Seed v2 — Progress tracking for Sentinel loop.

Tracks TODO completion, file changes, and test results to determine
if real progress is being made vs spinning in place.

Compares snapshots over time to detect stagnation vs real progress.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ProgressSnapshot:
    """A point-in-time snapshot of pipeline progress."""

    incomplete_count: int = 0
    completed_count: int = 0
    files_created: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    error_count: int = 0
    test_pass_count: int = 0
    test_fail_count: int = 0
    raw_hash: str = ""  # Hash of full state for change detection


@dataclass
class ProgressUpdate:
    """Result of comparing two progress snapshots."""

    has_progressed: bool
    progress_source: str = "none"  # "todo", "files", "tests", "none"
    stagnation_count: int = 0


class ProgressTracker:
    """
    Tracks progress across Sentinel retry cycles.

    Key insight: only count as "progress" if the snapshot
    actually changed, not just because the agent claimed to be done.
    """

    def __init__(self) -> None:
        self._previous: ProgressSnapshot | None = None
        self._stagnation_count: int = 0

    def track(self, current: ProgressSnapshot) -> ProgressUpdate:
        """
        Compare current snapshot with previous to detect progress.

        Returns:
            ProgressUpdate with has_progressed flag and stagnation count
        """
        if self._previous is None:
            self._previous = current
            self._stagnation_count = 0
            return ProgressUpdate(has_progressed=False, progress_source="baseline")

        # Check each progress dimension
        source = "none"

        # More tasks completed?
        if (
            current.completed_count > self._previous.completed_count
            or current.incomplete_count < self._previous.incomplete_count
        ):
            source = "todo"
        # New files created?
        elif len(current.files_created) > len(self._previous.files_created):
            source = "files"
        # More tests passing?
        elif current.test_pass_count > self._previous.test_pass_count:
            source = "tests"
        # Fewer errors?
        elif current.error_count < self._previous.error_count:
            source = "errors"
        # State hash changed?
        elif current.raw_hash != self._previous.raw_hash and current.raw_hash:
            source = "state"

        has_progressed = source != "none"

        if has_progressed:
            self._stagnation_count = 0
        else:
            self._stagnation_count += 1

        self._previous = current

        return ProgressUpdate(
            has_progressed=has_progressed,
            progress_source=source,
            stagnation_count=self._stagnation_count,
        )

    @property
    def stagnation_count(self) -> int:
        return self._stagnation_count

    def reset(self) -> None:
        self._previous = None
        self._stagnation_count = 0
