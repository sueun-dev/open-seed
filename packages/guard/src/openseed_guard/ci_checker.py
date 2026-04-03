"""
Open Seed v2 — GitHub CI failure checker.

Inspects GitHub Actions checks on a PR, extracts failure logs,
and returns structured failure summaries for the fix pipeline.

Pattern from: OpenAI skills/gh-fix-ci/inspect_pr_checks.py
Uses gh CLI (OAuth) — no API keys.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from openseed_core.subprocess import run_simple

# ─── Constants ───────────────────────────────────────────────────────────────

FAILURE_CONCLUSIONS = {"failure", "cancelled", "timed_out", "action_required"}
FAILURE_STATES = {"failure", "error", "cancelled", "timed_out", "action_required"}
FAILURE_BUCKETS = {"fail"}

FAILURE_MARKERS = (
    "error",
    "fail",
    "failed",
    "traceback",
    "exception",
    "assert",
    "panic",
    "fatal",
    "timeout",
    "segmentation fault",
)

MAX_SNIPPET_LINES = 160
CONTEXT_LINES = 30


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class CIFailure:
    """A single failing CI check with extracted log snippet."""

    check_name: str
    run_url: str = ""
    conclusion: str = ""
    log_snippet: str = ""
    log_state: str = "ok"  # ok, log_pending, log_unavailable, external


@dataclass
class CICheckResult:
    """Result of inspecting CI checks on a PR."""

    pr_number: int = 0
    total_checks: int = 0
    failures: list[CIFailure] = field(default_factory=list)
    all_passed: bool = False


# ─── Public API ──────────────────────────────────────────────────────────────


async def check_pr_ci(
    working_dir: str,
    pr_number: int | None = None,
) -> CICheckResult:
    """
    Inspect CI checks for a PR and return structured failure info.

    If pr_number is None, uses the current branch's PR.

    Args:
        working_dir: Git repository root.
        pr_number: PR number (auto-detects from current branch if None).

    Returns:
        CICheckResult with failures list and pass/fail status.
    """
    # Verify gh CLI
    gh_check = await run_simple(["gh", "auth", "status"], timeout_seconds=5)
    if gh_check.exit_code != 0:
        return CICheckResult()

    # Resolve PR number
    if pr_number is None:
        pr_view = await run_simple(
            ["gh", "pr", "view", "--json", "number"],
            cwd=working_dir,
            timeout_seconds=10,
        )
        if pr_view.exit_code != 0:
            return CICheckResult()
        try:
            pr_number = json.loads(pr_view.stdout).get("number", 0)
        except (json.JSONDecodeError, TypeError):
            return CICheckResult()

    if not pr_number:
        return CICheckResult()

    # Get all checks
    checks_result = await run_simple(
        ["gh", "pr", "checks", str(pr_number), "--json", "name,state,bucket,link,completedAt,workflow"],
        cwd=working_dir,
        timeout_seconds=15,
    )

    if checks_result.exit_code != 0:
        return CICheckResult(pr_number=pr_number)

    try:
        checks = json.loads(checks_result.stdout)
    except (json.JSONDecodeError, TypeError):
        return CICheckResult(pr_number=pr_number)

    if not isinstance(checks, list):
        return CICheckResult(pr_number=pr_number)

    # Find failures
    failures: list[CIFailure] = []
    for check in checks:
        if not _is_failing(check):
            continue

        name = check.get("name", "unknown")
        link = check.get("link", "")
        conclusion = check.get("state", check.get("bucket", ""))

        failure = CIFailure(
            check_name=name,
            run_url=link,
            conclusion=conclusion,
        )

        # Try to extract logs for GitHub Actions runs
        if "github.com" in link and "/actions/" in link:
            run_id = _extract_run_id(link)
            if run_id:
                failure.log_snippet = await _fetch_log_snippet(
                    working_dir,
                    run_id,
                )
                failure.log_state = "ok" if failure.log_snippet else "log_unavailable"
        else:
            failure.log_state = "external"

        failures.append(failure)

    return CICheckResult(
        pr_number=pr_number,
        total_checks=len(checks),
        failures=failures,
        all_passed=len(failures) == 0,
    )


# ─── Private helpers ─────────────────────────────────────────────────────────


def _is_failing(check: dict[str, Any]) -> bool:
    """Determine if a check is in a failure state."""
    conclusion = str(check.get("conclusion", "")).lower()
    state = str(check.get("state", "")).lower()
    bucket = str(check.get("bucket", "")).lower()

    return conclusion in FAILURE_CONCLUSIONS or state in FAILURE_STATES or bucket in FAILURE_BUCKETS


def _extract_run_id(url: str) -> str | None:
    """Extract GitHub Actions run ID from a URL."""
    # Pattern: /actions/runs/12345678
    match = re.search(r"/actions/runs/(\d+)", url)
    if match:
        return match.group(1)
    # Pattern: /actions/runs/12345678/job/87654321
    match = re.search(r"/runs/(\d+)", url)
    return match.group(1) if match else None


async def _fetch_log_snippet(
    working_dir: str,
    run_id: str,
) -> str:
    """Fetch and extract failure snippet from a GitHub Actions run log."""
    result = await run_simple(
        ["gh", "run", "view", run_id, "--log"],
        cwd=working_dir,
        timeout_seconds=30,
    )

    if result.exit_code != 0:
        return ""

    return _extract_failure_snippet(result.stdout)


def _extract_failure_snippet(log: str) -> str:
    """Extract the most relevant failure snippet from a log."""
    lines = log.splitlines()
    if not lines:
        return ""

    # Find lines containing failure markers
    marker_indices: list[int] = []
    for i, line in enumerate(lines):
        lower = line.lower()
        if any(m in lower for m in FAILURE_MARKERS):
            marker_indices.append(i)

    if not marker_indices:
        # No markers found — return last N lines
        return "\n".join(lines[-CONTEXT_LINES:])

    # Take context around the last cluster of markers
    last_marker = marker_indices[-1]
    start = max(0, last_marker - CONTEXT_LINES)
    end = min(len(lines), last_marker + CONTEXT_LINES)
    snippet_lines = lines[start:end]

    # Cap at MAX_SNIPPET_LINES
    if len(snippet_lines) > MAX_SNIPPET_LINES:
        snippet_lines = snippet_lines[-MAX_SNIPPET_LINES:]

    return "\n".join(snippet_lines)


def format_ci_failures_for_prompt(result: CICheckResult) -> str:
    """Format CI failures into a string for injection into fix prompts."""
    if result.all_passed or not result.failures:
        return ""

    parts = [
        f"GitHub CI failures on PR #{result.pr_number} ({len(result.failures)}/{result.total_checks} checks failed):"
    ]

    for f in result.failures:
        parts.append(f"\n--- {f.check_name} ({f.conclusion}) ---")
        if f.run_url:
            parts.append(f"URL: {f.run_url}")
        if f.log_state == "external":
            parts.append("(External CI — logs not available via GitHub)")
        elif f.log_state == "log_pending":
            parts.append("(Logs still pending — run in progress)")
        elif f.log_state == "log_unavailable":
            parts.append("(Logs unavailable)")
        elif f.log_snippet:
            parts.append(f"Log snippet:\n{f.log_snippet[:2000]}")

    return "\n".join(parts)
