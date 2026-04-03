# OpenSeed Harness Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** openseed 코드베이스에 Harness Engineering Guide 기반 AGENTS.md 체계를 구축하여 AI 에이전트가 프로젝트를 정확히 이해하고 작업할 수 있게 한다.

**Architecture:** 루트 AGENTS.md가 전체 지도 역할, 서브 패키지 AGENTS.md가 패키지별 상세 규칙 제공. CLAUDE.md는 symlink로 통합. ADR 템플릿으로 아키텍처 결정 기록 체계 마련. 모든 파일은 가이드 5원칙(Minimal, Toolchain First, Pink Elephant 회피, Context Anchor, Context is Code)을 준수.

**Tech Stack:** Markdown, git symlink

**Validation:** 매 파일 작성 후 이중 검증 실행:
- 검증 1: 가이드 5원칙 체크 (Minimal, Toolchain First, Pink Elephant, Context Anchor, Context is Code, 150줄 제한)
- 검증 2: 양방향 일관성 (이전 파일과 모순 없는가, 코드베이스 실제 상태와 일치하는가)

**Reference:** `Harness_Engineering_Guide.md` 10절 (AGENTS.md 완전 가이드), 12절 (docs/ 구조)

---

## File Structure

| # | File | Action | Responsibility |
|---|------|--------|----------------|
| 1 | `AGENTS.md` | Rewrite | 루트 지도 — Mission, Key Commands, Architecture Constraints, Code Style, Boundaries, Context Map |
| 2 | `CLAUDE.md` | Replace with symlink | Claude Code 호환 (가이드 10.3절) |
| 3 | `docs/architecture/adr/000-template.md` | Create | ADR 표준 템플릿 (가이드 12절 + 원칙 4) |
| 4 | `packages/core/AGENTS.md` | Create | core 패키지 Scope/Rules/Testing |
| 5 | `packages/brain/AGENTS.md` | Create | brain 패키지 Scope/Rules/Testing |
| 6 | `packages/claude/AGENTS.md` | Create | claude 패키지 Scope/Rules/Testing |
| 7 | `packages/codex/AGENTS.md` | Create | codex 패키지 Scope/Rules/Testing |
| 8 | `packages/qa_gate/AGENTS.md` | Create | qa_gate 패키지 Scope/Rules/Testing |
| 9 | `packages/guard/AGENTS.md` | Create | guard 패키지 Scope/Rules/Testing |
| 10 | `packages/deploy/AGENTS.md` | Create | deploy 패키지 Scope/Rules/Testing |
| 11 | `packages/memory/AGENTS.md` | Create | memory 패키지 Scope/Rules/Testing |
| 12 | `packages/cli/AGENTS.md` | Create | cli 패키지 Scope/Rules/Testing |
| 13 | `web/AGENTS.md` | Create | web UI Scope/Rules/Testing |

---

### Task 1: Root AGENTS.md (Rewrite)

**Files:**
- Modify: `AGENTS.md` (rewrite from 13 lines to ~80 lines)

**Reference:** 가이드 10.5절 (섹션 구조), 10.6절 (실전 예시)

- [ ] **Step 1: Read current AGENTS.md and verify content is preserved in new version**

Current content (13 lines):
```markdown
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
```

All 7 key rules are preserved in the new version across Mission, Key Commands, Architecture Constraints, and Code Style sections.

- [ ] **Step 2: Write the new AGENTS.md**

Replace the entire file with:

```markdown
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
```

- [ ] **Step 3: Validate — Guide principle check**

Verify manually:
- 원칙 1 (Minimal): ~80 lines, under 150 limit. No redundant content.
- 원칙 2 (Toolchain First): ruff rules (E, F, I, N, W, UP, B, SIM, TCH) not restated. mypy strict mode not restated. pytest config not restated.
- 원칙 3 (Pink Elephant): NEVER section exists but items are hard limits not "don't do X" style hints. Acceptable per guide 10.5 Section 3.
- 원칙 4 (Context Anchor): Mission, Architecture Constraints, Boundaries — all non-inferable from code.
- 원칙 5 (Context is Code): All ALWAYS items are runnable commands.

- [ ] **Step 4: Validate — Bidirectional consistency**

First file — no previous files to check against. Verify against codebase:
- `uv sync` — confirmed: pyproject.toml has `[tool.uv.workspace]`
- `pytest` — confirmed: pyproject.toml has `[tool.pytest.ini_options]`
- `ruff check .` — confirmed: pyproject.toml has `[tool.ruff]`
- `mypy packages/` — confirmed: pyproject.toml has `[tool.mypy]`
- 9 packages listed — confirmed: pyproject.toml `members` has 9 entries
- `openseed serve` — confirmed: cli package has serve command
- `cd web && npm run dev` — confirmed: web/ has package.json with dev script

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "harness: rewrite root AGENTS.md with full guide structure

Expand from 13-line stub to complete harness scaffold following
Harness Engineering Guide 10.5 section structure:
Mission, Key Commands, Architecture Constraints, Code Style,
Boundaries (NEVER/ASK/ALWAYS), Context Map."
```

---

### Task 2: CLAUDE.md Symlink

**Files:**
- Replace: `CLAUDE.md` (delete file, create symlink)

**Reference:** 가이드 10.3절 (Multi-tool 전략)

- [ ] **Step 1: Verify current CLAUDE.md content is subset of new AGENTS.md**

Current CLAUDE.md content:
```markdown
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
```

All content is preserved in the new AGENTS.md. No information loss.

- [ ] **Step 2: Replace CLAUDE.md with symlink**

```bash
cd /Users/bentley/Documents/Developer/Codebase/mygent
rm CLAUDE.md
ln -s AGENTS.md CLAUDE.md
```

- [ ] **Step 3: Verify symlink works**

```bash
ls -la CLAUDE.md
# Expected: CLAUDE.md -> AGENTS.md

cat CLAUDE.md | head -3
# Expected: # AGENTS.md
# Expected: 
# Expected: > **Project:** Open Seed v2 ...
```

- [ ] **Step 4: Validate — Bidirectional consistency**

- CLAUDE.md now points to AGENTS.md — single source of truth.
- Claude Code reads CLAUDE.md, Codex reads AGENTS.md — both get same content.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "harness: replace CLAUDE.md with symlink to AGENTS.md

Guide 10.3 Multi-tool strategy: single source of truth.
Claude Code reads CLAUDE.md, Codex reads AGENTS.md — same content."
```

---

### Task 3: ADR Template

**Files:**
- Create: `docs/architecture/adr/000-template.md`

**Reference:** 가이드 12절 + 원칙 4 (Context Anchor)

- [ ] **Step 1: Create directory and file**

```bash
mkdir -p docs/architecture/adr
```

Write `docs/architecture/adr/000-template.md`:

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 4 (Context Anchor): ADR records architectural decisions that cannot be inferred from code. This is the canonical use case.
- Template only — no premature content. YAGNI respected.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root AGENTS.md does NOT reference ADR directory — correct. ADRs are created on-demand, not mandatory.
- No conflict with existing files.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/adr/000-template.md
git commit -m "harness: add ADR template for architectural decisions

Guide 12절 + principle 4 (Context Anchor). Architectural decisions
are persistent judgments that cannot be inferred from code."
```

---

### Task 4: packages/core/AGENTS.md

**Files:**
- Create: `packages/core/AGENTS.md`

**Reference:** 가이드 10.8절 (하위 디렉토리 AGENTS.md)

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 14 lines. Scope + Rules + Testing only.
- 원칙 2 (Toolchain First): No ruff/mypy rules restated. Only architectural decisions.
- 원칙 4 (Context Anchor): "zero openseed internal dependencies" is a judgment not inferable from code alone. "EventBus is the single observability channel" is an architectural decision.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root AGENTS.md Context Map says: `packages/core: shared types, events, config, auth (OAuth subprocess delegation)` — matches Scope.
- Root Architecture Constraints says: `core is the only shared dependency` — matches "zero openseed internal dependencies" rule.
- Actual pyproject.toml dependencies: pydantic, pyyaml, keyring — no openseed packages. Consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/core/AGENTS.md
git commit -m "harness: add packages/core/AGENTS.md

Foundation package rules: zero internal deps, Pydantic v2 models,
subprocess auth delegation, EventBus as single observability channel."
```

---

### Task 5: packages/brain/AGENTS.md

**Files:**
- Create: `packages/brain/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 15 lines. Only pipeline-specific architectural decisions.
- 원칙 2 (Toolchain First): No general Python style rules. Only LangGraph-specific patterns.
- 원칙 4 (Context Anchor): "State mutations only through Command() returns" is an architectural decision not obvious from code. "Use predefined RetryPolicy" prevents ad-hoc solutions.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/brain: LangGraph StateGraph orchestration, 7-node pipeline` — matches.
- Root ALWAYS: `New brain nodes require corresponding tests` — matches Testing section.
- Actual pyproject.toml: depends on `langgraph>=1.1`, `langgraph-checkpoint-sqlite>=2.0`, `openseed-core` — consistent.
- Actual nodes/ directory has: intake.py, plan.py, implement.py, qa_gate.py, sentinel.py, deploy.py, memorize.py, diagram.py — matches "one file, one node".

- [ ] **Step 4: Commit**

```bash
git add packages/brain/AGENTS.md
git commit -m "harness: add packages/brain/AGENTS.md

LangGraph pipeline rules: one-node-per-file, Command() state mutations,
predefined RetryPolicy, checkpoint for crash recovery."
```

---

### Task 6: packages/claude/AGENTS.md

**Files:**
- Create: `packages/claude/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 13 lines. Scope + 4 rules + testing.
- 원칙 2 (Toolchain First): No ruff/mypy rules. Only Claude-specific patterns.
- 원칙 4 (Context Anchor): "Opus for reasoning, Sonnet for implementation" is a model selection decision not in code config.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/claude: Claude agent wrapper, message parsing, MCP integration` — matches.
- Root Core Constraint: `OAuth only — never use API keys` — matches "subprocess CLI invocation".
- Actual code: agent.py spawns subprocess, messages.py defines TextBlock/ThinkingBlock/ToolUseBlock, hooks.py has HookRegistry, roles.py has role definitions — all consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/claude/AGENTS.md
git commit -m "harness: add packages/claude/AGENTS.md

Claude wrapper rules: subprocess CLI invocation, structured response
types, Hook system for extensibility, role-based model selection."
```

---

### Task 7: packages/codex/AGENTS.md

**Files:**
- Create: `packages/codex/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 10 lines. Codex is intentionally simple — AGENTS.md reflects this.
- 원칙 4 (Context Anchor): "Intentionally minimal — speed over features" is a design philosophy not in code.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/codex: OpenAI Codex agent wrapper, parallel execution` — matches.
- Actual code: agent.py + parallel.py — matches "lightweight".

- [ ] **Step 4: Commit**

```bash
git add packages/codex/AGENTS.md
git commit -m "harness: add packages/codex/AGENTS.md

Codex wrapper rules: intentionally minimal, parallel execution,
subprocess delegation pattern."
```

---

### Task 8: packages/qa_gate/AGENTS.md

**Files:**
- Create: `packages/qa_gate/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 14 lines. Only QA-specific architectural decisions.
- 원칙 4 (Context Anchor): "Agent definitions in TOML files (config/)" tells the agent WHERE to look — not obvious. "Two modes: flat and staged" is an architectural choice.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/qa_gate: multi-agent QA review (136 specialist agents, TOML-defined)` — matches.
- Actual code: gate.py has flat/staged modes, agent_loader.py loads TOML, agent_selector.py uses LLM, synthesizer.py combines findings — all consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/qa_gate/AGENTS.md
git commit -m "harness: add packages/qa_gate/AGENTS.md

QA gate rules: TOML agent definitions, flat/staged modes,
LLM-based agent selection, bounded concurrency."
```

---

### Task 9: packages/guard/AGENTS.md

**Files:**
- Create: `packages/guard/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 14 lines.
- 원칙 4 (Context Anchor): "Retry chain: retry → different approach → Insight → user escalate" is the escalation policy — a design decision not obvious from code structure. "Use compute_backoff_ms()" prevents duplicate backoff implementations.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/guard: sentinel verification loop, intent classification, evidence checking` — matches.
- Actual code: loop.py has retry chain, backoff.py has compute_backoff_ms(), evidence.py has verify_implementation(), stagnation.py has detection, security.py has assess_risk() — all consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/guard/AGENTS.md
git commit -m "harness: add packages/guard/AGENTS.md

Sentinel rules: retry escalation chain, compute_backoff_ms(),
evidence-based verification, stagnation detection, security assessment."
```

---

### Task 10: packages/deploy/AGENTS.md

**Files:**
- Create: `packages/deploy/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 11 lines. Deploy is straightforward — AGENTS.md reflects this.
- 원칙 4 (Context Anchor): "New channels: create in channels/, register in factory" is the extension pattern.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/deploy: deployment channels (git, npm, docker), cron, webhooks` — matches.
- Actual code: channels/ has base.py, git.py, npm.py, docker.py, webhook.py, pr.py — matches factory pattern.

- [ ] **Step 4: Commit**

```bash
git add packages/deploy/AGENTS.md
git commit -m "harness: add packages/deploy/AGENTS.md

Deploy rules: DeployChannel base class, channel factory pattern,
async execution, mock external operations in tests."
```

---

### Task 11: packages/memory/AGENTS.md

**Files:**
- Create: `packages/memory/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 12 lines.
- 원칙 4 (Context Anchor): "Pluggable backend factory: auto-selects qdrant → pgvector → sqlite" is the degradation strategy. "MemoryStore is the unified interface" prevents direct backend access.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Context Map: `packages/memory: fact extraction, vector DB (qdrant/pgvector/sqlite), wisdom` — matches.
- Actual code: backends/factory.py auto-selects, store.py is unified interface, fact_extractor.py, condenser.py — all consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/memory/AGENTS.md
git commit -m "harness: add packages/memory/AGENTS.md

Memory rules: pluggable backend factory (qdrant → pgvector → sqlite),
MemoryStore unified interface, FactExtractor, Condenser."
```

---

### Task 12: packages/cli/AGENTS.md

**Files:**
- Create: `packages/cli/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 11 lines.
- 원칙 4 (Context Anchor): "Never put business logic here — delegate" is an architectural boundary. "Top of dependency stack" clarifies its position in the graph.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Architecture Constraints: dependency flow ends at cli. Root Context Map: `packages/cli: CLI (Click) + FastAPI server + WebSocket streaming` — matches.
- Actual pyproject.toml: depends on all openseed packages — matches "imports all other packages".

- [ ] **Step 4: Commit**

```bash
git add packages/cli/AGENTS.md
git commit -m "harness: add packages/cli/AGENTS.md

CLI rules: integration layer at top of dependency stack,
one file per command group, delegate business logic."
```

---

### Task 13: web/AGENTS.md

**Files:**
- Create: `web/AGENTS.md`

- [ ] **Step 1: Write the file**

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

- [ ] **Step 2: Validate — Guide principle check**

- 원칙 1 (Minimal): 12 lines.
- 원칙 2 (Toolchain First): No TypeScript/ESLint rules restated. Only architectural decisions.
- 원칙 4 (Context Anchor): "This is the only TypeScript in the project" prevents confusion. "HTTP + WebSocket only — no Python imports" is the decoupling boundary.

- [ ] **Step 3: Validate — Bidirectional consistency**

- Root Architecture Constraints: `Web UI communicates via FastAPI + WebSocket only — no Python imports` — matches.
- Root Context Map: `web/: React 19 + Vite + Tailwind UI (AGI Mode, Pair Mode, Diagram Mode)` — matches.
- Actual web/package.json: react 19, vite, tailwind, monaco-editor, mermaid — all consistent.

- [ ] **Step 4: Final full-system consistency check**

After all 13 files are written, verify:
1. Root AGENTS.md Context Map lists all 9 packages + web/ + config/ + research/ — matches 10 sub-AGENTS.md files (9 packages + web).
2. Root Architecture Constraints dependency flow is not contradicted by any sub-AGENTS.md.
3. All sub-AGENTS.md Testing sections use correct test commands matching pyproject.toml.
4. No two files contain conflicting rules.

- [ ] **Step 5: Commit**

```bash
git add web/AGENTS.md
git commit -m "harness: add web/AGENTS.md

Web UI rules: TypeScript only, component-per-file, HTTP+WebSocket
boundary with backend, React Testing Library for tests."
```

---

### Task 14: Final Verification

- [ ] **Step 1: Verify all 13 files exist**

```bash
ls -la AGENTS.md CLAUDE.md docs/architecture/adr/000-template.md packages/*/AGENTS.md web/AGENTS.md
```

Expected: 13 entries. CLAUDE.md shows as symlink → AGENTS.md.

- [ ] **Step 2: Count root AGENTS.md lines**

```bash
wc -l AGENTS.md
```

Expected: under 150 lines.

- [ ] **Step 3: Verify CLAUDE.md symlink**

```bash
readlink CLAUDE.md
```

Expected: `AGENTS.md`

- [ ] **Step 4: Verify no toolchain rules restated**

```bash
grep -r "import order" packages/*/AGENTS.md web/AGENTS.md AGENTS.md
grep -r "line.length" packages/*/AGENTS.md web/AGENTS.md AGENTS.md
grep -r "indent" packages/*/AGENTS.md web/AGENTS.md AGENTS.md
```

Expected: no matches (these are ruff/editor config concerns).

- [ ] **Step 5: Verify dependency flow consistency**

Root says: `core → brain/claude/codex → qa_gate/guard → deploy/memory → cli`

Check no sub-AGENTS.md contradicts this:
- core: "No imports from other openseed packages" ✓
- cli: "Imports all other packages" ✓
- No sub-AGENTS.md imports from cli or web ✓
