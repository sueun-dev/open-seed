"""
openseed memory — Search and manage long-term memory.
"""

from __future__ import annotations

import asyncio

import click
from rich.console import Console
from rich.table import Table

console = Console()


@click.group("memory")
def memory_cmd() -> None:
    """Search and manage long-term memory."""


@memory_cmd.command("search")
@click.argument("query")
@click.option("--limit", "-n", default=10, help="Max results")
def memory_search(query: str, limit: int) -> None:
    """Semantic search across stored memories."""
    asyncio.run(_search(query, limit))


async def _search(query: str, limit: int) -> None:
    from openseed_memory import MemoryStore

    store = MemoryStore()
    await store.initialize()
    results = await store.search(query, limit=limit)

    if not results:
        console.print("[dim]No memories found.[/dim]")
        return

    table = Table(title=f"Memories matching: {query}")
    table.add_column("Score", style="cyan", width=8)
    table.add_column("Content")
    table.add_column("Type", width=12)

    for r in results:
        table.add_row(
            f"{r.score:.3f}",
            r.entry.content[:100],
            r.entry.metadata.get("memory_type", "semantic"),
        )

    console.print(table)


@memory_cmd.command("list")
@click.option("--limit", "-n", default=20, help="Max entries")
def memory_list(limit: int) -> None:
    """List all stored memories."""
    asyncio.run(_list(limit))


async def _list(limit: int) -> None:
    from openseed_memory import MemoryStore

    store = MemoryStore()
    await store.initialize()
    entries = await store.get_all(limit=limit)

    if not entries:
        console.print("[dim]No memories stored.[/dim]")
        return

    table = Table(title=f"Stored Memories ({len(entries)})")
    table.add_column("ID", width=10)
    table.add_column("Content")
    table.add_column("Type", width=12)

    for e in entries:
        table.add_row(e.id[:10], e.content[:100], e.metadata.get("memory_type", "semantic"))

    console.print(table)


@memory_cmd.command("clear")
@click.confirmation_option(prompt="Delete ALL memories?")
def memory_clear() -> None:
    """Delete all stored memories."""
    console.print("[yellow]Memory clear not yet implemented.[/yellow]")
