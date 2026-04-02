# AGENTS.md (packages/memory/)

## Scope
Long-term learning — fact extraction, vector DB, failure patterns, wisdom, procedures.

## Rules
- Pluggable backend factory: auto-selects qdrant → pgvector → sqlite
- MemoryStore is the unified interface — never access backends directly
- FactExtractor decides what's worth remembering
- Condenser compresses memory for token efficiency

## Testing
- Run: `pytest packages/memory/tests/`
- Test with SQLite backend (zero-config, always available)
