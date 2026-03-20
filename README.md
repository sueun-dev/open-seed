<p align="center">
  <img src="https://img.shields.io/badge/AGI-Autonomous_Coding_Engine-blue?style=for-the-badge&logo=openai" alt="AGI Badge">
  <img src="https://img.shields.io/badge/Roles-40_Neural_Specialists-purple?style=for-the-badge" alt="Roles">
  <img src="https://img.shields.io/badge/Cost-$0_OAuth-green?style=for-the-badge" alt="Cost">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed</h1>

<p align="center">
  <b>Autonomous AGI Coding Engine</b><br>
  <sub>One prompt. Full-stack app. Zero human intervention.</sub>
</p>

<p align="center">
  <code>49 subsystems</code> · <code>40 neural roles</code> · <code>14 tools</code> · <code>6-phase pipeline</code>
</p>

---

## What is Open Seed?

Open Seed is an **autonomous AI agent** that builds complete software from a single prompt. It does not autocomplete. It does not suggest. It **plans, writes, tests, debugs, and ships** — fully autonomously.

```
$ openseed run "todo 앱 만들어줘"

→ Phase 1: ANALYZE — intent classification, codebase assessment
→ Phase 2: DESIGN — architecture, file structure, task breakdown
→ Phase 3: BUILD — 40 specialist roles write complete code
→ Phase 4: VERIFY — type-check, tests, build validation
→ Phase 5: IMPROVE — security audit, performance, test coverage
→ Phase 6: REVIEW — final quality gate

✓ 6/6 phases passed
📁 workspace/todo-app/ — complete runnable project
```

Powered by **GPT-5.4 + Claude Opus 4.6** via OAuth. **$0 cost** with subscription.

---

## AGI Pipeline — The Prometheus Engine

Every request flows through a 6-phase autonomous pipeline:

```
                    ┌─────────────────────────────────┐
                    │         USER PROMPT              │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 1: ANALYZE               │
                    │   Intent Gate → 13 classifications│
                    │   Codebase Assessment → maturity  │
                    │   Risk Analysis → scope mapping   │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 2: DESIGN                │
                    │   Architecture → file planning    │
                    │   Task DAG → dependency graph     │
                    │   Role Assignment → 40 specialists│
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 3: BUILD                 │
                    │   Native Tool Calling → write/bash│
                    │   Diff Sandbox → staged writes    │
                    │   Multi-turn Agentic Loop         │
                    │   Parallel Delegation → workers   │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 4: VERIFY                │
                    │   TypeScript diagnostics          │
                    │   Test execution                  │
                    │   Build validation                │
                    │   Auto-fix loop (up to 3x)        │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 5: IMPROVE               │
                    │   Security audit                  │
                    │   Performance analysis            │
                    │   Test coverage gaps              │
                    │   Documentation generation        │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   PHASE 6: FINAL REVIEW          │
                    │   40 specialist cross-review      │
                    │   Quality gate → pass/fail        │
                    │   Evidence requirements check     │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │   ✓ COMPLETE                     │
                    │   Files → workspace/{project}/   │
                    │   npm install && npm start        │
                    └─────────────────────────────────┘
```

---

## Why Open Seed?

| | Copilots | AI Chatbots | **Open Seed** |
|---|---|---|---|
| Writes code | ✓ | ✓ | ✓ |
| Plans architecture | ✗ | partial | **✓** |
| Creates entire projects | ✗ | ✗ | **✓** |
| Runs & fixes tests | ✗ | ✗ | **✓** |
| Self-heals on errors | ✗ | ✗ | **✓** |
| Verifies own output | ✗ | ✗ | **✓** |
| 40 specialist roles | ✗ | ✗ | **✓** |
| Multi-provider failover | ✗ | ✗ | **✓** |
| Workspace isolation | ✗ | ✗ | **✓** |
| Learns across sessions | ✗ | ✗ | **✓** |
| Fully autonomous pipeline | ✗ | ✗ | **✓** |

---

## Quick Start

### Web UI (Recommended)

```bash
git clone https://github.com/sueun-dev/open-seed.git
cd open-seed
npm install
npm run build
node app/server.js --port 4040
```

Open **http://localhost:4040** — full IDE with AGI mode, explorer, editor, terminal, AI chat.

### CLI

```bash
# Single agent mode
node dist/cli.js run "Create a calculator with add, subtract, multiply, divide"

# Team mode (parallel specialist workers)
node dist/cli.js team "Build a REST API with authentication"

# One-prompt app generation
node dist/cli.js create "Build a todo app with React"

# Diagnostics
node dist/cli.js doctor
```

### AGI Mode (Web UI)

Click **AGI Mode** → Type your prompt → Click **AGI Start**

The engine automatically runs all 6 phases. Generated projects are saved to `workspace/{project-name}/` with complete structure:

```
workspace/todo-app/
├── package.json          # dependencies, scripts
├── vite.config.js        # build config
├── src/
│   ├── main.js           # entry point
│   ├── todo.js           # core logic
│   └── style.css         # styles
├── public/
├── tests/
│   └── todo.test.js      # test suite
└── dist/                 # production build (auto-generated)
```

---

## Provider Setup — $0 with Subscriptions

### OpenAI (GPT-5.4 via Codex OAuth)
```bash
npx codex auth    # Token auto-detected from ~/.codex/auth.json
```

### Anthropic (Claude Opus 4.6 via OAuth)
```bash
claude auth login  # Token auto-detected from macOS Keychain
```

No API keys needed. OAuth tokens are detected automatically. Or set API keys in the Web UI Settings panel.

---

## Architecture

### 49 Integrated Subsystems

| Category | Subsystems |
|---|---|
| **Core Engine** | Event Bus, Enforcer Loop, Task DAG, Spawn Reservation, Hooks, Prometheus Pipeline |
| **Safety** | Rules Engine, Write Guard, Edit Recovery, File Lock, Agent Babysitter, Circuit Breaker |
| **Intelligence** | Intent Gate, Codebase Assessment, Model Router, Factcheck, Confidence Engine, Strategy Branching |
| **Recovery** | Self-Healing, Stuck Detector, Oracle Escalation, Graceful Degradation, Context Recovery |
| **Memory** | Memory Pipeline, Microagents, Context Cache, Project Memory, Prompt Discovery |
| **Execution** | Diff Sandbox, Verify-Fix Loop, Workspace Checkpoint, Native Tool Calling, Durable Execution |
| **Streaming** | Event Flows, Streaming Protocol, HUD, Token Budget, Cost Tracker |
| **Integration** | MCP Client/Server, Model Variants, Prompt Templates, Repo Map, Language Reviewers |

### 14 Built-in Tools

| Tool | Description |
|---|---|
| `read` | Read files from workspace |
| `write` | Write complete files (via Diff Sandbox) |
| `apply_patch` | Hash-anchored edits |
| `bash` | Run shell commands (unlimited timeout) |
| `grep` | Regex search across files |
| `glob` | Pattern-based file discovery |
| `git` | Git operations |
| `browser` | Headless browser automation |
| `lsp_diagnostics` | TypeScript error checking |
| `lsp_symbols` | Symbol extraction |
| `ast_grep` | AST-based code search |
| `repo_map` | Repository structure mapping |
| `web_search` | Web search |
| `session_history` | Session context |

### 40 Neural Roles

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

Full IDE experience in the browser:

- **AGI Mode** — 6-phase autonomous pipeline with real-time progress dashboard
- **File Explorer** — collapsible folder tree, create/rename/delete, right-click context menu
- **Code Editor** — syntax highlighting, line numbers, tab indent, Cmd+S save
- **Terminal** — real shell with `cd`, command history, streaming output
- **AI Chat** — Build / Ask / AGI modes with thinking animation + event cards
- **Settings** — Providers, Safety, Engine, Tools, Expert configuration tabs
- **OAuth Manager** — one-click provider authentication

| Shortcut | Action |
|---|---|
| `⌘⇧A` | AI Chat |
| `⌘⇧E` | Explorer |
| `⌘S` | Save |
| `⌘J` | Terminal |

---

## Automatic Guards (Zero Config)

| Guard | What it does |
|---|---|
| Write Guard | Blocks writes to unread files |
| Edit Recovery | Auto-recovers from failed edits |
| Agent Babysitter | Detects and restarts stuck agents |
| Circuit Breaker | Stops cascading failures |
| Stuck Detector | Breaks infinite loops |
| Delegation Retry | Auto-retries failed delegations |
| Context Recovery | Preserves state across compaction |
| Graceful Degradation | Falls back when subsystems fail |

---

## Verified Results

```
E2E AGI Pipeline Test:
  Prompt: "todo 앱 만들어줘"
  Steps: 6/6 passed (ANALYZE → DESIGN → BUILD → VERIFY → IMPROVE → REVIEW)
  Files: Complete project with package.json, src/, tests/, dist/
  Build: npm install + vite build auto-executed
  Time: ~23 minutes
  Cost: $0 (OAuth)

Unit Tests: 47 files, 340 tests, 0 failures
TypeScript: 0 type errors
```

---

## Inspired By

Built from the best of **22 open-source repos** (1.4M+ combined GitHub stars):

OpenHands · Codex · Cline · Aider · SWE-Agent · AutoGPT · MetaGPT · CrewAI · Plandex · Goose · oh-my-openagent · oh-my-claudecode · bolt.diy · Devika · Continue · OpenCode · OpenClaw · LangGraph · LangFlow · Void · Claude Code · Claude Skills

---

## License

MIT

---

<p align="center">
  <b>Open Seed</b><br>
  <sub>Autonomous AGI Coding Engine</sub><br><br>
  <code>One prompt → Complete app</code><br><br>
  <i>Build anything. Ship everything. Sleep well.</i>
</p>
