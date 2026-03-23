"""
Open Seed v2 — Stagnation detection.

Detects when the Sisyphus loop is spinning without making real progress.
After N cycles of no change → escalate.

Pattern from: OmO constants.ts MAX_STAGNATION_COUNT = 3
"""

from __future__ import annotations

from openseed_sisyphus.progress import ProgressUpdate


def is_stagnated(update: ProgressUpdate, threshold: int = 3) -> bool:
    """
    Check if the loop has stagnated.

    Stagnation = N consecutive cycles with no measurable progress.
    """
    return update.stagnation_count >= threshold


def stagnation_message(update: ProgressUpdate, threshold: int = 3) -> str:
    """Human-readable stagnation status."""
    if is_stagnated(update, threshold):
        return f"STAGNATED: {update.stagnation_count} cycles with no progress (threshold: {threshold})"
    if update.stagnation_count > 0:
        return f"Warning: {update.stagnation_count}/{threshold} cycles without progress"
    return "Making progress"
