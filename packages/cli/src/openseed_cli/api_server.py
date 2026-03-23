"""
Open Seed v2 — FastAPI server for web UI + webhooks.

Endpoints:
  POST /api/run          — Start pipeline run
  GET  /api/status       — Current pipeline status
  GET  /api/config       — Current config
  GET  /api/memory/search — Search memories
  WS   /ws/events        — Real-time pipeline events

Pattern from: OpenClaw gateway/server.impl.ts (WebSocket protocol)
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Open Seed v2", version="2.0.0-alpha.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active WebSocket connections for event streaming
_ws_clients: list[WebSocket] = []

# Current pipeline state (simplified — will be replaced with proper state management)
_current_run: dict[str, Any] | None = None


# ─── Models ───────────────────────────────────────────────────────────────────


class RunRequest(BaseModel):
    task: str
    working_dir: str = "."
    config_path: str | None = None


class MemorySearchRequest(BaseModel):
    query: str
    limit: int = 10


# ─── REST Endpoints ──────────────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": "2.0.0-alpha.0"}


@app.post("/api/run")
async def start_run(req: RunRequest) -> dict:
    """Start a pipeline run. Events streamed via WebSocket."""
    global _current_run

    if _current_run and _current_run.get("status") == "running":
        return JSONResponse(status_code=409, content={"error": "Pipeline already running"})

    _current_run = {"task": req.task, "status": "running", "messages": []}

    # Run pipeline in background
    asyncio.create_task(_execute_pipeline(req.task, req.working_dir, req.config_path))

    return {"status": "started", "task": req.task}


@app.get("/api/status")
async def get_status() -> dict:
    if not _current_run:
        return {"status": "idle"}
    return _current_run


@app.get("/api/config")
async def get_config() -> dict:
    from openseed_core.config import load_config
    cfg = load_config()
    return cfg.model_dump()


@app.get("/api/memory/search")
async def search_memory(q: str, limit: int = 10) -> dict:
    from openseed_memory import MemoryStore
    store = MemoryStore()
    await store.initialize()
    results = await store.search(q, limit=limit)
    return {
        "query": q,
        "results": [
            {"id": r.entry.id, "content": r.entry.content, "score": r.score}
            for r in results
        ],
    }


# ─── WebSocket ────────────────────────────────────────────────────────────────


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    """Real-time pipeline event stream."""
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            # Keep connection alive — client sends pings
            await ws.receive_text()
    except WebSocketDisconnect:
        _ws_clients.remove(ws)


async def _broadcast(event: dict) -> None:
    """Broadcast event to all connected WebSocket clients."""
    data = json.dumps(event)
    disconnected = []
    for ws in _ws_clients:
        try:
            await ws.send_text(data)
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        _ws_clients.remove(ws)


# ─── Pipeline Execution ──────────────────────────────────────────────────────


async def _execute_pipeline(task: str, working_dir: str, config_path: str | None) -> None:
    """Run the full pipeline with event broadcasting."""
    global _current_run

    from openseed_core.config import load_config
    from openseed_core.events import EventBus, Event
    from openseed_brain import compile_graph, initial_state

    cfg = load_config(Path(config_path) if config_path else None)
    event_bus = EventBus()

    # Bridge events to WebSocket
    async def on_event(event: Event) -> None:
        await _broadcast({
            "type": event.type.value,
            "node": event.node,
            "data": event.data,
            "timestamp": event.timestamp.isoformat(),
        })
        if _current_run:
            _current_run["messages"].append(f"[{event.node}] {event.type.value}")

    event_bus.subscribe(on_event)

    state = initial_state(task=task, working_dir=str(Path(working_dir).resolve()))
    graph = compile_graph()

    try:
        result = await graph.ainvoke(state)
        if _current_run:
            _current_run["status"] = "completed"
            _current_run["errors"] = len(result.get("errors", []))
        await _broadcast({"type": "pipeline.complete", "errors": len(result.get("errors", []))})
    except Exception as e:
        if _current_run:
            _current_run["status"] = "failed"
            _current_run["error"] = str(e)
        await _broadcast({"type": "pipeline.fail", "error": str(e)})
    finally:
        await event_bus.close()
