# AGENTS.md (packages/cli/)

## Scope
CLI entry point (Click) and FastAPI server with WebSocket streaming. Top of dependency stack.

## Rules
- Imports all other packages — this is the integration layer
- CLI commands in commands/ — one file per command group
- Never put business logic here — delegate to brain/claude/codex

## Testing
- Run: `pytest packages/cli/tests/`
- Test CLI with Click test runner, API with TestClient
