"""
Open Seed v2 — CLI entry point.

Usage:
    openseed run "Build a REST API"
    openseed auth login
    openseed doctor
    openseed serve
    openseed memory search "query"
"""

from __future__ import annotations

import click


@click.group()
@click.version_option(version="2.0.0-alpha.0", prog_name="openseed")
def cli() -> None:
    """Open Seed — Zero-Bug Autonomous AGI Coding Engine."""


# Import and register commands
from openseed_cli.commands.auth import auth_cmd
from openseed_cli.commands.doctor import doctor_cmd
from openseed_cli.commands.memory import memory_cmd
from openseed_cli.commands.resolve import resolve_cmd
from openseed_cli.commands.run import run_cmd
from openseed_cli.commands.serve import serve_cmd

cli.add_command(run_cmd, "run")
cli.add_command(auth_cmd, "auth")
cli.add_command(doctor_cmd, "doctor")
cli.add_command(serve_cmd, "serve")
cli.add_command(memory_cmd, "memory")
cli.add_command(resolve_cmd, "resolve")


if __name__ == "__main__":
    cli()
