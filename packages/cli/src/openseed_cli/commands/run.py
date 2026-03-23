"""
openseed run — Execute a full pipeline run.

This is the main command. Takes a task, runs the full 7-system pipeline:
Brain → Claude/Codex → QA Gate → Sisyphus → Body → Memory
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import click
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

console = Console()


@click.command("run")
@click.argument("task")
@click.option("--working-dir", "-d", default=".", help="Working directory")
@click.option("--config", "-c", default=None, help="Config YAML path")
@click.option("--plan-only", is_flag=True, help="Generate plan without executing")
@click.option("--resume", default=None, help="Resume from checkpoint ID")
def run_cmd(task: str, working_dir: str, config: str | None, plan_only: bool, resume: str | None) -> None:
    """Execute a full pipeline run."""
    asyncio.run(_run(task, working_dir, config, plan_only, resume))


async def _run(task: str, working_dir: str, config_path: str | None, plan_only: bool, resume: str | None) -> None:
    from openseed_core.config import load_config
    from openseed_core.events import EventBus, Event, EventType
    from openseed_brain import compile_graph, initial_state

    cfg = load_config(Path(config_path) if config_path else None)
    event_bus = EventBus()

    # Display header
    console.print(Panel(
        f"[bold blue]Open Seed v2[/bold blue]\n[dim]{task}[/dim]",
        title="AGI Pipeline",
        border_style="blue",
    ))

    # Stream events to console
    async def on_event(event: Event) -> None:
        icon = {
            EventType.NODE_START: "[bold cyan]▶[/]",
            EventType.NODE_COMPLETE: "[bold green]✓[/]",
            EventType.NODE_FAIL: "[bold red]✗[/]",
            EventType.AGENT_TEXT: "[dim]…[/]",
            EventType.QA_VERDICT: "[bold yellow]⚖[/]",
            EventType.SISYPHUS_RETRY: "[bold red]↻[/]",
            EventType.SISYPHUS_ESCALATE: "[bold red]⚠[/]",
            EventType.HEAL_START: "[bold yellow]🔧[/]",
            EventType.MEMORY_STORE: "[bold magenta]💾[/]",
        }.get(event.type, "[dim]·[/]")

        msg = event.data.get("message", event.data.get("text", ""))
        if msg:
            console.print(f"  {icon} [dim]{event.node}[/dim] {str(msg)[:120]}")

    event_bus.subscribe(on_event)

    # Build and run graph
    state = initial_state(task=task, working_dir=str(Path(working_dir).resolve()))

    # TODO: Add checkpointer for resume support
    graph = compile_graph()

    console.print("\n[bold]Pipeline starting...[/bold]\n")

    try:
        result = await graph.ainvoke(state)

        # Summary
        errors = result.get("errors", [])
        messages = result.get("messages", [])
        deploy = result.get("deploy_result")

        if not errors:
            console.print(Panel(
                "[bold green]Pipeline COMPLETE — zero errors[/bold green]",
                border_style="green",
            ))
        else:
            console.print(Panel(
                f"[bold red]Pipeline finished with {len(errors)} error(s)[/bold red]",
                border_style="red",
            ))
            for e in errors[:5]:
                console.print(f"  [red]• {e.message}[/red]")

        if deploy and deploy.success:
            console.print(f"  [green]Deployed: {deploy.message}[/green]")

    except KeyboardInterrupt:
        console.print("\n[yellow]Pipeline interrupted by user[/yellow]")
    except Exception as e:
        console.print(f"\n[red]Pipeline error: {e}[/red]")
    finally:
        await event_bus.close()
