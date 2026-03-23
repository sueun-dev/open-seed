"""
openseed serve — Start API server for web UI.
"""

from __future__ import annotations

import click
from rich.console import Console

console = Console()


@click.command("serve")
@click.option("--host", default="127.0.0.1", help="Bind host")
@click.option("--port", default=8000, help="Bind port")
@click.option("--reload", is_flag=True, help="Auto-reload on changes")
def serve_cmd(host: str, port: int, reload: bool) -> None:
    """Start the API server for web UI and webhooks."""
    import uvicorn

    console.print(f"[bold blue]Open Seed API Server[/bold blue]")
    console.print(f"  http://{host}:{port}")
    console.print(f"  WebSocket: ws://{host}:{port}/ws/events")
    console.print()

    uvicorn.run(
        "openseed_cli.api_server:app",
        host=host,
        port=port,
        reload=reload,
    )
