# AGENTS.md (packages/qa_gate/)

## Scope
Multi-agent QA review — specialist agents, LLM-based selection, parallel execution.

## Rules
- Agent definitions in TOML files (config/) — not hardcoded
- Two modes: flat (parallel) and staged (4-stage with go/no-go gates)
- Agent selection via LLM — picks 3-5 most relevant per task
- Synthesizer combines findings into single verdict
- Bounded concurrency on parallel execution

## Testing
- Run: `pytest packages/qa_gate/tests/`
- Test both flat and staged modes with mocked LLM calls
