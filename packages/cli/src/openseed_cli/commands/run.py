"""
openseed run — Execute a full pipeline run.

This is the main command. Takes a task, runs the full 7-system pipeline:
Brain → Claude/Codex → QA Gate → Sentinel → Body → Memory
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
    # Suppress noisy checkpoint deserialization warnings
    import warnings
    import logging
    warnings.filterwarnings("ignore", message="Deserializing unregistered type")
    logging.getLogger("langgraph").setLevel(logging.ERROR)
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
            EventType.SENTINEL_RETRY: "[bold red]↻[/]",
            EventType.SENTINEL_ESCALATE: "[bold red]⚠[/]",
            EventType.HEAL_START: "[bold yellow]🔧[/]",
            EventType.MEMORY_STORE: "[bold magenta]💾[/]",
        }.get(event.type, "[dim]·[/]")

        msg = event.data.get("message", event.data.get("text", ""))
        if msg:
            console.print(f"  {icon} [dim]{event.node}[/dim] {str(msg)[:120]}")

    event_bus.subscribe(on_event)

    # Ensure working directory exists
    wd = Path(working_dir).resolve()
    wd.mkdir(parents=True, exist_ok=True)

    # Build and run graph — apply config values
    state = initial_state(
        task=task,
        working_dir=str(wd),
        provider="claude",  # Default; could be overridden via CLI flag later
    )
    # Apply sentinel max_retries from config
    state["max_retries"] = cfg.sentinel.max_retries

    # Set up persistent async checkpointer using config path
    checkpoint_dir = Path(str(cfg.brain.checkpoint_dir)).expanduser()
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    db_path = str(checkpoint_dir / "checkpoints.db")

    checkpointer = None
    try:
        import aiosqlite
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        aiosqlite_conn = await aiosqlite.connect(db_path)
        checkpointer = AsyncSqliteSaver(aiosqlite_conn)
        await checkpointer.setup()
    except ImportError:
        from langgraph.checkpoint.memory import MemorySaver
        checkpointer = MemorySaver()
    except Exception as exc:
        console.print(f"  [yellow]Checkpoint DB unavailable ({exc}), using in-memory[/yellow]")
        from langgraph.checkpoint.memory import MemorySaver
        checkpointer = MemorySaver()

    graph = compile_graph(
        checkpoint_dir=str(checkpoint_dir),
        checkpointer=checkpointer,
    )

    console.print("\n[bold]Pipeline starting...[/bold]\n")

    try:
        # Use streaming to show real-time progress
        from openseed_brain.streaming import PipelineStreamMode

        config = {"configurable": {"thread_id": f"run-{id(state)}"}}

        console.print()
        async for chunk in graph.astream(state, config=config, stream_mode="updates"):
            if not isinstance(chunk, dict):
                continue
            for node_name, update in chunk.items():
                if not isinstance(update, dict):
                    continue

                # Show node execution
                console.print(f"  [bold cyan]▶[/] [bold]{node_name}[/bold]")

                # Show messages from this node
                node_messages = update.get("messages", [])
                for msg in node_messages:
                    text = str(msg)[:200]
                    console.print(f"    [dim]{text}[/dim]")

                # Show errors
                node_errors = update.get("errors", [])
                for err in node_errors:
                    console.print(f"    [red]✗ {err.message}[/red]")

                # Show QA verdict
                qa = update.get("qa_result")
                if qa:
                    color = {"pass": "green", "pass_with_warnings": "green", "warn": "yellow", "block": "red"}.get(qa.verdict.value, "white")
                    console.print(f"    [bold {color}]QA: {qa.verdict.value.upper()}[/] — {qa.synthesis[:100]}")

                # Show deploy result
                deploy = update.get("deploy_result")
                if deploy:
                    if deploy.success:
                        console.print(f"    [green]✓ Deployed: {deploy.message}[/green]")
                    else:
                        console.print(f"    [red]✗ Deploy failed: {deploy.message}[/red]")

        # Get final state
        final_state = await graph.aget_state(config)
        result = final_state.values if final_state else {}

        errors = result.get("errors", [])
        deploy = result.get("deploy_result")

        console.print()
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
        # Clean up async sqlite connection
        if checkpointer and hasattr(checkpointer, "conn"):
            try:
                await checkpointer.conn.close()
            except Exception:
                pass
