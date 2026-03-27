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
    provider: str = "claude"  # "claude", "codex", "both"


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
    asyncio.create_task(_execute_pipeline(req.task, req.working_dir, req.config_path, req.provider))

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


@app.get("/api/resolve-folder")
async def resolve_folder(name: str) -> dict:
    """Resolve a folder name to its full absolute path by searching common locations."""
    import os
    import subprocess

    folder_name = name.strip().strip("/")
    if not folder_name:
        return {"error": "Empty folder name", "matches": []}

    # If already absolute path, just verify it exists
    if name.startswith("/") and os.path.isdir(name):
        return {"matches": [name]}

    # Search common parent directories
    home = os.path.expanduser("~")
    search_roots = [
        home,
        os.path.join(home, "Desktop"),
        os.path.join(home, "Documents"),
        os.path.join(home, "Developer"),
        os.path.join(home, "Projects"),
        "/Volumes",
        "/tmp",
    ]

    # Also search all mounted volumes
    if os.path.isdir("/Volumes"):
        for vol in os.listdir("/Volumes"):
            vol_path = os.path.join("/Volumes", vol)
            if os.path.isdir(vol_path):
                search_roots.append(vol_path)

    matches = []
    seen = set()

    # Quick search: walk 3 levels deep in common locations
    for root in search_roots:
        if not os.path.isdir(root):
            continue
        try:
            for dirpath, dirnames, _ in os.walk(root):
                # Limit depth to 4 levels
                depth = dirpath.replace(root, "").count(os.sep)
                if depth > 4:
                    dirnames.clear()
                    continue
                # Skip hidden dirs and common noise
                dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "Library", "Applications")]
                for d in dirnames:
                    if d.lower() == folder_name.lower():
                        full = os.path.join(dirpath, d)
                        if full not in seen:
                            seen.add(full)
                            matches.append(full)
                            if len(matches) >= 10:
                                return {"matches": matches}
        except PermissionError:
            continue

    # Fallback: use mdfind on macOS (Spotlight)
    if not matches:
        try:
            result = subprocess.run(
                ["mdfind", f"kMDItemFSName == '{folder_name}' && kMDItemContentType == 'public.folder'"],
                capture_output=True, text=True, timeout=5,
            )
            for line in result.stdout.strip().split("\n"):
                line = line.strip()
                if line and os.path.isdir(line) and line not in seen:
                    # Skip system folders
                    if "/Library/" in line or "/Applications/" in line:
                        continue
                    seen.add(line)
                    matches.append(line)
                    if len(matches) >= 10:
                        break
        except Exception:
            pass

    return {"matches": matches}


@app.get("/api/browse")
async def browse_folder(path: str = "") -> dict:
    """Browse folders on the server filesystem."""
    import os
    target = path or os.path.expanduser("~")
    target = os.path.expanduser(target)

    if not os.path.isdir(target):
        return {"error": f"Not a directory: {target}", "current": target, "parent": "", "dirs": []}

    parent = os.path.dirname(target)
    dirs = []
    try:
        for entry in sorted(os.scandir(target), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": os.path.join(target, entry.name)})
    except PermissionError:
        pass

    return {"current": target, "parent": parent, "dirs": dirs}


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


async def _execute_pipeline(task: str, working_dir: str, config_path: str | None, provider: str = "claude") -> None:
    """Run the full pipeline with event broadcasting."""
    global _current_run

    from openseed_core.config import load_config
    from openseed_brain import compile_graph, initial_state

    cfg = load_config(Path(config_path) if config_path else None)

    state = initial_state(task=task, working_dir=str(Path(working_dir).resolve()), provider=provider)
    graph = compile_graph()

    await _broadcast({"type": "pipeline.start", "node": "brain", "data": {"task": task, "working_dir": working_dir}})

    try:
        # Use astream to get node-by-node events in real time
        final_state = None
        async for event in graph.astream(state):
            for node_name, output in event.items():
                # Broadcast node start
                await _broadcast({"type": "node.start", "node": node_name, "data": {}})

                # Broadcast all messages from this node
                for msg in output.get("messages", []):
                    await _broadcast({"type": "node.log", "node": node_name, "data": {"message": str(msg)}})
                    if _current_run:
                        _current_run["messages"].append(f"[{node_name}] {str(msg)[:500]}")

                # Broadcast plan details
                if output.get("plan"):
                    p = output["plan"]
                    await _broadcast({"type": "node.plan", "node": node_name, "data": {
                        "summary": p.summary,
                        "tasks": len(p.tasks),
                        "files": len(p.file_manifest),
                        "file_list": [f.path for f in p.file_manifest],
                    }})

                # Broadcast implementation details
                if output.get("implementation"):
                    impl = output["implementation"]
                    await _broadcast({"type": "node.implementation", "node": node_name, "data": {
                        "summary": impl.summary[:500],
                        "files_created": impl.files_created,
                        "files_modified": impl.files_modified,
                    }})

                # Broadcast QA result
                if output.get("qa_result"):
                    qa = output["qa_result"]
                    await _broadcast({"type": "node.qa", "node": node_name, "data": {
                        "verdict": qa.verdict.value,
                        "findings": len(qa.findings),
                        "synthesis": qa.synthesis,
                    }})

                # Broadcast deploy result
                if output.get("deploy_result"):
                    d = output["deploy_result"]
                    await _broadcast({"type": "node.deploy", "node": node_name, "data": {
                        "success": d.success,
                        "channel": d.channel,
                        "message": d.message,
                    }})

                # Broadcast retry count
                if "retry_count" in output:
                    await _broadcast({"type": "node.retry", "node": node_name, "data": {"retry_count": output["retry_count"]}})

                # Broadcast errors
                for err in output.get("errors", []):
                    await _broadcast({"type": "node.error", "node": node_name, "data": {"message": err.message, "severity": err.severity.value}})

                # Node complete
                await _broadcast({"type": "node.complete", "node": node_name, "data": {}})

                final_state = output

        if _current_run:
            _current_run["status"] = "completed"
        await _broadcast({"type": "pipeline.complete", "node": "brain", "data": {"status": "completed"}})
    except Exception as e:
        if _current_run:
            _current_run["status"] = "failed"
            _current_run["error"] = str(e)
        await _broadcast({"type": "pipeline.fail", "node": "brain", "data": {"error": str(e), "message": str(e)}})
    finally:
        pass  # No local event_bus in this function; broadcasting uses _broadcast()
