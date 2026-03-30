"""
Diagram node — Auto-generate architecture diagrams from codebase.

Reads the project folder, selects key files within a token budget,
sends to Claude Opus for Mermaid diagram generation, then fixes
any Mermaid cycle issues.

Adapted from Swark (architecture patterns) + mcp-mermaid (URL generation).
Rewritten for Python + our OAuth-based Claude agent.
"""

from __future__ import annotations

import logging
import os
import zlib
import base64
import json

logger = logging.getLogger(__name__)

# ─── Config ─────────────────────────────────────────────────────────────────

MAX_TOKEN_BUDGET = 80_000  # ~80K tokens for file content
MAX_SINGLE_FILE = 8_000  # ~2K tokens per file
MAX_FILES = 100
FILE_SEPARATOR = "=========="

SOURCE_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte",
    ".go", ".rs", ".java", ".rb", ".php", ".swift", ".kt",
    ".css", ".scss", ".html", ".sql", ".graphql", ".prisma",
    ".yaml", ".yml", ".toml", ".json",
}

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "dist", "build",
    ".next", ".nuxt", "coverage", ".tox", ".mypy_cache", ".pytest_cache",
    "vendor", "target", ".svelte-kit",
}

SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock",
    "poetry.lock", "Cargo.lock", "composer.lock",
}

# Config files get priority (always read first)
CONFIG_FILES = {
    "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
    "docker-compose.yml", "docker-compose.yaml", "Dockerfile",
    "tsconfig.json", "vite.config.ts", "next.config.js", "next.config.ts",
    ".env.example", "schema.prisma",
}


# ─── File Scanner ────────────────────────────────────────────────────────────


def scan_project_files(working_dir: str) -> list[dict]:
    """
    Scan project directory, select files within token budget.
    Returns list of {path, content} sorted by priority.

    Priority: config files first, then entry points, then by depth (shallow first).
    """
    if not os.path.isdir(working_dir):
        return []

    candidates: list[tuple[float, str, str]] = []  # (priority, rel_path, abs_path)

    for root, dirs, files in os.walk(working_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel_root = os.path.relpath(root, working_dir)

        for fname in files:
            if fname in SKIP_FILES:
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext not in SOURCE_EXTENSIONS:
                continue

            rel_path = fname if rel_root == "." else os.path.join(rel_root, fname)
            abs_path = os.path.join(root, fname)
            depth = rel_path.count(os.sep)

            # Priority scoring (lower = higher priority)
            priority = depth * 10.0
            if fname in CONFIG_FILES:
                priority = -100.0  # Config files first
            elif fname in ("main.py", "app.py", "index.ts", "index.js", "server.py",
                           "App.tsx", "App.jsx", "main.ts", "main.tsx"):
                priority = -50.0  # Entry points second

            candidates.append((priority, rel_path, abs_path))

    candidates.sort(key=lambda x: x[0])

    # Read files within token budget
    selected: list[dict] = []
    budget_used = 0

    for _priority, rel_path, abs_path in candidates[:MAX_FILES]:
        if budget_used >= MAX_TOKEN_BUDGET:
            break
        try:
            with open(abs_path, encoding="utf-8", errors="ignore") as f:
                content = f.read(MAX_SINGLE_FILE + 500)
            if len(content) > MAX_SINGLE_FILE:
                content = _smart_truncate(content, MAX_SINGLE_FILE)
            char_count = len(content)
            budget_used += char_count
            selected.append({"path": rel_path, "content": content})
        except OSError:
            continue

    logger.info("Diagram scan: %d files selected (%.1fK chars) from %d candidates",
                len(selected), budget_used / 1000, len(candidates))
    return selected


def _smart_truncate(content: str, max_chars: int) -> str:
    """Keep head (imports/config) + key signatures."""
    if len(content) <= max_chars:
        return content
    lines = content.splitlines()
    head = lines[:25]
    sig_patterns = ("def ", "async def ", "class ", "export ", "function ",
                    "interface ", "type ", "const ", "router.", "@app.",
                    "CREATE TABLE", "model ", "schema ")
    sigs = [ln for ln in lines[25:] if any(ln.lstrip().startswith(p) for p in sig_patterns)]
    result = "\n".join(head)
    if sigs:
        result += "\n\n# ... key signatures:\n" + "\n".join(sigs[:40])
    return result[:max_chars]


# ─── Mermaid Generation ──────────────────────────────────────────────────────


SYSTEM_PROMPT = """You are an expert software architect.
Given code files of a project, analyze the full architecture and create a comprehensive diagram.

Rules:
1. Output ONLY a Mermaid.js diagram inside a ```mermaid code block.
2. Use `graph TD` (top-down) layout.
3. Use `subgraph` for grouping related components (Frontend, Backend, Database, etc.).
4. Show ALL connections: API calls, data flow, imports, event flows.
5. For each component, show the key files/modules inside.
6. Avoid naming a subgraph and a node within it with the same name.
7. Avoid these characters in node labels: {, }, :, (, )
8. Use descriptive edge labels for connections (e.g. -->|REST API| or -->|WebSocket|).
9. Be thorough — show every major module, service, and data store.
10. No explanations, ONLY the mermaid diagram."""


async def generate_diagram(working_dir: str) -> dict:
    """
    Generate a Mermaid architecture diagram for the project.

    Returns: {mermaid: str, share_url: str, files_scanned: int}
    """
    files = scan_project_files(working_dir)
    if not files:
        return {"mermaid": "", "share_url": "", "files_scanned": 0, "error": "No source files found"}

    # Build file content block
    file_block = "\n".join(
        f"{f['path']}\n{f['content']}\n{FILE_SEPARATOR}"
        for f in files
    )

    from openseed_claude.agent import ClaudeAgent
    agent = ClaudeAgent()

    response = await agent.invoke(
        prompt=f"Analyze this codebase and create an architecture diagram.\n\n{file_block}",
        system_prompt=SYSTEM_PROMPT,
        model="sonnet",
        max_turns=1,
    )

    # Extract mermaid block
    mermaid_code = _extract_mermaid(response.text)
    if not mermaid_code:
        logger.warning("No mermaid block found in diagram response")
        return {"mermaid": "", "share_url": "", "files_scanned": len(files), "error": "Failed to generate diagram"}

    # Fix cycles
    mermaid_code = fix_mermaid_cycles(mermaid_code)

    # Generate share URL
    share_url = create_mermaid_url(mermaid_code)

    return {
        "mermaid": mermaid_code,
        "share_url": share_url,
        "files_scanned": len(files),
    }


def _extract_mermaid(text: str) -> str:
    """Extract mermaid code block from LLM response."""
    import re
    match = re.search(r"```mermaid\s*\n([\s\S]*?)```", text)
    if match:
        return match.group(1).strip()

    # Fallback: if response starts with graph/flowchart
    for prefix in ("graph ", "flowchart ", "sequenceDiagram", "classDiagram", "erDiagram"):
        if prefix in text:
            # Try to extract from first occurrence
            idx = text.index(prefix)
            return text[idx:].strip()
    return ""


# ─── Mermaid Cycle Detector (ported from Swark) ─────────────────────────────


def fix_mermaid_cycles(mermaid_code: str) -> str:
    """
    Detect and fix subgraph name cycles in Mermaid code.
    A cycle occurs when a subgraph contains a node with the same name.
    Fix: append underscore to the subgraph name.
    """
    lines = mermaid_code.splitlines()
    ancestors: list[dict] = []  # [{name, line_idx}]
    cyclic: dict[int, str] = {}  # {line_idx: name}

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith("subgraph"):
            rest = stripped[len("subgraph"):].strip()
            name = rest.split("[")[0].strip()
            # Check if this name matches any ancestor
            for anc in ancestors:
                if anc["name"] == name:
                    cyclic[anc["line_idx"]] = anc["name"]
            ancestors.append({"name": name, "line_idx": i})

        elif stripped == "end" or stripped.startswith("end "):
            if ancestors:
                ancestors.pop()

        else:
            # Check node names against ancestors
            node_name = stripped.split("[")[0].split("(")[0].split("{")[0]
            node_name = node_name.split("-->")[0].split("---")[0].split("-.")[0].strip()
            for anc in ancestors:
                if anc["name"] == node_name:
                    cyclic[anc["line_idx"]] = anc["name"]

    if not cyclic:
        return mermaid_code

    # Fix cycles
    for line_idx, name in cyclic.items():
        old_line = lines[line_idx]
        if "[" in old_line:
            # subgraph Name [Label] → subgraph Name_ [Label]
            before, after = old_line.split("subgraph", 1)
            parts = after.split("[", 1)
            lines[line_idx] = f"{before}subgraph {name}_[{parts[1]}" if len(parts) > 1 else f"{before}subgraph {name}_"
        else:
            lines[line_idx] = old_line.replace(f"subgraph {name}", f"subgraph {name}_")

    logger.info("Fixed %d Mermaid cycle(s)", len(cyclic))
    return "\n".join(lines)


# ─── Mermaid Share URL (ported from mcp-mermaid) ────────────────────────────


def create_mermaid_url(mermaid_code: str, variant: str = "svg", theme: str = "dark") -> str:
    """
    Create a shareable mermaid.ink URL.
    Encodes with pako deflate + base64url (same format as Mermaid Live Editor).
    """
    payload = json.dumps({"code": mermaid_code, "mermaid": {"theme": theme}})
    compressed = zlib.compress(payload.encode("utf-8"), level=9)
    # Convert to base64url (RFC 4648)
    encoded = base64.urlsafe_b64encode(compressed).rstrip(b"=").decode("ascii")
    return f"https://mermaid.ink/{variant}/pako:{encoded}"
