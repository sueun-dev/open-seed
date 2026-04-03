"""
Open Seed v2 — Webhook receiver.

Receives incoming webhooks to trigger pipeline runs.
Pattern from: OpenClaw hooks/ webhook ingress

Usage: Register routes on the FastAPI app:
    register_webhook_routes(app, on_trigger=my_callback)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable


def register_webhook_routes(
    app: FastAPI,
    on_trigger: Callable[[str, dict[str, Any]], Awaitable[None]],
    token: str = "",
) -> None:
    """
    Register webhook endpoints on the FastAPI app.

    POST /hooks/wake — trigger main pipeline with a message
    POST /hooks/agent — trigger isolated agent run
    POST /hooks/<name> — custom webhook mapping

    Args:
        app: FastAPI application
        on_trigger: Async callback (task, metadata) → run pipeline
        token: Bearer token for auth (empty = no auth)
    """

    def _check_auth(request: Request) -> None:
        if not token:
            return
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="Invalid token")

    @app.post("/hooks/wake")
    async def hook_wake(request: Request) -> dict:
        """Wake the main session with a task."""
        _check_auth(request)
        body = await request.json()
        task = body.get("message", body.get("task", ""))
        if not task:
            raise HTTPException(status_code=400, detail="Missing message/task")
        await on_trigger(task, {"source": "webhook", "type": "wake"})
        return {"status": "triggered", "task": task}

    @app.post("/hooks/agent")
    async def hook_agent(request: Request) -> dict:
        """Trigger an isolated agent run."""
        _check_auth(request)
        body = await request.json()
        task = body.get("task", "")
        agent_id = body.get("agent_id", "default")
        if not task:
            raise HTTPException(status_code=400, detail="Missing task")
        await on_trigger(task, {"source": "webhook", "type": "agent", "agent_id": agent_id})
        return {"status": "triggered", "task": task, "agent_id": agent_id}

    @app.post("/hooks/{hook_name}")
    async def hook_custom(hook_name: str, request: Request) -> dict:
        """Custom webhook endpoint."""
        _check_auth(request)
        body = await request.json()
        task = body.get("task", body.get("message", f"Webhook trigger: {hook_name}"))
        await on_trigger(task, {"source": "webhook", "type": "custom", "hook": hook_name, "payload": body})
        return {"status": "triggered", "hook": hook_name}
