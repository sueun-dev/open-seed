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


async def auto_detect_test_commands(working_dir: str) -> list[str]:
    """Auto-detect which test commands to run based on project files."""
    commands = []

    pkg_json = os.path.join(working_dir, "package.json")
    if os.path.exists(pkg_json):
        try:
            import json
            data = json.loads(open(pkg_json).read())
            scripts = data.get("scripts", {})
            if "test" in scripts and scripts["test"] != 'echo "Error: no test specified" && exit 1':
                commands.append("npm test")
            if "build" in scripts:
                commands.append("npm run build")
            # Always check npm install works
            if "dependencies" in data or "devDependencies" in data:
                if not os.path.exists(os.path.join(working_dir, "node_modules")):
                    commands.insert(0, "npm install")
        except Exception:
            pass

    if os.path.exists(os.path.join(working_dir, "pyproject.toml")) or os.path.exists(os.path.join(working_dir, "setup.py")):
        if os.path.exists(os.path.join(working_dir, "tests")) or os.path.exists(os.path.join(working_dir, "test")):
            commands.append("python -m pytest --tb=short -q")

    if os.path.exists(os.path.join(working_dir, "Makefile")):
        commands.append("make test 2>/dev/null || true")

    # Basic syntax check for single-file projects
    for f in os.listdir(working_dir):
        if f.endswith(".py") and not f.startswith("test_"):
            commands.append(f"python -c \"import ast; ast.parse(open('{f}').read()); print('{f}: syntax OK')\"")
            break
        if f == "index.html":
            commands.append("ls -la index.html")
            break

    return commands


async def verify_implementation(
    working_dir: str,
    expected_files: list[str] | None = None,
    test_commands: list[str] | None = None,
) -> VerificationResult:
    """
    Full verification: check files exist + auto-detect + run test commands.

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

    # Auto-detect test commands if none provided
    if not test_commands:
        test_commands = await auto_detect_test_commands(working_dir)

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
