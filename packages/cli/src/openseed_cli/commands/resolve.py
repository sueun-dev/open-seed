"""
openseed resolve — Automatically fix a GitHub/GitLab issue.

Reads the issue, runs the full pipeline, and creates a PR with the fix.

Usage:
    openseed resolve --repo owner/name --issue 42
    openseed resolve --repo owner/name --issue 42 --working-dir ./my-project

Pattern from: openhands/resolver/resolve_issue.py
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel

console = Console()


@click.command("resolve")
@click.option("--repo", "-r", required=True, help="Repository (owner/name)")
@click.option("--issue", "-i", required=True, type=int, help="Issue number")
@click.option("--working-dir", "-d", default=".", help="Working directory (must be a git clone of the repo)")
@click.option("--platform", type=click.Choice(["github", "gitlab"]), default="github", help="Platform")
@click.option("--create-pr", is_flag=True, default=True, help="Create PR after fix")
@click.option("--base-branch", default="main", help="Base branch for PR")
def resolve_cmd(
    repo: str,
    issue: int,
    working_dir: str,
    platform: str,
    create_pr: bool,
    base_branch: str,
) -> None:
    """Automatically fix a GitHub/GitLab issue and create a PR."""
    asyncio.run(_resolve(repo, issue, working_dir, platform, create_pr, base_branch))


async def _resolve(
    repo: str,
    issue_number: int,
    working_dir: str,
    platform: str,
    create_pr: bool,
    base_branch: str,
) -> None:
    import warnings
    import logging
    warnings.filterwarnings("ignore", message="Deserializing unregistered type")
    logging.getLogger("langgraph").setLevel(logging.ERROR)

    from openseed_core.events import EventBus, Event, EventType

    console.print(Panel(
        f"[bold blue]Open Seed v2 — Issue Resolver[/bold blue]\n"
        f"[dim]{platform}:{repo}#{issue_number}[/dim]",
        title="Issue Resolver",
        border_style="blue",
    ))

    # ── Step 1: Read the issue ──────────────────────────────────────────────
    console.print("\n[bold]Reading issue...[/bold]")

    try:
        if platform == "github":
            from openseed_core.issue_reader import read_github_issue
            issue_ctx = await read_github_issue(repo, issue_number)
        else:
            from openseed_core.issue_reader import read_gitlab_issue
            issue_ctx = await read_gitlab_issue(repo, issue_number)
    except RuntimeError as e:
        console.print(f"[red]Failed to read issue: {e}[/red]")
        return

    console.print(f"  [green]✓[/green] #{issue_ctx.number}: {issue_ctx.title}")
    if issue_ctx.labels:
        console.print(f"  Labels: {', '.join(issue_ctx.labels)}")
    console.print(f"  {issue_ctx.body[:200]}...")

    # ── Step 2: Run pipeline with issue as task ─────────────────────────────
    task = issue_ctx.to_task()

    from openseed_core.config import load_config
    from openseed_brain import compile_graph, initial_state

    wd = Path(working_dir).resolve()
    if not wd.exists():
        console.print(f"[red]Working directory does not exist: {wd}[/red]")
        return

    state = initial_state(task=task, working_dir=str(wd))

    # Set up checkpointer
    from langgraph.checkpoint.memory import MemorySaver
    graph = compile_graph(
        checkpoint_dir=str(wd),
        checkpointer=MemorySaver(),
    )

    console.print("\n[bold]Running pipeline...[/bold]\n")

    event_bus = EventBus()

    async def on_event(event: Event) -> None:
        msg = event.data.get("message", event.data.get("text", ""))
        if msg:
            console.print(f"  [dim]{event.node}[/dim] {str(msg)[:120]}")

    event_bus.subscribe(on_event)

    try:
        config = {"configurable": {"thread_id": f"resolve-{repo}-{issue_number}"}}

        async for chunk in graph.astream(state, config=config, stream_mode="updates"):
            if not isinstance(chunk, dict):
                continue
            for node_name, update in chunk.items():
                if not isinstance(update, dict):
                    continue
                console.print(f"  [bold cyan]▶[/] [bold]{node_name}[/bold]")
                for msg in update.get("messages", []):
                    console.print(f"    [dim]{str(msg)[:200]}[/dim]")

        # ── Step 3: Create PR ───────────────────────────────────────────────
        if create_pr:
            console.print("\n[bold]Creating PR...[/bold]")
            try:
                from openseed_deploy.channels.pr import PRChannel
                pr_channel = PRChannel(base_branch=base_branch)

                if not await pr_channel.check():
                    console.print("[red]gh CLI not authenticated. Run: gh auth login[/red]")
                    return

                result = await pr_channel.deploy(
                    working_dir=str(wd),
                    message=f"Fix #{issue_number}: {issue_ctx.title}",
                    issue_number=issue_number,
                )

                if result.success:
                    console.print(f"\n[green]✓ PR created: {result.url}[/green]")
                else:
                    console.print(f"\n[red]✗ PR failed: {result.message}[/red]")

            except Exception as e:
                console.print(f"\n[red]PR creation error: {e}[/red]")
        else:
            console.print("\n[green]✓ Fix applied locally (--no-create-pr)[/green]")

        console.print(Panel(
            "[bold green]Issue resolution complete[/bold green]",
            border_style="green",
        ))

    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted by user[/yellow]")
    except Exception as e:
        console.print(f"\n[red]Pipeline error: {e}[/red]")
    finally:
        await event_bus.close()
