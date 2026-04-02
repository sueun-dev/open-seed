# AGENTS.md (packages/core/)

## Scope
Shared types, events, config, auth, microagent loading. Zero openseed internal dependencies.

## Rules
- No imports from other openseed packages — this is the foundation
- All inter-package data models live here as Pydantic v2 models
- Auth via subprocess delegation only (keyring for storage, CLI tools for OAuth)
- EventBus is the single observability channel
- Microagent loader discovers context files (AGENTS.md, CLAUDE.md) in working directories

## Testing
- Run: `pytest packages/core/tests/`
- Mock keyring and subprocess for auth tests
