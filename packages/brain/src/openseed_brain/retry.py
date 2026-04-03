"""
Node-level retry with exponential backoff.

Uses LangGraph's native RetryPolicy (NamedTuple with initial_interval,
backoff_factor, max_interval, max_attempts, jitter, retry_on) from
langgraph.types — available since LangGraph 0.2.24.

For nodes that need custom wrap-and-retry logic outside of LangGraph's
built-in add_node(retry_policy=...) mechanism, with_retry() provides
an async decorator.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Callable
from typing import Any, TypeVar

try:
    from langgraph.types import RetryPolicy
except ImportError:
    # Fallback if somehow running an older version — unlikely given version check
    from dataclasses import dataclass, field

    @dataclass
    class RetryPolicy:  # type: ignore[no-redef]
        max_attempts: int = 3
        initial_interval: float = 0.5
        backoff_factor: float = 2.0
        max_interval: float = 128.0
        jitter: bool = True
        retry_on: tuple[type[Exception], ...] = field(default_factory=lambda: (Exception,))


# Pre-built policies for common node types
IMPLEMENT_RETRY = RetryPolicy(max_attempts=3, initial_interval=2.0, backoff_factor=2.0)
QA_RETRY = RetryPolicy(max_attempts=2, initial_interval=1.0, backoff_factor=2.0)
DEPLOY_RETRY = RetryPolicy(max_attempts=2, initial_interval=3.0, backoff_factor=2.0)

F = TypeVar("F", bound=Callable[..., Any])


def with_retry(node_fn: F, policy: RetryPolicy) -> F:
    """
    Wrap an async node function with retry logic matching the given policy.

    This is an escape hatch for cases where you need retry logic that LangGraph's
    native add_node(retry_policy=...) cannot handle (e.g. partial retries of
    sub-steps within a node). For normal use, pass retry_policy= to add_node().

    Args:
        node_fn: An async function accepting (state) and returning a dict.
        policy: RetryPolicy controlling backoff behaviour.

    Returns:
        Wrapped async function with the same signature.
    """
    max_attempts = policy.max_attempts
    initial_interval = policy.initial_interval
    backoff_factor = policy.backoff_factor
    max_interval = policy.max_interval
    jitter = policy.jitter

    # Determine which exceptions trigger a retry
    retry_on: tuple[type[Exception], ...]
    if callable(policy.retry_on) and not isinstance(policy.retry_on, tuple):
        # LangGraph uses a predicate function; treat any exception as retryable
        retry_on = (Exception,)
    else:
        retry_on = policy.retry_on  # type: ignore[assignment]

    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        last_exc: Exception | None = None
        interval = initial_interval

        for attempt in range(1, max_attempts + 1):
            try:
                return await node_fn(*args, **kwargs)
            except retry_on as exc:  # type: ignore[misc]
                last_exc = exc
                if attempt == max_attempts:
                    break
                sleep_time = min(interval, max_interval)
                if jitter:
                    sleep_time *= 0.5 + random.random() * 0.5
                await asyncio.sleep(sleep_time)
                interval *= backoff_factor

        raise last_exc  # type: ignore[misc]

    return wrapper  # type: ignore[return-value]


__all__ = [
    "RetryPolicy",
    "IMPLEMENT_RETRY",
    "QA_RETRY",
    "DEPLOY_RETRY",
    "with_retry",
]
