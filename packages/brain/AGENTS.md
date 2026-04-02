# AGENTS.md (packages/brain/)

## Scope
LangGraph StateGraph orchestration — the main 7-node pipeline engine.

## Rules
- Pipeline nodes in nodes/ — one file, one node, one responsibility
- State mutations only through LangGraph Command() returns
- Send() for parallel task dispatch to specialists
- Checkpoint via AsyncSqliteSaver for crash recovery and time travel
- Use predefined RetryPolicy from retry.py — no ad-hoc retries
- New nodes require: node function + routing logic in graph.py + tests

## Testing
- Run: `pytest packages/brain/tests/`
- Each node must have independent unit tests with mocked LLM calls
