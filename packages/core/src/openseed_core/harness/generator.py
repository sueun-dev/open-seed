"""Harness scaffold generator — deterministic template generation from scan results."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ScanResult:
    """Result of project folder scan."""

    root: str
    name: str
    languages: list[str] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    package_manager: str | None = None
    test_runner: str | None = None
    linter: str | None = None
    linter_config: str | None = None
    formatter: str | None = None
    type_checker: str | None = None
    build_tool: str | None = None
    is_monorepo: bool = False
    monorepo_tool: str | None = None
    packages: list[PackageInfo] = field(default_factory=list)
    commands: dict[str, str] = field(default_factory=dict)


@dataclass
class PackageInfo:
    name: str
    path: str
    description: str


@dataclass
class HarnessFile:
    """A file to be written as part of harness scaffold."""

    path: str  # relative to project root
    content: str


def scan_project(working_dir: str) -> ScanResult:
    """Scan a project directory and detect tech stack. Deterministic, no AI."""
    root = Path(working_dir)
    name = root.name
    result = ScanResult(root=working_dir, name=name)

    # Python
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        content = pyproject.read_text(errors="ignore")
        result.languages.append("Python")
        if "uv" in content.lower():
            result.package_manager = "uv"
        elif (root / "Pipfile").exists():
            result.package_manager = "pipenv"
        elif (root / "poetry.lock").exists():
            result.package_manager = "poetry"
        else:
            result.package_manager = "pip"

        if "ruff" in content:
            result.linter = "ruff"
            result.linter_config = "pyproject.toml"
            result.formatter = "ruff"
        if "mypy" in content:
            result.type_checker = "mypy"
        if "pytest" in content:
            result.test_runner = "pytest"
        if "workspace" in content.lower():
            result.is_monorepo = True
            result.monorepo_tool = "uv workspace"

    elif (root / "requirements.txt").exists():
        result.languages.append("Python")
        result.package_manager = "pip"

    # Node.js / TypeScript
    pkg_json = root / "package.json"
    if pkg_json.is_file():
        try:
            data = json.loads(pkg_json.read_text())
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}

            if "typescript" in deps or (root / "tsconfig.json").exists():
                result.languages.append("TypeScript")
            else:
                result.languages.append("JavaScript")

            # Package manager
            if (root / "pnpm-lock.yaml").exists():
                result.package_manager = result.package_manager or "pnpm"
            elif (root / "yarn.lock").exists():
                result.package_manager = result.package_manager or "yarn"
            elif (root / "bun.lockb").exists():
                result.package_manager = result.package_manager or "bun"
            else:
                result.package_manager = result.package_manager or "npm"

            # Frameworks
            for name_check, label in [
                ("next", "Next.js"), ("react", "React"), ("vue", "Vue"),
                ("express", "Express"), ("fastify", "Fastify"), ("hono", "Hono"),
                ("astro", "Astro"), ("svelte", "Svelte"),
            ]:
                if name_check in deps:
                    result.frameworks.append(label)

            # Test runner
            if not result.test_runner:
                if "vitest" in deps:
                    result.test_runner = "vitest"
                elif "jest" in deps:
                    result.test_runner = "jest"

            # Linter
            if not result.linter:
                if "@biomejs/biome" in deps:
                    result.linter = "biome"
                    result.linter_config = "biome.json"
                elif "eslint" in deps:
                    result.linter = "eslint"

            # Monorepo
            if "workspaces" in data:
                result.is_monorepo = True
            if (root / "turbo.json").exists():
                result.is_monorepo = True
                result.monorepo_tool = "turborepo"
            elif (root / "nx.json").exists():
                result.is_monorepo = True
                result.monorepo_tool = "nx"
            elif (root / "pnpm-workspace.yaml").exists():
                result.is_monorepo = True
                result.monorepo_tool = "pnpm workspaces"

            # Scripts → commands
            scripts = data.get("scripts", {})
            pm = result.package_manager or "npm"
            run_prefix = "npm run" if pm == "npm" else pm
            for script_name, cmd_key in [
                ("build", "build"), ("dev", "dev"), ("test", "test"),
                ("lint", "lint"), ("typecheck", "typecheck"),
            ]:
                if script_name in scripts:
                    result.commands[cmd_key] = f"{run_prefix} {script_name}"
        except Exception:
            result.languages.append("JavaScript")

    # Go
    if (root / "go.mod").exists():
        result.languages.append("Go")
        result.package_manager = result.package_manager or "go mod"
        result.test_runner = result.test_runner or "go test"

    # Rust
    if (root / "Cargo.toml").exists():
        result.languages.append("Rust")
        result.package_manager = result.package_manager or "cargo"
        result.test_runner = result.test_runner or "cargo test"

    # Build commands from detected tools
    if not result.commands:
        result.commands = _build_commands(result)

    # Detect monorepo packages
    if result.is_monorepo:
        result.packages = _detect_packages(root)

    return result


def _build_commands(scan: ScanResult) -> dict[str, str]:
    """Generate key commands from detected tools."""
    cmds: dict[str, str] = {}
    pm = scan.package_manager

    if pm == "uv":
        cmds["install"] = "uv sync"
    elif pm in ("pnpm", "yarn", "npm", "bun"):
        cmds["install"] = f"{pm} install"
    elif pm == "pip":
        cmds["install"] = "pip install -r requirements.txt"
    elif pm == "poetry":
        cmds["install"] = "poetry install"

    if scan.test_runner:
        cmds["test"] = scan.test_runner
    if scan.linter:
        if scan.linter == "ruff":
            cmds["lint"] = "ruff check ."
        elif scan.linter == "biome":
            cmds["lint"] = "biome check ."
        elif scan.linter == "eslint":
            cmds["lint"] = "eslint ."
    if scan.formatter:
        if scan.formatter == "ruff":
            cmds["format"] = "ruff format ."
    if scan.type_checker:
        cmds["typecheck"] = f"{scan.type_checker} ."

    return cmds


def _detect_packages(root: Path) -> list[PackageInfo]:
    """Detect monorepo sub-packages."""
    packages: list[PackageInfo] = []
    for container in ["packages", "apps", "services", "libs", "modules"]:
        container_path = root / container
        if not container_path.is_dir():
            continue
        for entry in sorted(container_path.iterdir()):
            if entry.is_dir() and not entry.name.startswith("."):
                desc = _infer_description(entry.name)
                packages.append(PackageInfo(
                    name=entry.name,
                    path=f"{container}/{entry.name}",
                    description=desc,
                ))
    return packages


def _infer_description(name: str) -> str:
    hints = {
        "web": "web frontend", "app": "application", "api": "API server",
        "core": "core business logic", "shared": "shared utilities",
        "types": "shared types", "ui": "UI components", "db": "database layer",
        "auth": "authentication", "cli": "CLI tool", "server": "backend server",
    }
    return hints.get(name, f"{name} package")


def generate_scaffold(scan: ScanResult, existing_files: set[str] | None = None) -> list[HarnessFile]:
    """Generate harness scaffold files from scan result. Deterministic, no AI.

    Only generates files that don't already exist (checks existing_files set
    or defaults to checking the filesystem).
    """
    import os

    if existing_files is None:
        existing_files = set()
        for candidate in ["AGENTS.md", ".pre-commit-config.yaml", ".github/workflows/ci.yml"]:
            if os.path.exists(os.path.join(scan.root, candidate)):
                existing_files.add(candidate)

    files: list[HarnessFile] = []

    # ── Inform ──────────────────────────────────────────────────

    # Root AGENTS.md
    if "AGENTS.md" not in existing_files:
        files.append(HarnessFile(
            path="AGENTS.md",
            content=_generate_root_agents_md(scan),
        ))

    # Sub-AGENTS.md for monorepo packages
    if scan.is_monorepo:
        for pkg in scan.packages:
            pkg_agents = f"{pkg.path}/AGENTS.md"
            if pkg_agents not in existing_files:
                files.append(HarnessFile(
                    path=pkg_agents,
                    content=_generate_sub_agents_md(pkg, scan),
                ))

    # ── Constrain ───────────────────────────────────────────────

    # Pre-commit config
    if ".pre-commit-config.yaml" not in existing_files:
        precommit = _generate_precommit_config(scan)
        if precommit:
            files.append(HarnessFile(
                path=".pre-commit-config.yaml",
                content=precommit,
            ))

    # ── Verify ──────────────────────────────────────────────────

    # CI pipeline
    if ".github/workflows/ci.yml" not in existing_files:
        ci = _generate_ci_pipeline(scan)
        if ci:
            files.append(HarnessFile(
                path=".github/workflows/ci.yml",
                content=ci,
            ))

    return files


def _generate_root_agents_md(scan: ScanResult) -> str:
    sections: list[str] = []

    # Mission (placeholder for AI to fill)
    sections.append("# AGENTS.md\n")
    sections.append(f"> **Project:** {scan.name} — [TODO: describe project in 1-2 sentences]")
    sections.append("")

    # Key Commands
    sections.append("## Key Commands")
    sections.append("| Intent | Command | Notes |")
    sections.append("|--------|---------|-------|")
    for intent, cmd in scan.commands.items():
        note = ""
        if intent == "lint" and scan.linter_config:
            note = f"see {scan.linter_config}"
        elif intent == "typecheck" and scan.type_checker:
            note = f"{scan.type_checker}"
        sections.append(f"| {intent.capitalize()} | `{cmd}` | {note} |")
    sections.append("")

    # Architecture Constraints
    if scan.is_monorepo and scan.packages:
        sections.append("## Architecture Constraints")
        pkg_names = [p.name for p in scan.packages]
        sections.append(f"- Packages: {', '.join(pkg_names)}")
        sections.append("- [TODO: define dependency flow between packages]")
        sections.append("")

    # Code Style
    sections.append("## Code Style")
    for lang in scan.languages:
        if lang == "Python":
            sections.append("- Type hints on all public functions")
            sections.append("- async/await for I/O operations")
        elif lang in ("TypeScript", "JavaScript"):
            sections.append("- Named exports preferred")
        elif lang == "Go":
            sections.append("- Always handle errors explicitly")
    sections.append("- Structured logging only. No print/console.log in production.")
    sections.append("")

    # Boundaries
    sections.append("## Boundaries\n")
    sections.append("### NEVER")
    sections.append("- Commit secrets, tokens, or .env files")
    sections.append("- Force push to main")
    sections.append("")
    sections.append("### ASK")
    sections.append("- Before adding new external dependencies")
    sections.append("")
    sections.append("### ALWAYS")
    verify_parts = []
    if scan.commands.get("lint"):
        verify_parts.append(scan.commands["lint"])
    if scan.commands.get("typecheck"):
        verify_parts.append(scan.commands["typecheck"])
    if scan.commands.get("test"):
        verify_parts.append(scan.commands["test"])
    if verify_parts:
        sections.append(f"- Run `{' && '.join(verify_parts)}` before marking task complete")
    sections.append("- Handle all errors explicitly")
    sections.append("")

    # Context Map
    if scan.is_monorepo and scan.packages:
        sections.append("## Context Map")
        sections.append("```yaml")
        if scan.monorepo_tool:
            sections.append(f"monorepo: {scan.monorepo_tool}")
        sections.append("\npackages:")
        for pkg in scan.packages:
            sections.append(f"  {pkg.path}: {pkg.description}")
        sections.append("```")
        sections.append("")

    return "\n".join(sections)


def _generate_sub_agents_md(pkg: PackageInfo, scan: ScanResult) -> str:
    sections: list[str] = []
    sections.append(f"# AGENTS.md ({pkg.path}/)\n")
    sections.append("## Scope")
    sections.append(f"{pkg.description}\n")
    sections.append("## Rules")
    sections.append("- [TODO: add package-specific rules]\n")
    sections.append("## Testing")

    test_cmd = scan.commands.get("test", "pytest")
    if "Python" in scan.languages:
        sections.append(f"- Run: `{test_cmd} {pkg.path}/tests/`")
    else:
        pm = scan.package_manager or "npm"
        sections.append(f"- Run: `{pm} --filter {pkg.name} test`")

    return "\n".join(sections)


def _generate_precommit_config(scan: ScanResult) -> str | None:
    """Generate .pre-commit-config.yaml based on detected toolchain."""
    hooks: list[str] = []

    if "Python" in scan.languages:
        if scan.linter == "ruff":
            hooks.append("""  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.6
    hooks:
      - id: ruff
        args: [check, --fix]
      - id: ruff-format""")
        if scan.type_checker == "mypy":
            hooks.append("""  - repo: local
    hooks:
      - id: mypy
        name: mypy
        entry: mypy .
        language: system
        types: [python]
        pass_filenames: false""")

    if "TypeScript" in scan.languages or "JavaScript" in scan.languages:
        if scan.linter == "biome":
            hooks.append("""  - repo: local
    hooks:
      - id: biome
        name: biome check
        entry: biome check --write
        language: system
        types_or: [javascript, jsx, ts, tsx, json]""")
        elif scan.linter == "eslint":
            hooks.append("""  - repo: local
    hooks:
      - id: eslint
        name: eslint
        entry: eslint --fix
        language: system
        types_or: [javascript, jsx, ts, tsx]""")

    if not hooks:
        return None

    return "repos:\n" + "\n".join(hooks) + "\n"


def _generate_ci_pipeline(scan: ScanResult) -> str | None:
    """Generate .github/workflows/ci.yml based on detected toolchain."""
    steps: list[str] = []

    steps.append("      - uses: actions/checkout@v4")

    if "Python" in scan.languages:
        pm = scan.package_manager or "pip"
        if pm == "uv":
            steps.append("""
      - uses: astral-sh/setup-uv@v4
        with:
          version: "latest"

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install dependencies
        run: uv sync""")
        else:
            steps.append("""
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install dependencies
        run: pip install -r requirements.txt""")

        run_prefix = "uv run " if pm == "uv" else ""

        if scan.commands.get("lint"):
            steps.append(f"""
      - name: Lint
        run: {run_prefix}{scan.commands['lint']}""")
        if scan.commands.get("format"):
            steps.append(f"""
      - name: Format check
        run: {run_prefix}{scan.commands['format']} --check""")
        if scan.commands.get("typecheck"):
            steps.append(f"""
      - name: Type check
        run: {run_prefix}{scan.commands['typecheck']}""")
        if scan.commands.get("test"):
            steps.append(f"""
      - name: Test
        run: {run_prefix}{scan.commands['test']}""")

    elif "TypeScript" in scan.languages or "JavaScript" in scan.languages:
        pm = scan.package_manager or "npm"
        steps.append(f"""
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: {pm} install""")

        for intent in ["lint", "typecheck", "test"]:
            if scan.commands.get(intent):
                steps.append(f"""
      - name: {intent.capitalize()}
        run: {scan.commands[intent]}""")

    elif "Go" in scan.languages:
        steps.append("""
      - uses: actions/setup-go@v5
        with:
          go-version: "stable"

      - name: Test
        run: go test ./...""")

    if len(steps) <= 1:  # Only checkout, no meaningful steps
        return None

    return f"""name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
{"".join(steps)}
"""


def get_ai_guide() -> str:
    """Load the AI harness guide for use as LLM context."""
    guide_path = Path(__file__).parent / "ai_guide.md"
    return guide_path.read_text(encoding="utf-8")
