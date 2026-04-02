"""Harness quality checker — deterministic scoring, no AI needed."""

from __future__ import annotations

import os
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
      - AGENTS.md exists: 20
      - Mission section (> or **Project:**): 15
      - Key Commands table: 15
      - Boundaries section (NEVER/ASK/ALWAYS): 15
      - Context Map (yaml block): 10
      - CLAUDE.md exists or symlink: 10
      - Sub-AGENTS.md for monorepo packages: 15

    Returns HarnessScore with total, details, and missing items.
    """
    root = Path(working_dir)
    score = 0
    details: dict[str, int] = {}
    missing: list[str] = []

    # 1. AGENTS.md exists
    agents_md = root / "AGENTS.md"
    if agents_md.is_file():
        details["agents_md_exists"] = 20
        score += 20
        content = agents_md.read_text(encoding="utf-8", errors="ignore")

        # 2. Mission section
        if re.search(r"\*\*Project:\*\*", content):
            details["mission"] = 15
            score += 15
        else:
            missing.append("Mission: add '> **Project:** ...' at top of AGENTS.md")

        # 3. Key Commands table
        if "| Intent" in content or "| Command" in content or "Key Commands" in content:
            details["key_commands"] = 15
            score += 15
        else:
            missing.append("Key Commands: add command table (install, test, lint)")

        # 4. Boundaries
        has_never = "### NEVER" in content or "## NEVER" in content
        has_ask = "### ASK" in content or "## ASK" in content
        has_always = "### ALWAYS" in content or "## ALWAYS" in content
        boundary_count = sum([has_never, has_ask, has_always])
        if boundary_count >= 2:
            details["boundaries"] = 15
            score += 15
        elif boundary_count == 1:
            details["boundaries"] = 7
            score += 7
            missing.append("Boundaries: add NEVER/ASK/ALWAYS sections")
        else:
            missing.append("Boundaries: add NEVER/ASK/ALWAYS sections")

        # 5. Context Map
        if "```yaml" in content or "```yml" in content:
            details["context_map"] = 10
            score += 10
        else:
            missing.append("Context Map: add yaml block with project structure")
    else:
        missing.append("AGENTS.md: create root AGENTS.md file")

    # 6. CLAUDE.md
    claude_md = root / "CLAUDE.md"
    if claude_md.exists():
        details["claude_md"] = 10
        score += 10
    else:
        missing.append("CLAUDE.md: create symlink to AGENTS.md (ln -s AGENTS.md CLAUDE.md)")

    # 7. Sub-AGENTS.md for monorepo packages
    sub_score = _check_sub_agents(root)
    details["sub_agents"] = sub_score
    score += sub_score
    if sub_score == 0 and _is_monorepo(root):
        missing.append("Sub-AGENTS.md: add AGENTS.md in each package directory")

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
    """Score sub-AGENTS.md files. Max 15 points."""
    if not _is_monorepo(root):
        # Not a monorepo — full points (not applicable)
        return 15

    package_dirs: list[Path] = []
    for container in ["packages", "apps", "services", "libs", "modules"]:
        container_path = root / container
        if container_path.is_dir():
            for entry in container_path.iterdir():
                if entry.is_dir() and not entry.name.startswith("."):
                    package_dirs.append(entry)

    if not package_dirs:
        return 15  # No packages found — not applicable

    has_agents = sum(1 for p in package_dirs if (p / "AGENTS.md").is_file())
    ratio = has_agents / len(package_dirs) if package_dirs else 0

    if ratio >= 0.8:
        return 15
    elif ratio >= 0.5:
        return 10
    elif ratio > 0:
        return 5
    return 0
