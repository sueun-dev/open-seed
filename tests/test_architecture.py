"""Structural tests: enforce dependency direction from AGENTS.md Architecture Constraints.

Rules enforced:
  1. core has zero openseed internal dependencies
  2. Cross-peer imports forbidden (claude <-> codex, qa_gate <-> guard)
  3. Lower layers cannot import higher layers

Dependency flow (from AGENTS.md):
  core → brain/claude/codex → qa_gate/guard → deploy/memory → cli
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGES_DIR = Path(__file__).resolve().parent.parent / "packages"

# Allowed import directions: package -> set of packages it MAY import from
# brain is the orchestrator — it coordinates all packages by design.
ALLOWED_DEPS: dict[str, set[str]] = {
    "core": set(),  # zero openseed internal deps
    "brain": {"core", "claude", "codex", "qa_gate", "guard", "deploy", "memory"},
    "claude": {"core"},
    "codex": {"core"},
    "qa_gate": {"core", "codex", "claude"},
    "guard": {"core", "claude", "memory"},
    "deploy": {"core"},
    "memory": {"core", "claude"},
    "cli": {"core", "brain", "claude", "codex", "qa_gate", "guard", "deploy", "memory"},
}

# Known violations to fix later (file path -> imported package)
# Remove entries as violations are fixed.
KNOWN_VIOLATIONS: set[tuple[str, str]] = set()


def _collect_openseed_imports(filepath: Path) -> list[tuple[str, str]]:
    """Parse a Python file and return all openseed package imports.

    Returns list of (module_name, imported_package) tuples.
    e.g. ("openseed_brain.state", "brain")
    """
    try:
        source = filepath.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(filepath))
    except (SyntaxError, UnicodeDecodeError):
        return []

    imports: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules = [node.module]

        for mod in modules:
            if mod.startswith("openseed_"):
                # Extract package name: openseed_brain.state -> brain
                pkg = mod.split(".")[0].removeprefix("openseed_")
                imports.append((mod, pkg))

    return imports


def _get_package_name(filepath: Path) -> str | None:
    """Determine which openseed package a file belongs to."""
    rel = filepath.relative_to(PACKAGES_DIR)
    return str(rel.parts[0]) if rel.parts else None


def _collect_all_violations() -> list[str]:
    """Scan all packages and return list of violation descriptions."""
    violations: list[str] = []

    for pkg_name, allowed in ALLOWED_DEPS.items():
        src_dir = PACKAGES_DIR / pkg_name / "src"
        if not src_dir.exists():
            continue

        for py_file in src_dir.rglob("*.py"):
            rel_path = str(py_file.relative_to(PACKAGES_DIR.parent))
            for _mod, imported_pkg in _collect_openseed_imports(py_file):
                if imported_pkg == pkg_name:
                    continue  # self-import is fine
                if imported_pkg not in allowed:
                    if (rel_path, imported_pkg) in KNOWN_VIOLATIONS:
                        continue  # skip known violations
                    violations.append(
                        f"{rel_path} imports openseed_{imported_pkg} "
                        f"('{pkg_name}' may only import from: {allowed or 'nothing'})"
                    )

    return violations


def test_dependency_direction() -> None:
    """No package imports from a package it is not allowed to depend on."""
    violations = _collect_all_violations()
    assert violations == [], "Architecture constraint violations found:\n" + "\n".join(f"  - {v}" for v in violations)


def test_core_has_no_internal_deps() -> None:
    """Core package must not import any other openseed package (except known violations)."""
    src_dir = PACKAGES_DIR / "core" / "src"
    violations: list[str] = []

    for py_file in src_dir.rglob("*.py"):
        rel_path = str(py_file.relative_to(PACKAGES_DIR.parent))
        for _mod, imported_pkg in _collect_openseed_imports(py_file):
            if imported_pkg == "core":
                continue
            if (rel_path, imported_pkg) in KNOWN_VIOLATIONS:
                continue
            violations.append(f"{rel_path} imports openseed_{imported_pkg}")

    assert violations == [], "Core must have zero openseed internal deps:\n" + "\n".join(f"  - {v}" for v in violations)


def test_no_cross_peer_imports() -> None:
    """Cross-peer packages must not import each other."""
    peer_pairs = [
        ("claude", "codex"),
        ("qa_gate", "guard"),
    ]
    violations: list[str] = []

    for pkg_a, pkg_b in peer_pairs:
        for pkg, peer in [(pkg_a, pkg_b), (pkg_b, pkg_a)]:
            src_dir = PACKAGES_DIR / pkg / "src"
            if not src_dir.exists():
                continue
            for py_file in src_dir.rglob("*.py"):
                rel_path = str(py_file.relative_to(PACKAGES_DIR.parent))
                for _mod, imported_pkg in _collect_openseed_imports(py_file):
                    if imported_pkg == peer:
                        violations.append(f"{rel_path} imports openseed_{peer}")

    assert violations == [], "Cross-peer imports forbidden:\n" + "\n".join(f"  - {v}" for v in violations)
