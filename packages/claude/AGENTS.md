# AGENTS.md (packages/claude/)

## Scope
Claude agent wrapper — subprocess CLI invocation, message parsing, hooks, MCP.

## Rules
- ClaudeAgent spawns CLI as subprocess — never use API directly
- All responses parsed into structured types (TextBlock, ThinkingBlock, ToolUseBlock)
- Hook system (HookRegistry) for extensibility — register callbacks, don't modify internals
- Roles define model selection (Opus for reasoning, Sonnet for implementation)

## Testing
- Run: `pytest packages/claude/tests/`
- Mock subprocess — never hit real Claude CLI in tests
