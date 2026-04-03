# OpenSeed Harness Phase 1: Scaffold Design Spec

## Goal

openseed 코드베이스에 Harness Engineering Guide에 따른 AGENTS.md 체계를 구축한다.
AI(Claude/Codex)가 openseed를 개발할 때 더 정확하게 이해하고 작업할 수 있게 만드는 것이 목적.

## Scope

**Phase 1 (Auto scaffold)만.** Phase 2 (OAuth-enhanced curation), Phase 3 (Orchestrator)는 별도.

## Design Principles (from Harness_Engineering_Guide.md)

1. **Minimal by Design** — 불필요한 제약은 에이전트 성능을 해친다
2. **Toolchain First** — ruff/mypy/pytest가 강제하는 건 AGENTS.md에 쓰지 않는다
3. **Pink Elephant 회피** — "하지 마라" 대신 긍정형 지시
4. **Context Anchor** — 코드에서 추론 불가능한 판단만 담는다
5. **Context is Code** — 테스트 가능한 기대치, git으로 추적

## Files to Create (13 total)

### 1. AGENTS.md (root, rewrite)

현재 13줄 → ~80줄로 확장. 150줄 미만 유지.

**구조 (가이드 10.5절):**

```markdown
# AGENTS.md

> **Project:** Open Seed v2 — AI agent orchestration engine that fuses multiple LLMs
> (Claude, Codex) through a 7-system pipeline for autonomous software development.
> **Core constraint:** OAuth only — never use API keys. All decisions by AI (LLM calls)
> — no regex, no hardcoded rules.

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
` ` `yaml
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
` ` `
```

### 2. CLAUDE.md → symlink to AGENTS.md

```bash
rm CLAUDE.md && ln -s AGENTS.md CLAUDE.md
```

가이드 10.3절 Multi-tool 전략. 현재 별도 파일(13줄, AGENTS.md와 동일 내용) → 삭제 후 symlink로 교체.
CLAUDE.md의 기존 내용은 AGENTS.md에 모두 포함되므로 정보 손실 없음.

### 3. docs/architecture/adr/000-template.md

가이드 12절 + 원칙 4 (Context Anchor). 아키텍처 결정은 코드에서 추론 불가능한 영속적 판단.

```markdown
# ADR-000: [Title]

## Status
[Proposed | Accepted | Deprecated | Superseded]

## Context
[What is the issue that we're seeing that is motivating this decision?]

## Decision
[What is the change that we're proposing and/or doing?]

## Consequences
[What becomes easier or more difficult to do because of this change?]

## Alternatives Considered
[What other options did we evaluate?]
```

### 4. packages/core/AGENTS.md

```markdown
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
```

### 5. packages/brain/AGENTS.md

```markdown
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
```

### 6. packages/claude/AGENTS.md

```markdown
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
```

### 7. packages/codex/AGENTS.md

```markdown
# AGENTS.md (packages/codex/)

## Scope
OpenAI Codex agent wrapper — lightweight, fast parallel code generation.

## Rules
- Intentionally minimal — speed over features
- ParallelTask/run_parallel() for concurrent execution
- Same subprocess delegation pattern as claude package

## Testing
- Run: `pytest packages/codex/tests/`
```

### 8. packages/qa_gate/AGENTS.md

```markdown
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
```

### 9. packages/guard/AGENTS.md

```markdown
# AGENTS.md (packages/guard/)

## Scope
Sentinel verification — retry loop until zero errors, intent classification, evidence checking.

## Rules
- Retry chain: retry → different approach → Insight → user escalate
- Use compute_backoff_ms() for delays — no custom backoff logic
- Evidence-based verification: reads actual files, runs actual tests
- Stagnation detection prevents infinite loops — escalate when no progress
- Security assessment (assess_risk()) before untrusted operations

## Testing
- Run: `pytest packages/guard/tests/`
- Test retry escalation chain and stagnation detection
```

### 10. packages/deploy/AGENTS.md

```markdown
# AGENTS.md (packages/deploy/)

## Scope
Multi-channel deployment — git, npm, docker, webhooks, PR creation, cron.

## Rules
- All channels extend DeployChannel abstract base
- New channels: create in channels/, register in factory
- Async deployment — never block on channel execution

## Testing
- Run: `pytest packages/deploy/tests/`
- Mock all external operations (git push, npm publish, docker build)
```

### 11. packages/memory/AGENTS.md

```markdown
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
```

### 12. packages/cli/AGENTS.md

```markdown
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
```

### 13. web/AGENTS.md

```markdown
# AGENTS.md (web/)

## Scope
React 19 + Vite + Tailwind web UI. Three modes: AGI, Pair, Diagram.

## Rules
- TypeScript only — this is the only TypeScript in the project
- Components in components/ — one file per component
- Communicates with backend via HTTP + WebSocket only — no Python imports
- Monaco for code viewing, Mermaid for diagrams

## Testing
- Run: `cd web && npm test`
- React Testing Library for component tests
```

## Validation Process

매 파일 작성 후 이중 검증:

**검증 1 — 가이드 원칙 체크:**
- 원칙 1 (Minimal): 불필요한 내용 없는가?
- 원칙 2 (Toolchain First): ruff/mypy/pytest가 강제하는 걸 반복하지 않는가?
- 원칙 3 (Pink Elephant): 부정형 대신 긍정형인가?
- 원칙 4 (Context Anchor): 코드에서 추론 불가능한 것만 담았는가?
- 원칙 5 (Context is Code): 테스트 가능한 기대치인가?
- 150줄 미만인가? (루트 AGENTS.md)

**검증 2 — 양방향 일관성:**
- 이전 파일과 모순 없는가?
- 루트 AGENTS.md의 Context Map과 정합성 맞는가?
- 현재 코드베이스 실제 상태와 일치하는가?

## What This Spec Does NOT Include

- docs/ 구조 (과잉 — ADR 템플릿만 포함, 나머지는 AGENTS.md가 커버)
- Orchestrator prompt (Phase 3 scope)
- OAuth-enhanced curation (Phase 2 scope)
- pre-commit hooks, CI integration (Phase 1은 scaffold만)
