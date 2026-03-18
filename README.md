# Open Seed

### Autonomous AGI Coding Engine

> **49 subsystems. 40 neural roles. One prompt. Ship it.**

> ⚠️ **Beta** — Pre-release version. APIs and features may change.

---

## What is Open Seed?

Open Seed is an **autonomous AGI coding engine** that plans, delegates to 40 specialist neural roles, executes real tools, self-heals on errors, and verifies its own output — all from a single prompt.

It is not a copilot. It is not an autocomplete. It is a **fully autonomous software engineer** that reads your codebase, understands your intent, writes code, runs tests, fixes its own bugs, and ships working software.

Powered by **GPT-5.4 + Claude Opus 4.6** via OAuth. **$0 cost** with subscription.

```
$ openseed run "Build a REST API with user auth, tests, and docs"

→ Intent: implementation (module scope, medium risk)
→ Codebase: disciplined (TypeScript, vitest, ESLint)
→ Planning: 5 tasks identified
→ Executing: read → write → test → verify
→ Review: PASS ✓

Status: completed
```

---

## Why Open Seed?

| Feature | Copilots | Open Seed |
|---|---|---|
| Writes code | ✓ | ✓ |
| Plans architecture | ✗ | ✓ |
| Runs tests | ✗ | ✓ |
| Fixes its own bugs | ✗ | ✓ |
| Verifies output | ✗ | ✓ |
| Learns from sessions | ✗ | ✓ |
| 40 specialist roles | ✗ | ✓ |
| Multi-provider failover | ✗ | ✓ |
| Works fully autonomously | ✗ | ✓ |

---

## The Sisyphus Protocol

Every request flows through the complete AGI pipeline:

```
User Prompt
  │
  ├─ Phase 0: Intent Gate ──────── classify (13 types) + verbalize
  ├─ Phase 1: Codebase Assessment ─ maturity / conventions / patterns
  ├─ Phase 2A: Exploration ──────── parallel research agents
  ├─ Phase 2B: Execution ─────────── 40 roles × 14 tools × self-heal
  ├─ Phase 2C: Failure Recovery ──── 3 fails → stop → oracle → revert
  ├─ Phase 3: Evidence Gate ──────── build✓ test✓ diagnostics✓
  └─ Completion ──────────────────── memory extraction + session persist
```

### 49 Integrated Subsystems

Extracted from **22 top open-source repos** (1.4M+ combined GitHub stars):

| Category | Subsystems |
|---|---|
| **Core Engine** | Event Bus, Enforcer Loop, Task DAG, Spawn Reservation, Hooks |
| **Safety** | Rules Engine, Write Guard, Edit Recovery, File Lock, Agent Babysitter |
| **Intelligence** | Intent Gate, Codebase Assessment, Model Router, Factcheck, Code Simplifier |
| **Recovery** | Self-Healing, Stuck Detector, Oracle Escalation, Delegation Retry, Context Recovery |
| **Memory** | Memory Pipeline, Microagents, Context Cache, Project Memory, RALPH Loop |
| **Execution** | Diff Sandbox, Verify-Fix Loop, Fresh Context Loop, Durable Execution |
| **Streaming** | Event Flows, Streaming Protocol, HUD, Token Budget, Cost Tracker |
| **Integration** | MCP Client/Server, Model Variants, Prompt Templates, Repo Map |
| **Tools** | 14 tools: read, write, bash, grep, glob, git, browser, LSP, AST grep, web search... |

---

## Quick Start

### Web UI

```bash
git clone https://github.com/user/open-seed.git
cd open-seed
npm install
npm run build
node app/server.js --port 4040 --cwd /path/to/your/project
```

Open **http://localhost:4040** — full IDE with explorer, editor, terminal, AI chat, settings.

### CLI

```bash
# Single agent
npx tsx src/cli.ts run "Create a calculator with add, subtract, multiply, divide"

# Team mode
npx tsx src/cli.ts team "Build a REST API with authentication"

# Diagnostics
npx tsx src/cli.ts doctor
npx tsx src/cli.ts status
npx tsx src/cli.ts check-comments
```

---

## Provider Setup — $0 with Subscriptions

### OpenAI (GPT-5.4 via OAuth)
```bash
npx codex auth    # Token auto-detected from ~/.codex/auth.json
```

### Anthropic (Claude Opus 4.6 via OAuth)
```bash
claude auth login  # Token auto-detected from macOS Keychain
```

No API keys needed. OAuth is detected automatically.

---

## 40 Neural Roles

<details>
<summary>View all 40 specialist roles</summary>

**Planning:** orchestrator, planner, issue-triage-agent, api-designer, docs-writer, prompt-engineer, release-manager, cost-optimizer, model-router

**Research:** researcher, repo-mapper, search-specialist, dependency-analyst

**Execution:** executor, git-strategist, pr-author, lsp-analyst, ast-rewriter, build-doctor, test-engineer, debugger, backend-engineer, db-engineer, performance-engineer, devops-engineer, cicd-engineer, observability-engineer, refactor-specialist, code-simplifier, migration-engineer, toolsmith

**Frontend:** frontend-engineer, ux-designer, accessibility-auditor, browser-operator

**Review:** reviewer, security-auditor, risk-analyst, benchmark-analyst, compliance-reviewer

</details>

---

## Web UI Features

- **File Explorer** — browse, create, rename, delete files/folders + right-click context menu
- **Code Editor** — line numbers, tab indent, Cmd+S save
- **Terminal** — real shell with `cd`, command history, streaming output
- **AI Chat** — Task / Ask / Team modes with thinking animation + event cards
- **Settings** — Providers, Safety, Engine, Tools, Expert tabs
- **OAuth Status** — check and test provider connections

| Shortcut | Action |
|---|---|
| `⌘⇧A` | AI Chat |
| `⌘⇧E` | Explorer |
| `⌘S` | Save |
| `⌘J` | Terminal |

---

## Automatic Guards (zero config)

| Guard | What it does |
|---|---|
| Write Guard | Blocks writes to unread files |
| Edit Recovery | Auto-recovers from failed edits |
| Agent Babysitter | Detects and restarts stuck agents |
| TODO Enforcer | Forces completion of all tasks |
| Delegation Retry | Auto-retries failed delegations |
| Context Recovery | Preserves state across compaction |
| File Lock | Prevents concurrent edits |
| Stuck Detector | Breaks infinite loops |

---

## Verified Results

```
Real LLM E2E (GPT-5.4 via OAuth):
  Task: "Create a Calculator module"
  Result: 11/11 runtime tests passed
  Cost: $0 (OAuth)
  Time: ~30 seconds

Test Suite: 47 files, 318+ tests, 0 failures
```

---

## Inspired By

Built from the best of **22 open-source repos**:

OpenHands · Codex · Cline · Aider · SWE-Agent · AutoGPT · MetaGPT · CrewAI · Plandex · Goose · oh-my-openagent · oh-my-claudecode · bolt.diy · Devika · Continue · OpenCode · OpenClaw · LangGraph · LangFlow · Void · Claude Code · Claude Skills

---

## License

MIT

---

<p align="center">
  <b>Open Seed</b> · Autonomous AGI Coding Engine<br>
  <i>The last engineer you'll ever need.</i><br><br>
  40 roles · 49 subsystems · 0 excuses
</p>
