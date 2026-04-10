<p align="center">
  <img src="https://img.shields.io/badge/Status-Legacy_(Paused)-orange?style=for-the-badge" alt="Status">
  <img src="https://img.shields.io/badge/v2.1-GPT--5.4_Powered-purple?style=for-the-badge" alt="v2.1">
  <img src="https://img.shields.io/badge/Tests-525_Passing-brightgreen?style=for-the-badge" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed v2.1 <sup>(Legacy)</sup></h1>

<p align="center">
  <b>An attempt to build a fully autonomous AGI coding engine. Paused for now.</b><br>
  <sub>Will return with a better approach.</sub>
</p>

---

## Postmortem: What Happened

We tried to build an autonomous coding pipeline that takes a single sentence and outputs a working, deployed application — zero human intervention. The 7-node pipeline (intake → plan → implement → QA → fix → deploy → memorize) **works end-to-end**, but hit fundamental walls that make it impractical in its current form.

### What Worked
- **Pipeline architecture** — 7 LangGraph nodes with retry, checkpoint, and streaming. Solid foundation.
- **Harness engineering** — Auto-generated AGENTS.md, quality scoring, propagation to all nodes.
- **QA Gate** — 136 specialist agents with LLM selection and synthesis. Catches real bugs.
- **Memory system** — Fact extraction, failure learning, vector search. Each run genuinely makes the next smarter.
- **525 unit tests passing**, architecture enforcement, clean CI.

### What Didn't Work
- **Codex CLI subprocess overhead** — Every AI call spawns a new `codex exec` process. Cold start ~20-30s per call. A single pipeline run takes 20-40 minutes. Unusable for iterative development.
- **OAuth-only constraint** — Anthropic banned third-party OAuth usage, forcing a full migration from Claude to GPT-5.4 via Codex CLI. API keys would have been 10x faster (streaming, no cold start) but we committed to $0 cost.
- **Fix loop spiral** — QA finds 20 issues → fix attempts 1 file → QA finds 19 issues → repeat 10 times. Each cycle is ~10 minutes. Some runs never converge.
- **Specialist file writing** — Codex CLI refuses to write files outside git repos (`--skip-git-repo-check` needed), silently fails in non-trusted directories, and hangs indefinitely when given too many files (30+ files to one specialist = 1+ hours).
- **Prompt fragility** — GPT-5.4 copies placeholder text verbatim (`<question text>`, `<requirement 1>`). Every prompt needed real examples + "DO NOT COPY" instructions. Claude handled abstract templates naturally; GPT doesn't.
- **Stale cache bugs** — Plan from Project A leaked into Project B via localStorage/global state. Fixed 6 separate leakage vectors, but the pattern kept recurring.
- **Mock data tendency** — AI defaulted to hardcoded fake data instead of connecting to real APIs. Required explicit "NEVER use mock data" rules.

### Key Numbers
| Metric | Value |
|--------|-------|
| Intake (question generation) | ~2-3 min |
| Plan generation | ~1-2 min |
| Implementation | ~10-15 min |
| QA + Fix loop (per cycle) | ~10 min |
| **Total pipeline (simple app)** | **20-40 min** |
| Fix loop convergence rate | ~60% (some never finish) |

### Lessons Learned
1. **Subprocess-based AI is too slow.** Direct API streaming is the only viable path for interactive use.
2. **Multi-agent orchestration needs shared context.** Each specialist working in isolation creates integration nightmares.
3. **Fix loops need circuit breakers, not just retries.** Exponential backoff doesn't help when the fix strategy is wrong.
4. **AI coding tools are assistants, not autonomous agents.** The gap between "helps you code" and "codes by itself" is enormous.

### What's Next
**Coming back with a fundamentally different approach.** The pipeline architecture and harness system are worth keeping. The execution layer needs a complete rethink — probably direct API calls, shared agent context, and human-in-the-loop at decision points instead of full autonomy.

---

## Original README (v2.1)

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
