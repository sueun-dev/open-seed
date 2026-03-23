<p align="center">
  <img src="https://img.shields.io/badge/AGI-Autonomous_Coding_Engine-blue?style=for-the-badge&logo=openai" alt="AGI Badge">
  <img src="https://img.shields.io/badge/Roles-40_Neural_Specialists-purple?style=for-the-badge" alt="Roles">
  <img src="https://img.shields.io/badge/Tools-29_Built--in-orange?style=for-the-badge" alt="Tools">
  <img src="https://img.shields.io/badge/Cost-$0_OAuth-green?style=for-the-badge" alt="Cost">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed</h1>

<p align="center">
  <b>Autonomous AGI Coding Engine</b><br>
  <sub>One prompt. Full-stack app. Zero human intervention.</sub>
</p>

<p align="center">
  <code>49 subsystems</code> · <code>40 neural roles</code> · <code>29 tools</code> · <code>AGI Pipeline V2</code>
</p>

---

## The AGI Pipeline

Open Seed doesn't autocomplete. It doesn't suggest. It **thinks, debates, designs, builds, verifies, and fixes** — fully autonomously.

```
"게임 개발해줘"

  [ANALYZE]   AI classifies intent, assesses scope, identifies risks
              → "Too vague. What kind of game?"
              → Presents interactive clarification UI to user

  User picks: .io multiplayer, browser, 2D geometric, 10-50 players

  [DEBATE]    Multiple specialist AIs debate architecture
              → Option A: Node.js + Socket.IO + Canvas (RECOMMENDED)
              → Option B: Raw WebSocket — rejected (more boilerplate)
              → Option C: TypeScript + Vite — rejected (overkill)

  [DESIGN]    Turns debate winner into build-ready file manifest
              → 12 files, 3 build waves, server-authoritative architecture

  [BUILD]     Writes every file. Real code. npm install. Done.
              → 12 files created, 13 tool calls, 0 errors

  [VERIFY]    Runs tests, checks deliverables exist
              → 50/50 tests passed. All files present.

  [FIX]       Skipped — VERIFY passed. Nothing to fix.

  Pipeline COMPLETE: 6/6 steps | 12 files | ~12 minutes
```

**Every decision is made by AI.** No regex. No hardcoded rules. No category matching. The AI decides what tech stack to use, how many files to create, and when to ask the user for clarification.

---

## How It Works

```
USER PROMPT
    │
    ▼
┌─────────┐     AI analyzes the request.
│ ANALYZE │     If vague → asks user interactive questions.
└────┬────┘     If specific → proceeds immediately.
     │
     ▼
┌─────────┐     Multiple AI specialists debate architecture.
│ DEBATE  │     3 options compared. Best one selected.
└────┬────┘     DEBATE conclusions override ANALYZE.
     │
     ▼
┌─────────┐     AI creates file manifest, build waves, test plan.
│ DESIGN  │     Based on DEBATE winner — not raw ANALYZE.
└────┬────┘     ANALYZE artifact updated with DEBATE conclusions.
     │
     ▼
┌─────────┐     Real code written to disk. npm install. Done.
│ BUILD   │     One delegate per file. No conflicts.
└────┬────┘     Only writing-capable roles assigned.
     │
     ▼
┌─────────┐     Tests run. Deliverables checked.
│ VERIFY  │     Missing core file = FAIL (even if tests pass).
└────┬────┘
     │
     ├── PASS → FIX skipped → Pipeline COMPLETE
     │
     └── FAIL ──▶ ┌──────┐     AI reads errors, writes fixes.
                  │ FIX  │     Creates missing files, fixes bugs.
                  └──┬───┘
                     │
                     └──▶ VERIFY again (max 3 cycles)
                          └── Still failing? → Ask user for help
```

### Key Principles

- **DEBATE overrides ANALYZE** — ANALYZE can be wrong. DEBATE reviews and corrects it. DESIGN only sees the corrected version.
- **AI decides everything** — No regex categorization. No hardcoded file templates. The AI determines tech stack, file structure, and architecture.
- **Never gives up** — If FIX can't resolve after multiple approaches, it asks the user instead of silently failing.
- **Clarification when needed** — Vague requests trigger an interactive UI with options. Specific requests proceed immediately.

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
# Single agent
node dist/cli.js run "Create a calculator with add, subtract, multiply, divide"

# Team mode (parallel workers)
node dist/cli.js team "Build a REST API with authentication"

# One-prompt app generation
node dist/cli.js create "Build a todo app with React"

# Diagnostics
node dist/cli.js doctor
```

---

## Provider Setup ($0 with Subscriptions)

### Anthropic (Claude Opus 4.6 via OAuth)
```bash
claude auth login  # Token auto-detected from macOS Keychain
```

### OpenAI (GPT-5.4 via Codex OAuth)
```bash
npx codex auth    # Token auto-detected from ~/.codex/auth.json
```

Both providers work via OAuth — **$0 cost** with existing subscriptions.

---

## AGI Pipeline V2: What Makes It Different

| Feature | Other Agents | Open Seed |
|---|---|---|
| Architecture decisions | Hardcoded rules / regex | AI debates 3 options, picks best |
| Clarification | Never asks | Asks when vague, skips when specific |
| Inter-step memory | None | Full context carries through all steps |
| ANALYZE errors | Fatal | Expected — DEBATE corrects them |
| File structure | Template-based | AI decides from scratch |
| Tech stack selection | Category matching | AI evaluates trade-offs |
| Failure handling | Stop or retry same approach | Different strategy, then ask user |
| VERIFY-FIX loop | Fixed 3 retries | Loop until pass, escalate to user |
| Delegation in BUILD | All roles assigned | Only writing-capable roles |

---

## 29 Built-in Tools

### File Operations
| Tool | Description |
|---|---|
| `read` | Read files with optional hash-anchored line markers |
| `write` | Write complete files |
| `apply_patch` | Hash-anchored edits (zero stale-line errors) |
| `multi_patch` | Atomic multi-file patches with rollback |
| `ls` | Directory tree listing |
| `glob` | Pattern-based file discovery |
| `grep` | Regex search across workspace |

### Shell & Process
| Tool | Description |
|---|---|
| `bash` | Shell commands (banned command protection) |
| `git` | Git operations |
| `interactive_bash` | Tmux-based interactive terminal |
| `process_start/list/stop` | Background process management |

### Code Intelligence
| Tool | Description |
|---|---|
| `lsp_diagnostics` | TypeScript errors and warnings |
| `ast_grep` | AST-based structural code search |
| `repo_map` | Repository structure mapping |

### Network & Browser
| Tool | Description |
|---|---|
| `web_search` | Web search for documentation |
| `fetch` | Download URL content |
| `browser` | Headless browser automation (Playwright) |

### Agent & Memory
| Tool | Description |
|---|---|
| `call_agent` | Spawn specialist sub-agents |
| `memory_search/save` | Long-term project memory |
| `session_list/send/history` | Inter-agent messaging |

---

## 40 Neural Roles

<details>
<summary>View all 40 specialist roles</summary>

**Planning:** orchestrator, planner, api-designer, docs-writer, prompt-engineer, release-manager, cost-optimizer, model-router

**Research:** researcher, repo-mapper, search-specialist, dependency-analyst

**Execution:** executor, git-strategist, pr-author, build-doctor, test-engineer, debugger, backend-engineer, db-engineer, performance-engineer, devops-engineer, cicd-engineer, observability-engineer, refactor-specialist, code-simplifier, migration-engineer, toolsmith

**Frontend:** frontend-engineer, ux-designer, accessibility-auditor, browser-operator

**Review:** reviewer, security-auditor, risk-analyst, benchmark-analyst, compliance-reviewer

</details>

---

## 49 Integrated Subsystems

| Category | Subsystems |
|---|---|
| **Core Engine** | Event Bus, Enforcer Loop, Task DAG, Spawn Reservation, Hooks, AGI Pipeline V2 |
| **Safety** | Rules Engine, Write Guard, Edit Recovery, File Lock, Circuit Breaker, Banned Commands |
| **Intelligence** | Intent Gate, Codebase Assessment, Model Router, Factcheck, Confidence Engine, Strategy Branching |
| **Recovery** | Self-Healing, Stuck Detector, Oracle Escalation, Graceful Degradation, Context Recovery |
| **Memory** | Memory Pipeline, Microagents, Context Cache, Project Memory |
| **Execution** | Verify-Fix Loop, Workspace Checkpoint, Native Tool Calling, Durable Execution |
| **Streaming** | Event Flows, Streaming Protocol, HUD, Token Budget, Cost Tracker |
| **Integration** | MCP Client/Server, Model Variants, Prompt Templates, Repo Map |
| **Automation** | Cron Scheduler, Process Manager, Background Agent Manager |

---

## Web UI

Full IDE experience in the browser:

- **AGI Mode** — Dynamic pipeline with real-time activity log. Every tool call, phase transition, AI decision visible.
- **Clarification UI** — Interactive option cards when the AI needs more direction.
- **File Explorer** — VSCode-style tree, git status badges, drag-and-drop, inline rename.
- **Code Editor** — Syntax highlighting, line numbers, Cmd+S save.
- **Terminal** — Real shell with command history.
- **AI Chat** — Build / Ask / AGI modes.
- **Dashboard** — Real-time: Phase, Steps, Files, Tools, Tokens, Cost, Elapsed, Replans.

---

## Security

### Banned Commands
`curl | sh`, `rm -rf /`, fork bombs, `dd` to devices, `chmod 777 /`, `eval $(curl ...)`

### Safety Guards
| Guard | What it does |
|---|---|
| Write Guard | Blocks writes to unread files |
| Edit Recovery | Auto-recovers from failed edits |
| Circuit Breaker | Stops cascading failures |
| Stuck Detector | Breaks infinite loops |
| Diff Sandbox | All writes staged before commit |
| Graceful Degradation | Falls back when subsystems fail |

---

## License

MIT

---

<p align="center">
  <sub>Built by <a href="https://github.com/sueun-dev">@sueun-dev</a></sub>
</p>
