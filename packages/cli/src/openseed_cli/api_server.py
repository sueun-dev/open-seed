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
    clarification_answers: list[str] = []  # Answers to intake questions


class IntakeRequest(BaseModel):
    task: str
    working_dir: str = "."
    provider: str = "claude"
    clarification_answers: list[str] = []
    clarification_questions: list[dict] = []


class ChatRequest(BaseModel):
    message: str
    working_dir: str = "."
    session_id: str | None = None
    provider: str = "claude"  # "claude", "codex", "both"
    viewing_files: list[str] = []  # Files the user has open in the code viewer
    active_file: str | None = None  # File the user is currently looking at


class MemorySearchRequest(BaseModel):
    query: str
    limit: int = 10


# ─── REST Endpoints ──────────────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": "2.0.0-alpha.0"}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> dict:
    """Pair Mode: direct CLI call with provider selection + file change detection."""
    import os
    import hashlib

    await _broadcast({"type": "node.start", "node": "pair", "data": {"provider": req.provider}})

    def _snapshot(d: str) -> dict[str, str]:
        skip = {"node_modules", ".git", "__pycache__", ".venv", "dist", "build"}
        hashes: dict[str, str] = {}
        try:
            for root, dirs, files in os.walk(d):
                dirs[:] = [x for x in dirs if x not in skip]
                for f in files:
                    path = os.path.join(root, f)
                    try:
                        with open(path, "rb") as fh:
                            hashes[os.path.relpath(path, d)] = hashlib.md5(fh.read()).hexdigest()
                    except OSError:
                        pass
        except OSError:
            pass
        return hashes

    before = _snapshot(req.working_dir)

    try:
        if req.provider == "codex":
            response_text, session = await _chat_codex(req)
        elif req.provider == "both":
            response_text, session = await _chat_both(req)
        else:
            response_text, session = await _chat_claude(req)

        # Detect file changes
        after = _snapshot(req.working_dir)
        files_created = [f for f in after if f not in before]
        files_modified = [f for f in after if f in before and after[f] != before[f]]

        await _broadcast({"type": "node.log", "node": "pair", "data": {"message": response_text}})

        if files_created or files_modified:
            await _broadcast({"type": "node.implementation", "node": "pair", "data": {
                "summary": response_text[:300],
                "files_created": files_created,
                "files_modified": files_modified,
            }})

        await _broadcast({"type": "pipeline.complete", "node": "pair", "data": {"status": "completed"}})

        return {
            "response": response_text,
            "session_id": session,
            "files_created": files_created,
            "files_modified": files_modified,
        }
    except Exception as e:
        await _broadcast({"type": "pipeline.fail", "node": "pair", "data": {"error": str(e)}})
        return {"response": f"Error: {e}", "session_id": None, "files_created": [], "files_modified": []}


def _build_chat_prompt(req: ChatRequest) -> str:
    """Build prompt with viewing context."""
    parts = []
    if req.active_file:
        parts.append(f"[User is currently viewing: {req.active_file}]")
    if req.viewing_files:
        other = [f for f in req.viewing_files if f != req.active_file]
        if other:
            parts.append(f"[Also open: {', '.join(other)}]")
    parts.append(req.message)
    return "\n".join(parts)


async def _chat_claude(req: ChatRequest) -> tuple[str, str | None]:
    """Direct Claude CLI call."""
    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()
    response = await agent.invoke(
        prompt=_build_chat_prompt(req),
        model="sonnet",
        working_dir=req.working_dir,
        max_turns=20,
        session_id=req.session_id,
        continue_session=bool(req.session_id),
    )
    return response.text, response.session_id or None


async def _chat_codex(req: ChatRequest) -> tuple[str, str | None]:
    """Direct Codex CLI call."""
    try:
        from openseed_codex.agent import CodexAgent
        agent = CodexAgent()
        response = await agent.invoke(
            prompt=_build_chat_prompt(req),
            working_dir=req.working_dir,
        )
        return response.text, None
    except Exception as e:
        return f"Codex error: {e}\n\nCodex CLI may require a terminal. Try using Claude or Both mode instead.", None


async def _chat_both(req: ChatRequest) -> tuple[str, str | None]:
    """Claude + Codex debate: both analyze, then best approach executes. User sees every step."""
    from openseed_claude.agent import ClaudeAgent
    from openseed_codex.agent import CodexAgent

    claude_agent = ClaudeAgent()
    codex_agent = CodexAgent()

    # Step 1: Both analyze in parallel
    await _broadcast({"type": "debate.start", "node": "pair", "data": {
        "step": "analyzing", "message": "Claude and Codex are both analyzing your request..."}})

    chat_prompt = _build_chat_prompt(req)

    claude_task = claude_agent.invoke(
        prompt=chat_prompt,
        model="sonnet",
        working_dir=req.working_dir,
        max_turns=10,
    )

    # Codex may fail in non-terminal environments — handle gracefully
    codex_text = ""
    try:
        codex_task = codex_agent.invoke(
            prompt=chat_prompt,
            working_dir=req.working_dir,
        )
        claude_analysis, codex_analysis = await asyncio.gather(claude_task, codex_task)
        codex_text = codex_analysis.text
    except Exception:
        claude_analysis = await claude_task
        codex_text = "(Codex unavailable)"

    # Step 2: Show both analyses to user
    await _broadcast({"type": "debate.opinion", "node": "pair", "data": {
        "speaker": "claude", "message": claude_analysis.text[:2000]}})

    await _broadcast({"type": "debate.opinion", "node": "pair", "data": {
        "speaker": "codex", "message": codex_text[:2000]}})

    # Step 3: Opus judges (neutral arbiter, not Claude judging itself)
    await _broadcast({"type": "debate.deciding", "node": "pair", "data": {
        "step": "deciding", "message": "Opus is judging both approaches..."}})

    judge = ClaudeAgent()
    response = await judge.invoke(
        prompt=f"""You are a neutral judge. Two AI engineers (Claude and Codex) analyzed the same task independently.
Review both approaches objectively and execute the better one.

TASK: {req.message}

ENGINEER A:
{claude_analysis.text[:1500]}

ENGINEER B:
{codex_text[:1500]}

Instructions:
1. Compare both approaches objectively. State which is better and why (1-2 sentences).
2. Execute the winning approach. Actually make the changes - read files, write files, run commands.
3. If both have good ideas, combine the best parts.

Start with "VERDICT: [Engineer A/Engineer B/Combined] because..." then execute.""",
        model="opus",
        working_dir=req.working_dir,
        max_turns=20,
    )

    # Step 4: Show verdict
    verdict_line = response.text.split("\n")[0] if response.text else ""
    await _broadcast({"type": "debate.verdict", "node": "pair", "data": {
        "verdict": verdict_line, "message": response.text[:500]}})

    # Build combined response showing the full debate
    full_response = f"""## Debate

**🟣 Claude's Analysis:**
{claude_analysis.text[:1000]}

**🟢 Codex's Analysis:**
{codex_text[:1000]}

## Decision & Execution

{response.text}"""

    return full_response, response.session_id or None


@app.post("/api/terminal")
async def run_terminal(body: dict) -> dict:
    """Run a shell command in the working directory with streaming support."""
    import subprocess
    import os

    cmd = body.get("command", "")
    cwd = body.get("working_dir", ".")
    timeout = body.get("timeout", 120)

    if not cmd:
        return {"output": "", "exit_code": 1}

    # Expand ~ in cwd
    cwd = os.path.expanduser(cwd)

    try:
        result = subprocess.run(
            cmd, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
        )
        return {
            "output": (result.stdout + result.stderr)[:50000],
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"output": f"Command timed out ({timeout}s limit)", "exit_code": 124}
    except Exception as e:
        return {"output": str(e), "exit_code": 1}


# Persistent shell sessions for terminal
_shell_sessions: dict[str, Any] = {}


@app.websocket("/ws/terminal")
async def ws_terminal(ws: WebSocket) -> None:
    """Persistent terminal session via WebSocket. Supports cd, env vars, long-running commands."""
    import os
    import subprocess
    import signal

    await ws.accept()

    working_dir = os.path.expanduser("~")
    current_process: subprocess.Popen | None = None

    try:
        while True:
            data = json.loads(await ws.receive_text())
            msg_type = data.get("type", "")

            if msg_type == "init":
                working_dir = data.get("working_dir", working_dir)
                await ws.send_text(json.dumps({
                    "type": "ready", "cwd": working_dir,
                }))

            elif msg_type == "command":
                cmd = data.get("command", "")
                if not cmd:
                    continue

                # Handle cd specially — update working_dir for next commands
                stripped = cmd.strip()
                if stripped == "cd" or stripped.startswith("cd "):
                    target = stripped[3:].strip() if stripped.startswith("cd ") else os.path.expanduser("~")
                    target = target.strip("'\"")
                    if target == "-":
                        pass  # skip cd -
                    else:
                        new_dir = os.path.join(working_dir, target) if not os.path.isabs(target) else target
                        new_dir = os.path.normpath(new_dir)
                        if os.path.isdir(new_dir):
                            working_dir = new_dir
                            await ws.send_text(json.dumps({
                                "type": "output", "data": f"cd: {working_dir}\n",
                            }))
                        else:
                            await ws.send_text(json.dumps({
                                "type": "output", "data": f"cd: no such directory: {new_dir}\n",
                            }))
                    await ws.send_text(json.dumps({
                        "type": "exit", "code": 0, "cwd": working_dir,
                    }))
                    continue

                # Run command as subprocess
                try:
                    current_process = subprocess.Popen(
                        cmd, shell=True, cwd=working_dir,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, bufsize=1,
                        env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
                    )

                    # Stream output line by line
                    for line in iter(current_process.stdout.readline, ""):
                        await ws.send_text(json.dumps({
                            "type": "output", "data": line,
                        }))

                    current_process.wait()
                    exit_code = current_process.returncode

                except Exception as e:
                    await ws.send_text(json.dumps({
                        "type": "output", "data": f"Error: {e}\n",
                    }))
                    exit_code = 1
                finally:
                    current_process = None
                    await ws.send_text(json.dumps({
                        "type": "exit", "code": exit_code, "cwd": working_dir,
                    }))

            elif msg_type == "kill":
                if current_process and current_process.poll() is None:
                    try:
                        os.killpg(os.getpgid(current_process.pid), signal.SIGTERM)
                    except (ProcessLookupError, OSError):
                        try:
                            current_process.kill()
                        except Exception:
                            pass
                    await ws.send_text(json.dumps({
                        "type": "output", "data": "^C\n",
                    }))

    except WebSocketDisconnect:
        if current_process and current_process.poll() is None:
            try:
                current_process.kill()
            except Exception:
                pass


@app.get("/api/files")
async def list_files(path: str = "") -> dict:
    """List files as a tree for the code viewer."""
    import os

    target = path or os.path.expanduser("~")
    if not os.path.isdir(target):
        return {"tree": []}

    skip = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".next", ".agent"}

    def build_tree(dir_path: str, depth: int = 0) -> list:
        if depth > 4:
            return []
        nodes = []
        try:
            entries = sorted(os.scandir(dir_path), key=lambda e: (not e.is_dir(), e.name.lower()))
            for entry in entries:
                if entry.name.startswith(".") and entry.name != ".env.example":
                    continue
                if entry.name in skip:
                    continue
                node = {"name": entry.name, "path": entry.path, "isDir": entry.is_dir()}
                if entry.is_dir():
                    node["children"] = build_tree(entry.path, depth + 1)
                nodes.append(node)
        except PermissionError:
            pass
        return nodes

    return {"tree": build_tree(target)}


@app.get("/api/file")
async def read_file(path: str) -> dict:
    """Read a single file's content for the code viewer."""
    import os

    if not os.path.isfile(path):
        return {"content": "", "error": "File not found"}

    # Limit to 500KB
    try:
        size = os.path.getsize(path)
        if size > 500_000:
            return {"content": "(File too large to display)", "error": "File exceeds 500KB"}
        with open(path, encoding="utf-8", errors="replace") as f:
            return {"content": f.read()}
    except Exception as e:
        return {"content": "", "error": str(e)}


@app.post("/api/intake")
async def run_intake(req: IntakeRequest) -> dict:
    """Run intake analysis. Phase 1: questions. Phase 2 (with answers): plan."""
    from openseed_brain.nodes.intake import intake_node
    from openseed_brain.state import initial_state

    state = initial_state(task=req.task, working_dir=req.working_dir, provider=req.provider)

    # Pass answers and questions for Phase 2 (plan generation)
    if req.clarification_answers:
        state["clarification_answers"] = req.clarification_answers
        # Pass question texts so intake can reference them
        state["clarification_questions"] = [
            q.get("question", q) if isinstance(q, dict) else q
            for q in req.clarification_questions
        ]

    result = await intake_node(state)

    return {
        "intake_analysis": result.get("intake_analysis", {}),
        "clarification_questions": result.get("clarification_questions", []),
        "skip_planning": result.get("skip_planning", False),
    }


@app.post("/api/run")
async def start_run(req: RunRequest) -> dict:
    """Start a pipeline run. Events streamed via WebSocket."""
    global _current_run

    if _current_run and _current_run.get("status") == "running":
        return JSONResponse(status_code=409, content={"error": "Pipeline already running"})

    _current_run = {"task": req.task, "status": "running", "messages": []}

    # Run pipeline in background
    asyncio.create_task(_execute_pipeline(
        req.task, req.working_dir, req.config_path, req.provider,
        clarification_answers=req.clarification_answers,
    ))

    return {"status": "started", "task": req.task}


@app.get("/api/status")
async def get_status() -> dict:
    if not _current_run:
        return {"status": "idle"}
    return _current_run


@app.get("/api/auth/status")
async def auth_status() -> dict:
    """Check authentication status for Claude and OpenAI."""
    from openseed_core.auth.claude import check_claude_auth
    from openseed_core.auth.openai import check_openai_auth

    claude = check_claude_auth()
    openai = check_openai_auth()

    return {
        "claude": {
            "installed": claude.installed,
            "authenticated": claude.authenticated,
            "error": claude.error,
        },
        "openai": {
            "installed": openai.installed,
            "authenticated": openai.authenticated,
            "error": openai.error,
        },
    }


@app.post("/api/auth/login")
async def auth_login(body: dict) -> dict:
    """Trigger OAuth login for a provider. Runs CLI auth command."""
    import subprocess

    provider = body.get("provider", "")

    if provider == "claude":
        from openseed_core.auth.claude import get_claude_cli_path
        cli = get_claude_cli_path()
        if not cli:
            return {"status": "error", "message": "Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code"}
        try:
            result = subprocess.run([cli, "auth", "login"], capture_output=True, text=True, timeout=60)
            return {"status": "ok" if result.returncode == 0 else "error", "message": result.stdout or result.stderr}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    elif provider == "openai":
        from openseed_core.auth.openai import get_codex_cli_path
        cli = get_codex_cli_path()
        if not cli:
            return {"status": "error", "message": "Codex CLI not installed. Run: npm install -g @openai/codex"}
        try:
            result = subprocess.run([cli, "auth", "login"], capture_output=True, text=True, timeout=60)
            return {"status": "ok" if result.returncode == 0 else "error", "message": result.stdout or result.stderr}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    return {"status": "error", "message": f"Unknown provider: {provider}"}


@app.get("/api/config")
async def get_config() -> dict:
    from openseed_core.config import load_config
    cfg = load_config()
    return cfg.model_dump()


@app.post("/api/config")
async def save_config(body: dict) -> dict:
    """Save config to ~/.openseed/config.yaml."""
    import os
    config_dir = os.path.expanduser("~/.openseed")
    os.makedirs(config_dir, exist_ok=True)
    config_path = os.path.join(config_dir, "config.yaml")

    import yaml
    with open(config_path, "w") as f:
        yaml.safe_dump(body, f, default_flow_style=False, sort_keys=False)

    return {"status": "saved", "path": config_path}


@app.get("/api/resolve-folder")
async def resolve_folder(name: str, children: str = "") -> dict:
    """Resolve a folder name to its full absolute path by searching common locations.

    Args:
        name: Folder name or absolute path.
        children: Comma-separated list of top-level child names (for disambiguation).
    """
    import os
    import subprocess

    folder_name = name.strip().strip("/")
    if not folder_name:
        return {"error": "Empty folder name", "matches": []}

    # If already absolute path, just verify it exists
    if name.startswith("/") and os.path.isdir(name):
        return {"matches": [name]}

    # Parse child names for disambiguation
    child_set = set(c.strip() for c in children.split(",") if c.strip()) if children else set()

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

    # Quick search: walk 4 levels deep in common locations
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
                            if len(matches) >= 20:
                                break
                if len(matches) >= 20:
                    break
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
                    if "/Library/" in line or "/Applications/" in line:
                        continue
                    seen.add(line)
                    matches.append(line)
                    if len(matches) >= 20:
                        break
        except Exception:
            pass

    # Disambiguate using child names if provided
    if child_set and len(matches) > 1:
        scored = []
        for m in matches:
            try:
                actual_children = set(os.listdir(m))
                overlap = len(child_set & actual_children)
                scored.append((overlap, m))
            except OSError:
                scored.append((0, m))
        scored.sort(key=lambda x: -x[0])
        matches = [m for _, m in scored]

    return {"matches": matches[:10]}


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


async def _execute_pipeline(
    task: str, working_dir: str, config_path: str | None,
    provider: str = "claude", clarification_answers: list[str] | None = None,
) -> None:
    """Run the full pipeline with event broadcasting."""
    global _current_run

    from openseed_core.config import load_config
    from openseed_brain import compile_graph, initial_state

    cfg = load_config(Path(config_path) if config_path else None)

    state = initial_state(task=task, working_dir=str(Path(working_dir).resolve()), provider=provider)
    state["max_retries"] = cfg.sentinel.max_retries
    if clarification_answers:
        state["clarification_answers"] = clarification_answers
    graph = compile_graph(
        checkpoint_dir=str(Path(str(cfg.brain.checkpoint_dir)).expanduser()),
    )

    await _broadcast({"type": "pipeline.start", "node": "brain", "data": {"task": task, "working_dir": working_dir}})

    config = {"configurable": {"thread_id": f"web-{id(state)}-{__import__('time').time()}"}}

    try:
        # Use astream to get node-by-node events in real time
        final_state = None
        async for event in graph.astream(state, config=config):
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
