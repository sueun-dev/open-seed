"""Harness quality checker — deterministic scoring, no AI needed.

Scores the full Level 1 harness:
  - Inform: AGENTS.md, CLAUDE.md, sub-AGENTS.md
  - Constrain: pre-commit hooks, linter config
  - Verify: CI pipeline, test suite
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class HarnessScore:
    """Result of harness quality check."""

    total: int
    max_score: int = 100
    details: dict[str, int] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)

    @property
    def passing(self) -> bool:
        return self.total >= 60


def check_harness_quality(working_dir: str) -> HarnessScore:
    """Score the harness quality of a project directory.

    Scoring (100 points max):

    Inform (50 points):
      - AGENTS.md exists with Mission: 15
      - AGENTS.md Key Commands: 10
      - AGENTS.md Boundaries (NEVER/ASK/ALWAYS): 10
      - CLAUDE.md exists or symlink: 5
      - Sub-AGENTS.md for monorepo packages: 10

    Constrain (25 points):
      - Pre-commit config exists: 10
      - Linter config exists (ruff/eslint/biome): 10
      - Type checker config exists: 5

    Verify (25 points):
      - CI pipeline exists (.github/workflows/): 10
      - Test files exist: 10
      - Context Map in AGENTS.md: 5
    """
    root = Path(working_dir)
    score = 0
    details: dict[str, int] = {}
    missing: list[str] = []

    # ── Inform ──────────────────────────────────────────────────

    agents_md = root / "AGENTS.md"
    if agents_md.is_file():
        content = agents_md.read_text(encoding="utf-8", errors="ignore")

        # Mission
        if re.search(r"\*\*Project:\*\*", content):
            details["mission"] = 15
            score += 15
        else:
            details["mission"] = 5  # file exists but no mission
            score += 5
            missing.append("Mission: add '> **Project:** ...' at top of AGENTS.md")

        # Key Commands
        if "| Intent" in content or "| Command" in content or "Key Commands" in content:
            details["key_commands"] = 10
            score += 10
        else:
            missing.append("Key Commands: add command table (install, test, lint)")

        # Boundaries
        has_never = "### NEVER" in content or "## NEVER" in content
        has_ask = "### ASK" in content or "## ASK" in content
        has_always = "### ALWAYS" in content or "## ALWAYS" in content
        boundary_count = sum([has_never, has_ask, has_always])
        if boundary_count >= 2:
            details["boundaries"] = 10
            score += 10
        elif boundary_count == 1:
            details["boundaries"] = 5
            score += 5
            missing.append("Boundaries: add NEVER/ASK/ALWAYS sections (at least 2)")
        else:
            missing.append("Boundaries: add NEVER/ASK/ALWAYS sections")

        # Context Map (under Verify but parsed from AGENTS.md)
        if "```yaml" in content or "```yml" in content:
            details["context_map"] = 5
            score += 5
        else:
            missing.append("Context Map: add yaml block with project structure")
    else:
        missing.append("AGENTS.md: create root AGENTS.md file")

    # CLAUDE.md
    claude_md = root / "CLAUDE.md"
    if claude_md.exists():
        details["claude_md"] = 5
        score += 5
    else:
        missing.append("CLAUDE.md: create symlink to AGENTS.md (ln -s AGENTS.md CLAUDE.md)")

    # Sub-AGENTS.md
    sub_score = _check_sub_agents(root)
    details["sub_agents"] = sub_score
    score += sub_score
    if sub_score == 0 and _is_monorepo(root):
        missing.append("Sub-AGENTS.md: add AGENTS.md in each package directory")

    # ── Constrain ───────────────────────────────────────────────

    has_git = (root / ".git").exists()
    git_remote = _detect_git_remote(root) if has_git else None

    # Pre-commit hooks (only if git repo)
    if not has_git:
        details["pre_commit"] = 10  # Not applicable — full points
        score += 10
    elif (root / ".pre-commit-config.yaml").is_file() or (root / ".pre-commit-config.yml").is_file():
        details["pre_commit"] = 10
        score += 10
    else:
        missing.append("Pre-commit: add .pre-commit-config.yaml for lint/format hooks")

    # Linter config
    linter_configs = [
        "pyproject.toml",
        "ruff.toml",
        ".flake8",  # Python
        "biome.json",
        "biome.jsonc",  # Biome
        ".eslintrc.json",
        ".eslintrc.js",
        "eslint.config.js",
        "eslint.config.mjs",  # ESLint
        ".golangci.yml",
        ".golangci.yaml",  # Go
    ]
    has_linter = False
    if (root / "pyproject.toml").is_file():
        try:
            content = (root / "pyproject.toml").read_text(errors="ignore")
            if "ruff" in content or "flake8" in content or "pylint" in content:
                has_linter = True
        except Exception:
            pass
    if not has_linter:
        has_linter = any((root / cfg).is_file() for cfg in linter_configs)
    if not has_linter and (root / "package.json").is_file():
        try:
            import json as _json

            _pkg = _json.loads((root / "package.json").read_text())
            _deps = {**_pkg.get("dependencies", {}), **_pkg.get("devDependencies", {})}
            if any(name in _deps for name in ("eslint", "@biomejs/biome", "biome")):
                has_linter = True
        except Exception:
            pass
    if has_linter:
        details["linter_config"] = 10
        score += 10
    else:
        missing.append("Linter: add linter config (ruff/eslint/biome)")

    # Type checker config
    type_configs = [
        ("pyproject.toml", "mypy"),  # Python mypy in pyproject
        ("mypy.ini", None),
        ("tsconfig.json", None),  # TypeScript
    ]
    has_types = False
    for cfg_file, search_str in type_configs:
        cfg_path = root / cfg_file
        if cfg_path.is_file():
            if search_str is None:
                has_types = True
                break
            try:
                if search_str in cfg_path.read_text(errors="ignore"):
                    has_types = True
                    break
            except Exception:
                pass
    if has_types:
        details["type_checker"] = 5
        score += 5
    else:
        missing.append("Type checker: add type checking config (mypy/tsconfig)")

    # ── Verify ──────────────────────────────────────────────────

    # CI pipeline (only if git repo with remote)
    if not has_git or not git_remote:
        details["ci_pipeline"] = 10  # Not applicable — full points
        score += 10
    else:
        ci_dirs = [
            root / ".github" / "workflows",
            root / ".gitlab-ci.yml",
            root / "Jenkinsfile",
            root / ".circleci",
        ]
        has_ci = False
        for ci_path in ci_dirs:
            if ci_path.exists():
                has_ci = any(ci_path.iterdir()) if ci_path.is_dir() else True
                break
        if has_ci:
            details["ci_pipeline"] = 10
            score += 10
        else:
            if git_remote == "github":
                missing.append("CI: add .github/workflows/ci.yml")
            elif git_remote == "gitlab":
                missing.append("CI: add .gitlab-ci.yml")
            else:
                missing.append("CI: add CI pipeline for your platform")

    # Test files exist
    has_tests = False
    for pattern in ["tests", "test", "__tests__", "spec"]:
        if (root / pattern).is_dir():
            has_tests = True
            break
    if not has_tests:
        # Check for test config files
        for pattern in ["pytest.ini", "conftest.py"]:
            if (root / pattern).is_file():
                has_tests = True
                break
    if not has_tests and (root / "pyproject.toml").is_file():
        try:
            if "pytest" in (root / "pyproject.toml").read_text(errors="ignore"):
                has_tests = True
        except Exception:
            pass
    if not has_tests and (root / "package.json").is_file():
        try:
            import json

            data = json.loads((root / "package.json").read_text())
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if any(t in deps for t in ("vitest", "jest", "mocha", "@playwright/test")):
                has_tests = True
        except Exception:
            pass
    if has_tests:
        details["test_suite"] = 10
        score += 10
    else:
        missing.append("Tests: add test suite (pytest/vitest/jest)")

    return HarnessScore(total=min(score, 100), details=details, missing=missing)


def _is_monorepo(root: Path) -> bool:
    """Check if project is a monorepo."""
    indicators = [
        root / "pnpm-workspace.yaml",
        root / "turbo.json",
        root / "nx.json",
        root / "lerna.json",
    ]
    if any(f.exists() for f in indicators):
        return True

    pkg_json = root / "package.json"
    if pkg_json.is_file():
        try:
            import json

            data = json.loads(pkg_json.read_text())
            if "workspaces" in data:
                return True
        except Exception:
            pass

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        try:
            content = pyproject.read_text()
            if "workspace" in content.lower():
                return True
        except Exception:
            pass

    return False


def _check_sub_agents(root: Path) -> int:
    """Score sub-AGENTS.md files. Max 10 points."""
    if not _is_monorepo(root):
        return 10  # Not a monorepo — full points (not applicable)

    package_dirs: list[Path] = []
    for container in ["packages", "apps", "services", "libs", "modules"]:
        container_path = root / container
        if container_path.is_dir():
            for entry in container_path.iterdir():
                if entry.is_dir() and not entry.name.startswith("."):
                    package_dirs.append(entry)

    if not package_dirs:
        return 10  # No packages found — not applicable

    has_agents = sum(1 for p in package_dirs if (p / "AGENTS.md").is_file())
    ratio = has_agents / len(package_dirs) if package_dirs else 0

    if ratio >= 0.8:
        return 10
    elif ratio >= 0.5:
        return 7
    elif ratio > 0:
        return 3
    return 0


def _detect_git_remote(root: Path) -> str | None:
    """Detect git remote platform. Returns 'github', 'gitlab', or None."""
    try:
        import subprocess

        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=5,
        )
        url = result.stdout.strip()
        if not url:
            return None
        if "github.com" in url:
            return "github"
        if "gitlab" in url:
            return "gitlab"
        return "other"
    except Exception:
        return None
