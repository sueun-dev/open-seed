"""
Diagram node — Auto-generate architecture diagrams from codebase.

Reads the project folder, selects key files within a token budget,
sends to Claude Opus for Mermaid diagram generation, then fixes
any Mermaid cycle issues.

Adapted from Swark (architecture patterns) + mcp-mermaid (URL generation).
Rewritten for Python + our OAuth-based Claude agent.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import zlib

logger = logging.getLogger(__name__)

# ─── Config ─────────────────────────────────────────────────────────────────

MAX_TOKEN_BUDGET = 80_000  # ~80K tokens for file content
MAX_SINGLE_FILE = 8_000  # ~2K tokens per file
MAX_FILES = 100
FILE_SEPARATOR = "=========="

SOURCE_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".vue",
    ".svelte",
    ".go",
    ".rs",
    ".java",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".css",
    ".scss",
    ".html",
    ".sql",
    ".graphql",
    ".prisma",
    ".yaml",
    ".yml",
    ".toml",
    ".json",
}

SKIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "vendor",
    "target",
    ".svelte-kit",
    "research",
    "tests",
    "test",
}

SKIP_FILES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
    "composer.lock",
}

# Config files get priority (always read first)
CONFIG_FILES = {
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
    "tsconfig.json",
    "vite.config.ts",
    "next.config.js",
    "next.config.ts",
    ".env.example",
    "schema.prisma",
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
            elif fname in (
                "main.py",
                "app.py",
                "index.ts",
                "index.js",
                "server.py",
                "App.tsx",
                "App.jsx",
                "main.ts",
                "main.tsx",
            ):
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

    logger.info(
        "Diagram scan: %d files selected (%.1fK chars) from %d candidates",
        len(selected),
        budget_used / 1000,
        len(candidates),
    )
    return selected


def _smart_truncate(content: str, max_chars: int) -> str:
    """Keep head (imports/config) + key signatures."""
    if len(content) <= max_chars:
        return content
    lines = content.splitlines()
    head = lines[:25]
    sig_patterns = (
        "def ",
        "async def ",
        "class ",
        "export ",
        "function ",
        "interface ",
        "type ",
        "const ",
        "router.",
        "@app.",
        "CREATE TABLE",
        "model ",
        "schema ",
    )
    sigs = [ln for ln in lines[25:] if any(ln.lstrip().startswith(p) for p in sig_patterns)]
    result = "\n".join(head)
    if sigs:
        result += "\n\n# ... key signatures:\n" + "\n".join(sigs[:40])
    return result[:max_chars]


# ─── Mermaid Generation ──────────────────────────────────────────────────────


SYSTEM_PROMPT = """You are an expert software architect creating a clean, professional Mermaid.js architecture diagram.

## Output
- Output ONLY a ```mermaid code block. No explanations before or after.

## Layout
- Use `graph TD` for architecture/hierarchy. Use `graph LR` only for simple linear pipelines.
- Use `subgraph` to group related components (Frontend, Backend, Database, Infrastructure, etc.).
- Maximum 3 levels of subgraph nesting.

## Node Rules (CRITICAL)
- 8-20 nodes total. This is the sweet spot. Compress small files into one group node.
- Meaningful IDs: `authService`, `orderDB`, `reactApp` — NEVER use `A`, `B`, `C`.
- All labels MUST use bracket syntax: `authService["Auth Service"]` — NEVER bare text.
- Labels under 40 characters. Use `<br/>` for line breaks, NEVER `\\n`.
- NEVER use ( ) in labels. Use `["..."]` for rectangles, `[("...")]` for circles.

## Edge Rules
- Verb-first edge labels: `-->|sends auth token|`, `-->|queries users|`, `-->|triggers rebuild|`.
- Label every edge — no unlabeled arrows.
- Edge labels under 6 words.

## Styling
- Define category styles with classDef at the end:
  classDef frontend fill:#1e3a5f,stroke:#3b82f6,color:#e0e0e0
  classDef backend fill:#1a2e1a,stroke:#4ade80,color:#e0e0e0
  classDef database fill:#2e1a2e,stroke:#c084fc,color:#e0e0e0
  classDef infra fill:#2e2e1a,stroke:#facc15,color:#e0e0e0
  classDef external fill:#1a1a1a,stroke:#666,color:#999
- Apply styles: `class authService,userAPI backend`

## Quality
- One concept per diagram. Show architecture, not implementation details.
- Every node must have at least one connection — no orphans.
- Subgraph names must differ from any node ID inside them.
- Show data stores (DB, cache, queue) as cylindrical: `db[("PostgreSQL")]`."""


VERIFY_PROMPT = """You are a senior software architect reviewing a Mermaid architecture diagram.

The diagram was generated from a real codebase. Verify it for:
1. COMPLETENESS: Are all major modules, services, and data stores shown?
2. ACCURACY: Do the connections (API calls, imports, data flow) match the actual code?
3. MERMAID SYNTAX: Will this render without errors? Check for forbidden chars: {, }, :, (, )
4. MISSING LINKS: Are there any obvious connections between components that are missing?
5. SUBGRAPH CYCLES: Is any subgraph named the same as a node inside it?

Give a verdict:
VERDICT: PASS — diagram is accurate and complete
VERDICT: WARN — minor issues (cosmetic, non-critical missing details)
VERDICT: BLOCK — major issues (wrong connections, missing critical modules, syntax errors)

Then output the diagram (fixed if needed) inside a ```mermaid code block.
Format: VERDICT line first, then the mermaid block."""

MAX_VERIFY_ROUNDS = 3


async def generate_diagram(working_dir: str, generator: str = "claude", verifier: str = "gpt") -> dict:
    """
    Generate a Mermaid architecture diagram for the project.

    Args:
        generator: "claude" or "gpt" — who creates the diagram
        verifier: "claude" or "gpt" — who verifies it
    Returns: {mermaid: str, share_url: str, files_scanned: int}
    """
    from openseed_brain.progress import emit_progress

    async def _emit(msg: str, **kw):
        await emit_progress("diagram.progress", node="diagram", message=msg, **kw)

    await _emit("Scanning project files...")
    files = scan_project_files(working_dir)
    if not files:
        return {"mermaid": "", "share_url": "", "files_scanned": 0, "error": "No source files found"}

    await _emit(f"Found {len(files)} source files ({sum(len(f['content']) for f in files) // 1000}K chars)")

    file_block = "\n".join(f"{f['path']}\n{f['content']}\n{FILE_SEPARATOR}" for f in files)

    # ── Step 1: Generate diagram ──
    gen_label = "Claude Opus" if generator == "claude" else "GPT (Codex)"
    await _emit(f"{gen_label} analyzing architecture...", step="generate")

    if generator == "claude":
        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        response = await agent.invoke(
            prompt=f"Analyze this codebase and create an architecture diagram.\n\n{file_block}",
            system_prompt=SYSTEM_PROMPT,
            model="opus",
            max_turns=1,
        )
    else:
        from openseed_codex.agent import CodexAgent

        codex_gen = CodexAgent()
        response = await codex_gen.invoke(
            prompt=f"{SYSTEM_PROMPT}\n\nAnalyze this codebase and create an architecture diagram.\n\n{file_block}",
        )

    mermaid_code = _extract_mermaid(response.text)
    if not mermaid_code:
        logger.warning("No mermaid block found in diagram response. Preview: %s", response.text[:500])
        await _emit("Failed to generate diagram", step="error")
        return {"mermaid": "", "share_url": "", "files_scanned": len(files), "error": "Failed to generate diagram"}

    await _emit(f"{gen_label} generated diagram. Starting verification...", step="generated")

    ver_label = "Claude" if verifier == "claude" else "Codex (OpenAI)"

    # ── Step 2: Verify → Fix loop (max 3 rounds) ──
    warn_count = 0
    for round_num in range(1, MAX_VERIFY_ROUNDS + 1):
        await _emit(f"{ver_label} verifying... round {round_num}/{MAX_VERIFY_ROUNDS}", step="verify", round=round_num)

        verdict, fixed_code = await _run_verify(verifier, file_block, mermaid_code)

        if verdict == "pass":
            await _emit(f"{ver_label}: PASS on round {round_num}", step="pass", round=round_num)
            if fixed_code:
                mermaid_code = fixed_code
            break

        if verdict == "warn":
            warn_count += 1
            if fixed_code:
                mermaid_code = fixed_code
            if warn_count >= 2:
                await _emit(f"{ver_label}: WARN x{warn_count}, accepting diagram", step="warn_accept")
                break
            await _emit(f"{ver_label}: WARN — {gen_label} fixing issues...", step="fix", round=round_num)
            mermaid_code = await _run_fix(generator, file_block, mermaid_code, fixed_code or mermaid_code)
            continue

        # BLOCK
        await _emit(f"{ver_label}: BLOCK — {gen_label} rewriting diagram...", step="fix", round=round_num)
        mermaid_code = await _run_fix(generator, file_block, mermaid_code, fixed_code or mermaid_code)

    # ── Step 3: Deterministic cycle fix ──
    await _emit("Fixing subgraph cycles...", step="cycles")
    mermaid_code = fix_mermaid_cycles(mermaid_code)

    share_url = create_mermaid_url(mermaid_code)

    return {
        "mermaid": mermaid_code,
        "share_url": share_url,
        "files_scanned": len(files),
    }


async def _run_verify(provider: str, file_block: str, mermaid_code: str) -> tuple[str, str]:
    """
    Verify diagram using specified provider. Returns (verdict, fixed_code).
    """
    prompt = f"{VERIFY_PROMPT}\n\nCodebase files:\n{file_block}\n\nDiagram to verify:\n```mermaid\n{mermaid_code}\n```"
    try:
        if provider == "claude":
            from openseed_claude.agent import ClaudeAgent

            agent = ClaudeAgent()
            response = await agent.invoke(prompt=prompt, model="opus", max_turns=1)
        else:
            from openseed_codex.agent import CodexAgent

            agent = CodexAgent()
            response = await agent.invoke(prompt=prompt)
        verdict = _parse_verdict(response.text)
        fixed = _extract_mermaid(response.text)
        return verdict, fixed
    except Exception as exc:
        logger.warning("Verify (%s) failed: %s — treating as PASS", provider, exc)
        return "pass", ""


async def _run_fix(provider: str, file_block: str, original: str, verifier_version: str) -> str:
    """Fix diagram using specified provider."""
    fix_prompt = f"""The diagram verifier found issues. Fix them.

Original diagram:
```mermaid
{original}
```

Verifier's version (may have partial fixes):
```mermaid
{verifier_version}
```

Codebase files for reference:
{file_block}

Output ONLY the corrected ```mermaid code block. Be thorough but do NOT over-engineer."""

    try:
        if provider == "claude":
            from openseed_claude.agent import ClaudeAgent

            agent = ClaudeAgent()
            response = await agent.invoke(prompt=fix_prompt, system_prompt=SYSTEM_PROMPT, model="opus", max_turns=1)
        else:
            from openseed_codex.agent import CodexAgent

            agent = CodexAgent()
            response = await agent.invoke(prompt=f"{SYSTEM_PROMPT}\n\n{fix_prompt}")
        fixed = _extract_mermaid(response.text)
        return fixed if fixed else original
    except Exception as exc:
        logger.warning("Fix (%s) failed: %s — returning original", provider, exc)
        return original


def _parse_verdict(text: str) -> str:
    """Extract VERDICT from Codex response. Default to 'warn' if ambiguous."""
    for line in text.splitlines():
        upper = line.strip().upper()
        if "VERDICT:" in upper:
            if "PASS" in upper:
                return "pass"
            if "BLOCK" in upper:
                return "block"
            if "WARN" in upper:
                return "warn"
    return "warn"


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
            rest = stripped[len("subgraph") :].strip()
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
