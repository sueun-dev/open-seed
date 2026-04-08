"""
openseed auth — OAuth authentication management.
"""

from __future__ import annotations

import click
from rich.console import Console
from rich.table import Table

console = Console()


@click.group("auth")
def auth_cmd() -> None:
    """Manage OAuth authentication for OpenAI Codex."""


@auth_cmd.command("status")
def auth_status() -> None:
    """Show authentication status."""
    from openseed_core.auth.openai import check_openai_auth

    table = Table(title="Auth Status")
    table.add_column("Provider", style="bold")
    table.add_column("Installed")
    table.add_column("Authenticated")
    table.add_column("Details")

    openai = check_openai_auth()
    table.add_row(
        "Codex (OpenAI)",
        "✓" if openai.installed else "✗",
        "[green]✓[/]" if openai.authenticated else "[red]✗[/]",
        openai.account[:50] if openai.authenticated else (openai.error or "")[:50],
    )

    console.print(table)

    if not openai.authenticated:
        console.print(f"\n[yellow]Codex: run `{openai.cli_path or 'codex'} auth login`[/yellow]")


@auth_cmd.command("login")
def auth_login() -> None:
    """Interactive login for OpenAI OAuth."""
    import subprocess

    console.print("[bold]Starting OAuth login...[/bold]\n")

    from openseed_core.auth.openai import get_codex_cli_path

    codex_path = get_codex_cli_path()
    if codex_path:
        console.print("[cyan]OpenAI OAuth login:[/cyan]")
        subprocess.run([codex_path, "auth", "login"])
    else:
        console.print("[red]Codex CLI not found. Install: npm install -g @openai/codex[/red]")
