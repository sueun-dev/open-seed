# Open Seed v2

Python monorepo. 9 workspace packages under `packages/`. Web UI under `web/`.

## Key Rules
- Python 3.11+, uv workspace, hatchling build backend
- TypeScript for web UI only (React + Vite)
- OAuth only — never use API keys
- All decisions by AI (LLM calls) — no regex, no hardcoded rules
- Each package is independently testable
- pytest + pytest-asyncio for tests
- ruff for linting, mypy for type checking
