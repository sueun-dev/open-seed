# agent40 — AGI Coding Agent Architecture

## How It Works (End-to-End)

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  1. INTENT ANALYSIS + SISYPHUS ASSESSMENT               │
│                                                         │
│  analyzeIntent(task)                                    │
│    → action: add|fix|refactor|investigate|...  (13종)   │
│    → scope: single-file|module|cross-module|project     │
│    → risk: low|medium|high                              │
│    → suggestedRoles: ["executor","test-engineer",...]   │
│    → constraints: ["keep-tests-green","minimize-diff"]  │
│                                                         │
│  assessCodebase(files, configs)                         │
│    → maturity: disciplined|transitional|legacy|green    │
│    → conventions: ["TypeScript strict","vitest",...]    │
│                                                         │
│  verbalizeIntent(task, intent)                          │
│    → trueIntent: "User wants X. Risk: Y."              │
│    → delegation: direct|delegate|explore-first          │
│                                                         │
│  createEvidenceRequirements(intent)                     │
│    → [build-pass, test-pass, diagnostics-clean]         │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  2. CONTEXT GATHERING                                   │
│                                                         │
│  buildRepoMap(cwd)          → file tree + symbols       │
│  loadMicroagents(cwd)       → .agent/microagents/*.md   │
│  loadAgentsContext(cwd)     → AGENTS.md hierarchy        │
│  loadConsolidatedMemory()   → learnings from past runs   │
│  getModelVariant(model)     → Claude/GPT/Gemini config   │
│  createTokenBudget(model)   → context window tracking    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  3. PLANNING + RESEARCH (parallel)                      │
│                                                         │
│  Planner (GPT-5.4 / Claude Opus 4.6)                   │
│    → tasks: [{id, title, category, roleHint, dependsOn}]│
│    → dependency DAG resolution (CrewAI-style)           │
│                                                         │
│  Researcher (parallel, team mode only)                  │
│    → findings, risks, recommendations                   │
│                                                         │
│  buildExecutionBatches(tasks)                           │
│    → topological sort → parallel batches                │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  4. DELEGATION (team mode)                              │
│                                                         │
│  selectDelegationAssignments()                          │
│    → match tasks to 40 specialist roles                 │
│    → fork event bus per child agent (OpenHands-style)   │
│    → structured 6-section delegation prompt (Sisyphus)  │
│    → spawn reservation (concurrency control)            │
│                                                         │
│  40 Specialist Roles:                                   │
│    orchestrator, planner, executor, reviewer,           │
│    researcher, frontend-engineer, test-engineer,        │
│    security-auditor, debugger, performance-engineer,    │
│    docs-writer, build-doctor, devops-engineer,          │
│    ci-cd-specialist, migration-specialist, git-expert,  │
│    pr-author, api-designer, db-specialist,              │
│    browser-operator, accessibility-auditor,             │
│    cost-analyst, model-router, compliance-officer,      │
│    refactor-specialist, dependency-analyst,             │
│    observability-engineer, toolsmith, librarian,        │
│    ... (40 total, each with execution-grade directives) │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  5. EXECUTION (enforcer loop)                           │
│                                                         │
│  ┌───────────────────────────────────────┐              │
│  │ Executor (LLM call)                   │              │
│  │   → generates toolCalls JSON array    │              │
│  │   → MUST read before write            │              │
│  │   → MUST include complete file content│              │
│  └──────────────┬────────────────────────┘              │
│                 │                                        │
│                 ▼                                        │
│  ┌───────────────────────────────────────┐              │
│  │ Tool Runtime                          │              │
│  │                                       │              │
│  │  14 tools:                            │              │
│  │   read, write, apply_patch, grep,     │              │
│  │   glob, bash, git, browser,           │              │
│  │   lsp_diagnostics, lsp_symbols,       │              │
│  │   repo_map, session_history,          │              │
│  │   ast_grep, web_search               │              │
│  │                                       │              │
│  │  Safety layers:                       │              │
│  │   → RulesEngine (Cline-style blocks)  │              │
│  │   → ApprovalEngine (auto/ask/block)   │              │
│  │   → DiffSandbox (Plandex-style staging)│             │
│  │   → Bash syntax pre-check (SWE-Agent) │              │
│  │   → EventBus (all events centralized) │              │
│  │   → UndoManager (turn-level rollback) │              │
│  └──────────────┬────────────────────────┘              │
│                 │                                        │
│                 ▼                                        │
│  ┌───────────────────────────────────────┐              │
│  │ Reviewer (LLM call)                   │              │
│  │   → verdict: pass | fail              │              │
│  │   → follows REVIEW RULES:             │              │
│  │     write ok = evidence of impl       │              │
│  │     missing npm scripts ≠ code error  │              │
│  └──────────────┬────────────────────────┘              │
│                 │                                        │
│          pass?──┼──no──→ Self-Heal + Retry              │
│           │     │        │                               │
│           │     │   ┌────▼──────────────────────┐       │
│           │     │   │ Self-Healing Error Loop    │       │
│           │     │   │  diagnoseError()           │       │
│           │     │   │  → category: syntax/type/  │       │
│           │     │   │    build/test/network/...  │       │
│           │     │   │  → strategy: retry/fix/    │       │
│           │     │   │    rollback/escalate       │       │
│           │     │   │  buildRecoveryPrompt()     │       │
│           │     │   └────┬──────────────────────┘       │
│           │     │        │                               │
│           │     │   ┌────▼──────────────────────┐       │
│           │     │   │ Stuck Detector (OpenHands) │       │
│           │     │   │  consecutive failures > 4  │       │
│           │     │   │  repeated summaries > 3    │       │
│           │     │   │  alternating pass/fail > 6 │       │
│           │     │   └────┬──────────────────────┘       │
│           │     │        │                               │
│           │     │   ┌────▼──────────────────────┐       │
│           │     │   │ Oracle Escalation          │       │
│           │     │   │  2+ consecutive failures   │       │
│           │     │   │  → strategic advisor prompt│       │
│           │     │   │  → actionPlan, risks,      │       │
│           │     │   │    alternativeApproach      │       │
│           │     │   └───────────────────────────┘       │
│           │     │                                        │
│           │  ◄──┘  (max 8 rounds)                       │
│           │                                              │
│           ▼                                              │
│  ┌───────────────────────────────────────┐              │
│  │ Evidence Check                        │              │
│  │   updateEvidence(output)              │              │
│  │   → build-pass satisfied?             │              │
│  │   → test-pass satisfied?              │              │
│  │   → diagnostics-clean satisfied?      │              │
│  └───────────────────────────────────────┘              │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  6. COMPLETION                                          │
│                                                         │
│  Sandbox apply/revert                                   │
│    → review pass + autoApply → apply staged changes     │
│    → review fail → revert all staged changes            │
│                                                         │
│  Session persistence                                    │
│    → .agent/sessions/ snapshot                          │
│    → .agent/checkpoints/ per-round state                │
│                                                         │
│  Memory extraction (Codex-style 2-phase)                │
│    → Phase 1: extract tool usage, errors, hot files     │
│    → Phase 2: consolidate across sessions               │
│    → injected into next run's system prompt             │
│                                                         │
│  Cost tracking                                          │
│    → per-task, per-provider, per-role breakdown         │
│    → budget guard ($50 default)                         │
│                                                         │
│  Event bus → Stream protocol → UI                       │
│    → phase transitions, tool calls, reviews             │
│    → NDJSON for programmatic consumers                  │
│    → ANSI terminal for CLI                              │
│    → SSE for web app                                    │
└─────────────────────────────────────────────────────────┘
```

## Subsystem Origins (22 repos → agent40)

| Subsystem | Inspired By | What It Does |
|---|---|---|
| Event Bus + Fork | OpenHands | Central event stream, child agent isolation |
| Diff Sandbox | Plandex | Writes go to staging, apply/revert after review |
| Rules Engine | Cline | .agent/rules.md blocks dangerous tool calls |
| Enforcer Loop | Custom | Checklist-driven retry until review passes |
| Stuck Detector | OpenHands | Detects infinite loops (consecutive fails, monologue, alternating) |
| Self-Healing | SWE-Agent + AutoGPT | Classifies errors, generates recovery prompts |
| Oracle Escalation | Sisyphus | Strategic advisor after repeated failures |
| Task DAG | CrewAI | Dependency-ordered parallel batch execution |
| Token Budget | Aider + Plandex | Context window tracking + auto-compaction |
| Model Variants | Cline | Claude/GPT/Gemini-specific prompt adaptation |
| Prompt Templates | SWE-Agent | Composable templates with variable substitution |
| Edit Strategies | Aider | Hash-anchored edits + full-file writes |
| MCP Client | Cline + Claude Code | Consume external MCP servers via JSON-RPC |
| MCP Server | Custom | Expose agent40 tools to external clients |
| Microagents | OpenHands | Keyword-triggered context injection |
| Memory Pipeline | Codex | 2-phase: extract per-session → consolidate global |
| Undo/Rollback | Codex | Turn-level file mutation tracking + restore |
| Streaming Protocol | Codex | Real-time NDJSON/ANSI/SSE output |
| Codebase Assessment | Sisyphus | Maturity classification before implementation |
| Intent Verbalization | Sisyphus | Articulate true intent before routing |
| Evidence Requirements | Sisyphus | No completion without build/test proof |
| Structured Delegation | Sisyphus | 6-section prompt prevents rogue subagents |
| Spawn Reservation | Custom | Concurrency control for parallel agents |
| Hooks System | Codex | tool.before/after lifecycle events |
| Cost Tracker | MetaGPT | Per-task token/cost tracking with budget |
| Repo Map | Aider | File tree + symbol extraction for context |
| AST Grep | Custom | Structural code search via sg CLI |
| Web Search | Custom | DuckDuckGo search for documentation |
| Browser Runtime | Custom | Playwright-based with checkpoints |
| Comment Checker | Custom | TODO/FIXME/HACK scanner |

## Provider Setup

| Provider | Auth | Model | Cost |
|---|---|---|---|
| OpenAI | OAuth via `~/.codex/auth.json` | GPT-5.4 | $0 (subscription) |
| Anthropic | OAuth via macOS Keychain | Claude Opus 4.6 | $0 (subscription) |
| Gemini | API key (optional) | Gemini 2.5 Pro | Pay per token |

## CLI Commands

```bash
agent run "task"           # Single agent: plan → execute → verify
agent team "task"          # Multi-agent: plan + research + delegate + execute + verify
agent resume <sessionId>   # Resume a failed/incomplete session
agent status [sessionId]   # Show session history
agent doctor               # Diagnose providers, tools, config
agent check-comments       # Scan for TODO/FIXME/HACK
agent init                 # Initialize .agent/config.json
agent init-deep            # Generate AGENTS.md hierarchy
agent mcp                  # Start MCP server (stdio)
agent soak                 # Provider streaming stress test
```

## Web App (localhost:4040)

```bash
node app/server.js --port 4040 --cwd /path/to/project
```

4 panels:
- **Task Runner** — Chat interface, Solo/Team mode, real-time SSE streaming
- **Sessions** — Session history viewer
- **Doctor** — System diagnostics
- **Comments** — TODO/FIXME scanner

## Test Results

```
46 test files passed
291 tests passed
0 failures

Real LLM E2E verified:
  GPT-5.4 via OAuth → generated Calculator module → 11/11 runtime tests passed
  Claude Opus 4.6 via OAuth → API call succeeded
```

## File Structure

```
src/
  core/         config, types, utils, event-bus, token-counter, paths
  providers/    anthropic, openai, gemini, mock, auth, external-auth, registry
  roles/        40-role registry with execution-grade directives
  routing/      intent → provider → role routing policy
  safety/       approval engine, rules engine, resolver
  sessions/     store, follow, activity
  orchestration/
    engine.ts           ← THE CORE: runEngine() orchestrates everything
    intent-gate.ts      intent analysis (13 actions, 4 scopes, 3 risks)
    enforcer.ts         checklist-driven retry loop
    process.ts          task DAG resolution (sequential/parallel/hierarchical)
    delegation.ts       40-role specialist delegation
    worker-runner.ts    LLM call + tool execution + artifact parsing
    worker-manager.ts   subprocess/tmux worker management
    prompts.ts          SWE-Agent-style template engine
    self-heal.ts        error classification + recovery prompts
    stuck-detector.ts   infinite loop detection
    sisyphus.ts         codebase assessment, verbalization, evidence, oracle
    cost-tracker.ts     per-task token/cost tracking
    undo.ts             turn-level file rollback
    stream-protocol.ts  NDJSON/terminal/SSE streaming
    microagents.ts      keyword-triggered context injection
    model-variants.ts   Claude/GPT/Gemini prompt adaptation
    spawn-reservation.ts concurrency control
    checkpoint.ts       per-round state persistence
    hooks.ts            lifecycle event hooks
    contracts.ts        specialist artifact schemas
    retry.ts            JSON recovery + truncation
    design-references.ts reference context loader
  memory/
    project-memory.ts   project-level learning
    memory-pipeline.ts  2-phase extract + consolidate
  tools/
    runtime.ts          14-tool execution engine
    diff-sandbox.ts     staging area for safe writes
    hashline.ts         hash-anchored editing
    edit-strategies.ts  multi-format edit support
    repomap.ts          file tree + symbol extraction
    ast-grep.ts         structural code search
    web-search.ts       DuckDuckGo search
    browser.ts          Playwright runtime
    browser-session.ts  browser checkpoints
    comment-checker.ts  TODO/FIXME scanner
    lsp.ts              TypeScript diagnostics
    agents-context.ts   AGENTS.md loader
  mcp/
    server.ts           MCP server (expose tools)
    client.ts           MCP client (consume external servers)
  commands/             CLI command handlers
  soak/                 provider stress test harness
app/
  server.js             Web server (SSE streaming, port 4040)
  main.js               Electron main process
  preload.js            Electron IPC bridge
  index.html            Web UI (sidebar + 4 panels)
tests/
  46 test files, 291 tests
  e2e-full-pipeline.test.ts    all 23 subsystems in one test
  e2e-engine-run.test.ts       real engine with mock provider
  e2e-app-quality.test.ts      inspect generated code quality
  e2e-real-build-app.test.ts   GPT-5.4 builds real app, runtime verified
  e2e-direct-openai.test.ts    direct OpenAI OAuth call
  e2e-direct-claude.test.ts    direct Claude OAuth call
```
