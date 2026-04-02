# AGENTS.md

> **Project:** Open Seed v2 — AI agent orchestration engine that fuses multiple LLMs (Claude, Codex) through a 7-system pipeline for autonomous software development.
> **Core constraint:** OAuth only — never use API keys. All decisions by AI (LLM calls) — no regex, no hardcoded rules.

## Key Commands
| Intent | Command | Notes |
|--------|---------|-------|
| Install | `uv sync` | uv workspace, never pip directly |
| Test | `pytest` | pytest-asyncio, asyncio_mode=auto |
| Test (single) | `pytest packages/<name>/tests/` | per-package |
| Lint | `ruff check .` | see pyproject.toml [tool.ruff] |
| Format | `ruff format .` | ruff handles both |
| Type check | `mypy packages/` | strict mode, see pyproject.toml [tool.mypy] |
| Dev (API) | `openseed serve` | FastAPI on port 8000 |
| Dev (Web) | `cd web && npm run dev` | React + Vite |

## Architecture Constraints
- Dependency flow: core → brain/claude/codex → qa_gate/guard → deploy/memory → cli (no reverse)
- Cross-peer imports forbidden (claude cannot import codex, qa_gate cannot import guard)
- core is the only shared dependency — all inter-package types live here
- Web UI communicates via FastAPI + WebSocket only — no Python imports
- Auth via subprocess delegation to CLI tools — never embed tokens

## Code Style
- Python 3.11+. Type hints on all public functions.
- Pydantic v2 for data models crossing package boundaries.
- async/await for I/O. No blocking calls in async context.
- Structured logging only. No print() in production code.

## Boundaries

### NEVER
- Commit secrets, tokens, or .env files
- Use API keys — OAuth subprocess delegation only
- Import from cli/web in core/brain packages
- Add hardcoded rules or regex for decisions that should be LLM calls
- Force push to main

### ASK
- Before adding new external dependencies
- Before modifying pipeline node structure (brain/nodes/)
- Before changing auth flow

### ALWAYS
- Run `ruff check . && mypy packages/ && pytest` before marking task complete
- Handle all errors explicitly with typed exceptions
- New brain nodes require corresponding tests

## Context Map
```yaml
monorepo: uv workspace

packages:
  packages/core: shared types, events, config, auth (OAuth subprocess delegation)
  packages/brain: LangGraph StateGraph orchestration, 7-node pipeline
  packages/claude: Claude agent wrapper, message parsing, MCP integration
  packages/codex: OpenAI Codex agent wrapper, parallel execution
  packages/qa_gate: multi-agent QA review (136 specialist agents, TOML-defined)
  packages/guard: sentinel verification loop, intent classification, evidence checking
  packages/deploy: deployment channels (git, npm, docker), cron, webhooks
  packages/memory: fact extraction, vector DB (qdrant/pgvector/sqlite), wisdom
  packages/cli: CLI (Click) + FastAPI server + WebSocket streaming

notable:
  web/: React 19 + Vite + Tailwind UI (AGI Mode, Pair Mode, Diagram Mode)
  config/: agent definitions (TOML files)
  research/: reference implementations, not shipped
```
