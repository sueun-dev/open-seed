"""
Open Seed v2 — Exponential backoff for Sisyphus retries.

Pattern from: OmO todo-continuation-enforcer idle-event.ts
  cooldown = BASE * 2^min(failures, CAP)

Also inspired by: LangGraph RetryPolicy
"""

from __future__ import annotations


def compute_backoff_ms(
    consecutive_failures: int,
    base_ms: int = 5_000,
    cap_exponent: int = 5,
    max_ms: int = 160_000,
) -> int:
    """
    Compute exponential backoff delay in milliseconds.

    Args:
        consecutive_failures: Number of consecutive failures
        base_ms: Base delay (default 5s)
        cap_exponent: Max exponent (default 5 → max 2^5 = 32x)
        max_ms: Absolute maximum delay

    Returns:
        Delay in milliseconds

    Examples:
        0 failures → 5,000ms (5s)
        1 failure  → 10,000ms (10s)
        2 failures → 20,000ms (20s)
        3 failures → 40,000ms (40s)
        4 failures → 80,000ms (80s)
        5 failures → 160,000ms (160s) — capped
    """
    exponent = min(consecutive_failures, cap_exponent)
    delay = base_ms * (2 ** exponent)
    return min(delay, max_ms)


def should_retry(
    consecutive_failures: int,
    max_retries: int = 10,
) -> bool:
    """Check if we should retry based on failure count."""
    return consecutive_failures < max_retries
