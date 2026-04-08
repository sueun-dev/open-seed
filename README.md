<p align="center">
  <img src="https://img.shields.io/badge/AGI-Autonomous_Coding_Engine-blue?style=for-the-badge" alt="AGI Badge">
  <img src="https://img.shields.io/badge/v2.1-GPT--5.4_Powered-purple?style=for-the-badge" alt="v2.1">
  <img src="https://img.shields.io/badge/OAuth-$0_Cost-green?style=for-the-badge" alt="OAuth">
  <img src="https://img.shields.io/badge/Tests-525_Passing-brightgreen?style=for-the-badge" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed v2.1</h1>

<p align="center">
  <b>Autonomous AGI Coding Engine powered by GPT-5.4</b><br>
  <sub>Give it a task. It understands, plans, builds, reviews, fixes, deploys, and remembers. Fully autonomous. Zero cost.</sub>
</p>

---

## What is Open Seed?

Open Seed is a **7-node autonomous pipeline** that turns a single sentence into a working, tested, deployed application. No hand-holding. No copy-paste. No manual debugging.

```
You: "Build a real-time stock dashboard with WebSocket charts"

Open Seed:
  1. Intake    → Analyzes task, researches options, asks smart questions
  2. Plan      → GPT-5.4 designs architecture with cross-checked file manifest
  3. Build     → Domain specialists (frontend/backend/db/infra) code in parallel
  4. QA Gate   → 136 specialist AI reviewers verify the output
  5. Sentinel  → Evidence-based verification — reads files, runs tests, never trusts claims
  6. Deploy    → Git commit, push, build
  7. Memorize  → Extracts lessons, remembers failures, next run is smarter
```

**Every run makes the next one better.** Memory feeds Sentinel, Sentinel feeds QA, QA feeds Memory.

---

## How It Works

### The Pipeline

```
  intake ──→ plan ──→ implement ──→ qa_gate ──→ sentinel ──→ deploy ──→ memorize
    │          │          │            │            │                       │
    │          │          │            │            ↓ fail                  │
    │          │          │            │          fix ──→ qa_gate (retry)   │
    │          │          │            │                                    │
    ↓          ↓          ↓            ↓                                   ↓
  GPT-5.4   GPT-5.4   Specialists   136 AI       Evidence              Vector DB
  research   design    in parallel   reviewers    verification          learning
```

### Intake — Understands Before It Acts

Not a dumb prompt relay. Intake runs **4 parallel AI steps**:

1. **Gap Analysis** — GPT-5.4 identifies what it doesn't know about your task
2. **Skill Selection** — Picks relevant specialist skills from the catalog
3. **Research** — Web searches for each knowledge gap in parallel
4. **Question Formulation** — Research-backed multiple-choice questions

If harness (AGENTS.md) is missing, it generates one from your answers.

### Plan — Cross-Checked Architecture

GPT-5.4 generates a structured plan with:
- **Task decomposition** — Each task gets a domain role (frontend/backend/db/infra)
- **File manifest** — Every file listed with its purpose
- **Cross-checks** — "If frontend calls `/api/users`, backend MUST have that endpoint"
- **Scope control** — MODIFY, CREATE, DO_NOT_TOUCH lists

### Build — Parallel Specialists

Tasks are routed to domain specialists that run **in parallel**:

| Specialist | Domain | What It Knows |
|-----------|--------|--------------|
| Frontend | React, Vue, CSS, routing | Component design, state management, responsive CSS |
| Backend | APIs, auth, middleware | REST patterns, JWT, validation, error handling |
| Database | Schema, migrations, ORM | Normalization, indexing, transactions |
| Infra | Config, Docker, CI | package.json, env vars, build scripts |
| Fullstack | Everything | When splitting doesn't make sense |

After parallel execution: **integration check** verifies all pieces work together.

### QA Gate — 136 Specialist Reviewers

Not one reviewer. **136 TOML-defined specialist agents** across 10 categories:

```
Core Dev (15) · Language (28) · Infrastructure (18) · Security (10)
Data & AI (12) · DX (8) · Domain (15) · Business (10) · Orchestration (10) · Research (10)
```

GPT-5.4 picks the 3-5 most relevant reviewers per task. A knowledge synthesizer resolves conflicts, removes false positives, and produces a verdict: **PASS / WARN / BLOCK**.

### Sentinel — Trust Nothing, Verify Everything

The final gatekeeper. Sentinel:
- **Reads actual files** — never trusts "I created the file"
- **Runs actual tests** — never trusts "all tests pass"
- **Checks evidence** — diffs, outputs, exit codes
- **Retries with backoff** — exponential backoff with stagnation detection
- **Escalates** — after 3 failed retries, consults Oracle (deep reasoning)

### Memory — Gets Smarter Every Run

Every completed pipeline feeds back into memory:
- **Fact extraction** — GPT-5.4 decomposes results into discrete facts
- **Failure patterns** — Records what went wrong and how it was fixed
- **Wisdom extraction** — Generalizes lessons across runs
- **Vector search** — Next run recalls relevant past experiences

---

## Quick Start

```bash
# Clone
git clone https://github.com/sueun-dev/open-seed.git
cd open-seed

# Install (Python 3.11+)
uv sync

# Authenticate (OAuth — $0 cost)
openseed auth login

# Run autonomously
openseed run "Build a REST API with JWT auth and CRUD"

# Or use the web UI
openseed serve
# Open http://localhost:5173
```

---

## Web UI — Three Modes

### AGI Mode
Full autonomous pipeline. Describe what to build, answer a few smart questions, watch it work. Progress bar shows real-time pipeline status via WebSocket.

### Pair Mode
Direct conversation with GPT-5.4. Code together in real-time. File changes detected automatically.

### Debate Mode
Two GPT-5.4 agents analyze your request independently. A judge picks the best approach and executes it. You see every step of the debate.

### Diagram Mode
Auto-generates Mermaid architecture diagrams from your codebase.

---

## Architecture

```
open-seed/
├── packages/
│   ├── core/       # Types, events, config, auth (OAuth), harness, microagents
│   ├── brain/      # LangGraph pipeline, 7 nodes, streaming, subgraphs
│   ├── codex/      # GPT-5.4 agent via Codex CLI (OAuth subprocess)
│   ├── qa_gate/    # 136 specialist agents, selector, synthesizer, workflow
│   ├── guard/      # Sentinel loop, intent gate, stuck detection, security
│   ├── deploy/     # Git, npm, Docker channels + cron scheduler
│   ├── memory/     # Fact extraction, vector DB, failure learning, reranker
│   └── cli/        # CLI (Click) + FastAPI + WebSocket streaming
├── web/            # React 19 + Vite + TypeScript (AGI/Pair/Debate/Diagram)
├── config/agents/  # 136 TOML specialist definitions
└── tests/          # Architecture enforcement tests
```

### Dependency Flow

```
core (foundation, zero deps)
  ↓
codex / qa_gate / guard / deploy / memory (peer packages, no cross-imports)
  ↓
brain (orchestrator — coordinates all packages)
  ↓
cli (top layer — FastAPI server + commands)
```

Enforced by `tests/test_architecture.py` — CI blocks violations.

---

## Harness Engineering

Open Seed auto-generates project harness (AGENTS.md, CLAUDE.md, pre-commit, CI) for any folder:

- **Deterministic scoring** — 100-point system (Inform 50 + Constrain 25 + Verify 25)
- **Git-aware** — No .git? Pre-commit/CI get N/A. GitHub? `.github/workflows`. GitLab? `.gitlab-ci.yml`
- **AI-enhanced** — GPT-5.4 fills in project-specific content based on your answers
- **All nodes see it** — AGENTS.md propagated to every pipeline node via `microagent_context`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Python 3.11+ (backend), TypeScript (web UI) |
| AI Model | GPT-5.4 via Codex CLI (OAuth, $0 cost) |
| Orchestration | LangGraph StateGraph |
| Auth | OpenAI OAuth only — no API keys in codebase |
| Vector DB | Qdrant, PostgreSQL+pgvector, SQLite (fallback) |
| Web | FastAPI + WebSocket (backend), React 19 + Vite (frontend) |
| Package Manager | uv workspace (Python), npm (web) |
| Testing | pytest + pytest-asyncio (525 tests) |
| Linting | ruff (Python), TypeScript strict mode |

---

## Design Principles

1. **All decisions by AI** — No regex, no hardcoded rules. Every routing, classification, and verdict is a GPT-5.4 call.
2. **OAuth only** — Zero API keys in the codebase. $0 cost within subscription limits.
3. **Evidence-based** — Never trust agent claims. Read actual files, run actual tests.
4. **Self-improving** — Every run extracts facts, records failures, and feeds them into the next run.
5. **Parallel by default** — Specialists run concurrently. Research gaps searched in parallel. Sub-agents enhanced in parallel.

---

## Tests

```bash
pytest packages/*/tests/ tests/ -q
# 525 passed
```

| Package | Tests | What's Tested |
|---------|-------|--------------|
| Brain | 177 | Pipeline, routing, specialists, plan parsing, implement, fix, self-verify |
| Guard | 86 | Intent gate, execution loop, sentinel, stuck detection, security, browser verify |
| QA Gate | 67 | Synthesizer, agent selector, gate logic, workflow, specialist runner |
| Memory | 152 | Store, search, condenser, fact extraction, reranker, wisdom, failure patterns |
| Core | 43 | Harness checker, microagents, metrics, config, architecture enforcement |

---

<p align="center">
  <sub>Built by <a href="https://github.com/sueun-dev">@sueun-dev</a></sub>
</p>
