# AGENTS.md (packages/codex/)

## Scope
OpenAI Codex agent wrapper — lightweight, fast parallel code generation.

## Rules
- Intentionally minimal — speed over features
- ParallelTask/run_parallel() for concurrent execution
- Same subprocess delegation pattern as claude package

## Testing
- Run: `pytest packages/codex/tests/`
