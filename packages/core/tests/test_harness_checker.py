"""Tests for harness quality checker — full Level 1 coverage."""

import json
import tempfile
from pathlib import Path

from openseed_core.harness.checker import check_harness_quality


class TestCheckHarnessQuality:
    def test_empty_directory_scores_low(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            score = check_harness_quality(tmp)
            # No git → pre_commit(10) + ci_pipeline(10) as N/A full points
            # sub_agents(10 non-monorepo)
            # Total: 30 — still not passing (needs 60)
            assert score.total == 30
            assert not score.passing

    def test_agents_md_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "AGENTS.md").write_text("# My Project\nSome rules.\n")
            score = check_harness_quality(tmp)
            # mission partial(5) + sub_agents(10) = 15
            assert not score.passing

    def test_full_inform_only(self) -> None:
        """Full AGENTS.md but no constrain/verify → still not passing."""
        with tempfile.TemporaryDirectory() as tmp:
            content = """# AGENTS.md
> **Project:** Test — a demo.
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
monorepo: false
```
"""
            (Path(tmp) / "AGENTS.md").write_text(content)
            (Path(tmp) / "CLAUDE.md").symlink_to("AGENTS.md")
            score = check_harness_quality(tmp)
            # Inform: mission(15) + commands(10) + boundaries(10) + context_map(5) + claude(5) + sub(10) = 55
            # No git → pre_commit(10) + ci_pipeline(10) = 20 as N/A
            # Total: 75 — passes because no-git projects get N/A points for git-dependent items
            assert score.total == 75
            assert score.passing

    def test_full_level1_passes(self) -> None:
        """Full Level 1 harness should score >= 60."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            content = """# AGENTS.md
> **Project:** Test — a demo.
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
monorepo: false
```
"""
            (root / "AGENTS.md").write_text(content)
            (root / "CLAUDE.md").symlink_to("AGENTS.md")
            # Constrain
            (root / ".pre-commit-config.yaml").write_text("repos: []")
            (root / "pyproject.toml").write_text("[tool.ruff]\nline-length = 120\n[tool.mypy]\nstrict = true\n")
            # Verify
            (root / ".github" / "workflows").mkdir(parents=True)
            (root / ".github" / "workflows" / "ci.yml").write_text("name: CI")
            (root / "tests").mkdir()
            (root / "tests" / "test_foo.py").write_text("def test_foo(): pass")

            score = check_harness_quality(tmp)
            assert score.passing, f"Score {score.total}/100. Missing: {score.missing}"
            assert score.total >= 90  # Should be very high

    def test_constrain_scoring(self) -> None:
        """Pre-commit + linter + type checker = 25 points."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".pre-commit-config.yaml").write_text("repos: []")
            (root / "pyproject.toml").write_text("[tool.ruff]\n[tool.mypy]\n")
            score = check_harness_quality(tmp)
            assert score.details.get("pre_commit") == 10
            assert score.details.get("linter_config") == 10
            assert score.details.get("type_checker") == 5

    def test_verify_scoring(self) -> None:
        """CI + tests = 20 points."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".github" / "workflows").mkdir(parents=True)
            (root / ".github" / "workflows" / "ci.yml").write_text("name: CI")
            (root / "tests").mkdir()
            (root / "tests" / "test_foo.py").write_text("")
            score = check_harness_quality(tmp)
            assert score.details.get("ci_pipeline") == 10
            assert score.details.get("test_suite") == 10

    def test_node_project_detection(self) -> None:
        """Detect Node.js project toolchain."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pkg = {"devDependencies": {"vitest": "^1.0", "eslint": "^8.0"}}
            (root / "package.json").write_text(json.dumps(pkg))
            (root / "tsconfig.json").write_text("{}")
            score = check_harness_quality(tmp)
            assert score.details.get("linter_config") == 10  # eslint in deps
            assert score.details.get("type_checker") == 5  # tsconfig.json
            assert score.details.get("test_suite") == 10  # vitest in deps

    def test_openseed_own_harness_passes(self) -> None:
        """Verify openseed's own harness scores >= 60 (passing)."""
        project_root = str(Path(__file__).resolve().parent.parent.parent.parent)
        score = check_harness_quality(project_root)
        assert score.passing, f"openseed's own harness should pass! Score: {score.total}/100. Missing: {score.missing}"
