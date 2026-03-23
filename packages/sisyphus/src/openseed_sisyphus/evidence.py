"""
Open Seed v2 — Evidence-based verification.

Don't trust agent claims of "done". Read actual files and run actual commands.
Pattern from: OmO atlas/verification-reminders.ts completion gate
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from openseed_core.subprocess import run_simple


@dataclass
class Evidence:
    """Concrete evidence that something is done/working."""
    check: str
    passed: bool
    detail: str = ""


@dataclass
class VerificationResult:
    """Result of verifying implementation against claims."""
    all_passed: bool
    evidence: list[Evidence] = field(default_factory=list)
    missing_files: list[str] = field(default_factory=list)
    failing_commands: list[str] = field(default_factory=list)


async def verify_files_exist(
    working_dir: str,
    expected_files: list[str],
) -> list[Evidence]:
    """Verify that expected files actually exist on disk."""
    evidence = []
    for f in expected_files:
        full_path = os.path.join(working_dir, f)
        exists = os.path.isfile(full_path)
        evidence.append(Evidence(
            check=f"file exists: {f}",
            passed=exists,
            detail=f"Found at {full_path}" if exists else f"MISSING: {full_path}",
        ))
    return evidence


async def verify_command(
    command: str,
    working_dir: str,
    expected_exit_code: int = 0,
) -> Evidence:
    """Run a command and verify it succeeds."""
    result = await run_simple(
        ["bash", "-c", command],
        cwd=working_dir,
        timeout_seconds=60,
    )
    passed = result.exit_code == expected_exit_code
    return Evidence(
        check=f"command: {command}",
        passed=passed,
        detail=f"exit={result.exit_code}" + (f" stderr={result.stderr[:200]}" if not passed else ""),
    )


async def verify_implementation(
    working_dir: str,
    expected_files: list[str] | None = None,
    test_commands: list[str] | None = None,
) -> VerificationResult:
    """
    Full verification: check files exist + run test commands.

    This is the evidence gate — the Sisyphus loop only advances
    if ALL evidence checks pass.
    """
    evidence: list[Evidence] = []
    missing: list[str] = []
    failing: list[str] = []

    # Verify files
    if expected_files:
        file_evidence = await verify_files_exist(working_dir, expected_files)
        evidence.extend(file_evidence)
        missing = [e.check.replace("file exists: ", "") for e in file_evidence if not e.passed]

    # Run test commands
    for cmd in (test_commands or []):
        cmd_evidence = await verify_command(cmd, working_dir)
        evidence.extend([cmd_evidence])
        if not cmd_evidence.passed:
            failing.append(cmd)

    all_passed = all(e.passed for e in evidence) if evidence else False

    return VerificationResult(
        all_passed=all_passed,
        evidence=evidence,
        missing_files=missing,
        failing_commands=failing,
    )
