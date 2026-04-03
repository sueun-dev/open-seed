"""
openseed doctor — System health check.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

import click
from rich.console import Console
from rich.table import Table

console = Console()


@click.command("doctor")
def doctor_cmd() -> None:
    """Check system health — tools, auth, dependencies."""
    table = Table(title="Open Seed Doctor")
    table.add_column("Check", style="bold")
    table.add_column("Status")
    table.add_column("Details")

    # Python version
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    py_ok = sys.version_info >= (3, 11)
    table.add_row("Python", "[green]✓[/]" if py_ok else "[red]✗[/]", py_ver)

    # Git
    git_path = shutil.which("git")
    table.add_row("Git", "[green]✓[/]" if git_path else "[red]✗[/]", git_path or "not found")

    # Node.js
    node_path = shutil.which("node")
    if node_path:
        try:
            node_ver = subprocess.check_output([node_path, "--version"], text=True).strip()
        except Exception:
            node_ver = "error"
        table.add_row("Node.js", "[green]✓[/]", node_ver)
    else:
        table.add_row("Node.js", "[red]✗[/]", "not found")

    # Claude CLI
    from openseed_core.auth.claude import check_claude_auth

    claude = check_claude_auth()
    table.add_row(
        "Claude CLI",
        "[green]✓[/]" if claude.authenticated else ("[yellow]![/]" if claude.installed else "[red]✗[/]"),
        "authenticated" if claude.authenticated else (claude.error or "not installed")[:60],
    )

    # Codex CLI
    from openseed_core.auth.openai import check_openai_auth

    openai = check_openai_auth()
    table.add_row(
        "Codex CLI",
        "[green]✓[/]" if openai.authenticated else ("[yellow]![/]" if openai.installed else "[red]✗[/]"),
        "authenticated" if openai.authenticated else (openai.error or "not installed")[:60],
    )

    # uv
    uv_path = shutil.which("uv")
    table.add_row("uv", "[green]✓[/]" if uv_path else "[yellow]![/]", uv_path or "not found (optional)")

    console.print(table)

    all_ok = py_ok and git_path and (claude.authenticated or openai.authenticated)
    if all_ok:
        console.print("\n[bold green]All critical checks passed.[/bold green]")
    else:
        console.print("\n[bold yellow]Some checks failed. Run `openseed auth login` to authenticate.[/bold yellow]")
