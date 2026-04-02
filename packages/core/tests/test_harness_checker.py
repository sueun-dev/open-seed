"""Tests for harness quality checker."""

import os
import tempfile
from pathlib import Path

from openseed_core.harness.checker import HarnessScore, check_harness_quality


class TestCheckHarnessQuality:
    def test_empty_directory_scores_low(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            score = check_harness_quality(tmp)
            # sub_agents gives 15 for non-monorepo (not applicable)
            assert score.total == 15
            assert not score.passing
            assert "AGENTS.md: create root AGENTS.md file" in score.missing

    def test_minimal_agents_md_scores_low(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "AGENTS.md").write_text("# My Project\nSome rules.\n")
            score = check_harness_quality(tmp)
            # agents_md(20) + sub_agents(15 non-monorepo) = 35
            assert score.total == 35
            assert not score.passing

    def test_full_agents_md_scores_high(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            content = """# AGENTS.md

> **Project:** Test project — a demo app.

## Key Commands
| Intent | Command | Notes |
|--------|---------|-------|
| Test | `pytest` | test runner |

## Boundaries

### NEVER
- Commit secrets

### ASK
- Before adding deps

### ALWAYS
- Run tests before marking done

## Context Map
```yaml
monorepo: false
```
"""
            (Path(tmp) / "AGENTS.md").write_text(content)
            (Path(tmp) / "CLAUDE.md").symlink_to("AGENTS.md")
            score = check_harness_quality(tmp)
            # agents_md(20) + mission(15) + commands(15) + boundaries(15) + context_map(10) + claude(10) + sub(15 non-monorepo)
            assert score.total == 100
            assert score.passing

    def test_monorepo_without_sub_agents_loses_points(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Make it look like a monorepo
            (root / "pyproject.toml").write_text('[tool.uv.workspace]\nmembers = ["packages/*"]')
            (root / "packages" / "core").mkdir(parents=True)
            (root / "packages" / "api").mkdir(parents=True)
            # AGENTS.md with all sections
            content = """# AGENTS.md
> **Project:** Mono project
## Key Commands
| Intent | Command |
| Test | `pytest` |
## Boundaries
### NEVER
- No secrets
### ASK
- Before deps
### ALWAYS
- Run tests
## Context Map
```yaml
monorepo: uv workspace
```
"""
            (root / "AGENTS.md").write_text(content)
            (root / "CLAUDE.md").symlink_to("AGENTS.md")

            score = check_harness_quality(tmp)
            # No sub-AGENTS.md → sub_agents = 0
            assert score.details.get("sub_agents", 0) == 0
            assert score.total < 100

    def test_monorepo_with_sub_agents_full_score(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "pyproject.toml").write_text('[tool.uv.workspace]\nmembers = ["packages/*"]')
            (root / "packages" / "core").mkdir(parents=True)
            (root / "packages" / "api").mkdir(parents=True)
            (root / "packages" / "core" / "AGENTS.md").write_text("# core rules")
            (root / "packages" / "api" / "AGENTS.md").write_text("# api rules")

            content = """# AGENTS.md
> **Project:** Mono project
## Key Commands
| Intent | Command |
| Test | `pytest` |
## Boundaries
### NEVER
- No
### ASK
- Ask
### ALWAYS
- Always
## Context Map
```yaml
monorepo: uv
```
"""
            (root / "AGENTS.md").write_text(content)
            (root / "CLAUDE.md").symlink_to("AGENTS.md")

            score = check_harness_quality(tmp)
            assert score.details["sub_agents"] == 15
            assert score.total == 100

    def test_openseed_own_harness_passes(self) -> None:
        """Verify openseed's own harness scores >= 60 (passing)."""
        # packages/core/tests/test_harness_checker.py → packages/core/tests → packages/core → packages → mygent
        project_root = str(Path(__file__).resolve().parent.parent.parent.parent)
        score = check_harness_quality(project_root)
        assert score.passing, (
            f"openseed's own harness should pass! Score: {score.total}/100. "
            f"Missing: {score.missing}"
        )
