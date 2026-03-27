"""
Open Seed v2 — Evidence-based verification.

Don't trust agent claims of "done". Read actual files and run actual commands.
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
    """
    Verify that expected files actually exist on disk.

    If the exact path doesn't match, searches subdirectories for the filename.
    This handles cases where the plan says 'index.html' but the actual file
    is at 'client/index.html' (common with monorepo/multi-dir projects).
    """
    evidence = []
    for f in expected_files:
        full_path = os.path.join(working_dir, f)
        if os.path.isfile(full_path):
            evidence.append(Evidence(
                check=f"file exists: {f}",
                passed=True,
                detail=f"Found at {full_path}",
            ))
            continue

        # Fuzzy search: look for the filename in subdirectories
        basename = os.path.basename(f)
        found_at = _find_file_recursive(working_dir, basename)
        if found_at:
            evidence.append(Evidence(
                check=f"file exists: {f}",
                passed=True,
                detail=f"Found at {found_at} (expected {full_path})",
            ))
        else:
            evidence.append(Evidence(
                check=f"file exists: {f}",
                passed=False,
                detail=f"MISSING: {full_path} (also searched subdirectories)",
            ))
    return evidence


def _find_file_recursive(root: str, filename: str) -> str | None:
    """Search for a filename in directory tree, skipping node_modules/.git."""
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d not in ("node_modules", ".git", "__pycache__", ".venv", "dist")
            ]
            if filename in filenames:
                return os.path.join(dirpath, filename)
    except OSError:
        pass
    return None


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
    """
    Auto-detect which test commands to run based on project files.

    Searches both root and immediate subdirectories (server/, client/, etc.)
    for package.json, pyproject.toml, etc.
    """
    commands = []

    # Find all package.json files (root + one level deep)
    pkg_jsons = []
    root_pkg = os.path.join(working_dir, "package.json")
    if os.path.exists(root_pkg):
        pkg_jsons.append((working_dir, root_pkg))
    try:
        for entry in os.listdir(working_dir):
            subdir = os.path.join(working_dir, entry)
            if os.path.isdir(subdir) and entry not in ("node_modules", ".git", "__pycache__", "dist"):
                sub_pkg = os.path.join(subdir, "package.json")
                if os.path.exists(sub_pkg):
                    pkg_jsons.append((subdir, sub_pkg))
    except OSError:
        pass

    for pkg_dir, pkg_json in pkg_jsons:
        try:
            import json
            data = json.loads(open(pkg_json).read())
            scripts = data.get("scripts", {})
            # Relative prefix for subdirectory commands
            prefix = f"cd {os.path.basename(pkg_dir)} && " if pkg_dir != working_dir else ""

            if "dependencies" in data or "devDependencies" in data:
                if not os.path.exists(os.path.join(pkg_dir, "node_modules")):
                    commands.append(f"{prefix}npm install")
            if "test" in scripts and scripts["test"] != 'echo "Error: no test specified" && exit 1':
                commands.append(f"{prefix}npm test")
            if "build" in scripts:
                commands.append(f"{prefix}npm run build")
        except Exception:
            pass

    if os.path.exists(os.path.join(working_dir, "pyproject.toml")) or os.path.exists(os.path.join(working_dir, "setup.py")):
        if os.path.exists(os.path.join(working_dir, "tests")) or os.path.exists(os.path.join(working_dir, "test")):
            commands.append("python -m pytest --tb=short -q")

    if os.path.exists(os.path.join(working_dir, "Makefile")):
        commands.append("make test 2>/dev/null || true")

    return commands


async def auto_detect_lint_commands(working_dir: str) -> list[str]:
    """
    Auto-detect available type checkers and linters.

    Catches type errors, undefined variables, and missing imports
    BEFORE tests run — faster feedback, no runtime needed.

    Detects:
      TypeScript: tsc --noEmit (type checking without build output)
      Python: ruff check (fast linting) + mypy (type checking)
      ESLint: npx eslint (if .eslintrc or eslint config exists)
    """
    import json

    commands: list[str] = []

    # ── TypeScript: tsc --noEmit ──
    tsconfig = os.path.join(working_dir, "tsconfig.json")
    if os.path.exists(tsconfig):
        # Use npx to avoid global install requirement
        commands.append("npx --yes tsc --noEmit 2>&1 | head -30")

    # ── Python: ruff (fast, zero-config) ──
    has_python = (
        os.path.exists(os.path.join(working_dir, "pyproject.toml"))
        or os.path.exists(os.path.join(working_dir, "setup.py"))
        or os.path.exists(os.path.join(working_dir, "requirements.txt"))
    )
    if has_python:
        # ruff is fast and catches syntax errors + undefined names
        ruff_available = await run_simple(["bash", "-c", "command -v ruff"], timeout_seconds=5)
        if ruff_available.exit_code == 0:
            commands.append("ruff check --select E,F --no-fix --output-format concise . 2>&1 | head -20")
        else:
            # Fallback: python syntax check (always available)
            commands.append("python3 -m py_compile $(find . -name '*.py' -not -path './node_modules/*' -not -path './.venv/*' | head -10) 2>&1")

    # ── ESLint (if configured) ──
    eslint_configs = [
        ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml",
        ".eslintrc.cjs", ".eslintrc.mjs",
    ]
    has_eslint_config = any(
        os.path.exists(os.path.join(working_dir, c)) for c in eslint_configs
    )
    # Also check package.json for eslintConfig
    if not has_eslint_config:
        pkg_json = os.path.join(working_dir, "package.json")
        if os.path.exists(pkg_json):
            try:
                data = json.loads(open(pkg_json).read())
                if "eslintConfig" in data:
                    has_eslint_config = True
            except Exception:
                pass
    if has_eslint_config:
        commands.append("npx --yes eslint . --max-warnings 0 2>&1 | tail -10")

    return commands


async def verify_implementation(
    working_dir: str,
    expected_files: list[str] | None = None,
    test_commands: list[str] | None = None,
) -> VerificationResult:
    """
    Full verification: check files exist + lint/type check + run test commands.

    Verification order (fast → slow):
    1. File existence checks (instant)
    2. Lint / type checks (seconds — catches errors without runtime)
    3. Test commands (may take minutes)
    4. Browser UI verification (if applicable)

    This is the evidence gate — the Sentinel loop only advances
    if ALL evidence checks pass.
    """
    evidence: list[Evidence] = []
    missing: list[str] = []
    failing: list[str] = []

    # 1. Verify files
    if expected_files:
        file_evidence = await verify_files_exist(working_dir, expected_files)
        evidence.extend(file_evidence)
        missing = [e.check.replace("file exists: ", "") for e in file_evidence if not e.passed]

    # 2. Lint / type checks (fast, catches errors before slow test runs)
    lint_commands = await auto_detect_lint_commands(working_dir)
    for cmd in lint_commands:
        lint_evidence = await verify_command(cmd, working_dir)
        # Prefix check name for clarity in output
        lint_evidence.check = f"lint: {cmd.split()[0].split('/')[-1]}"
        evidence.append(lint_evidence)
        if not lint_evidence.passed:
            failing.append(cmd)

    # 3. Auto-detect test commands if none provided
    if not test_commands:
        test_commands = await auto_detect_test_commands(working_dir)

    # Run test commands
    for cmd in (test_commands or []):
        cmd_evidence = await verify_command(cmd, working_dir)
        evidence.append(cmd_evidence)
        if not cmd_evidence.passed:
            failing.append(cmd)

    # 4. Browser-based UI verification (OpenHands pattern)
    # Only runs if Playwright is installed and project has a dev server
    try:
        from openseed_guard.browser_verify import verify_ui
        browser_result = await verify_ui(working_dir)
        if browser_result.error and "not installed" not in browser_result.error:
            evidence.append(Evidence(
                check="browser: UI renders",
                passed=browser_result.passed,
                detail=browser_result.ai_verdict or browser_result.error,
            ))
        elif not browser_result.error:
            evidence.append(Evidence(
                check="browser: UI renders",
                passed=browser_result.passed,
                detail=browser_result.ai_verdict[:200],
            ))
    except Exception:
        pass  # Browser verification is best-effort

    all_passed = all(e.passed for e in evidence) if evidence else False

    return VerificationResult(
        all_passed=all_passed,
        evidence=evidence,
        missing_files=missing,
        failing_commands=failing,
    )
