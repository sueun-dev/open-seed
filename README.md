<p align="center">
  <img src="https://img.shields.io/badge/AGI-Autonomous_Coding_Engine-blue?style=for-the-badge" alt="AGI Badge">
  <img src="https://img.shields.io/badge/v2-Stable-purple?style=for-the-badge" alt="v2">
  <img src="https://img.shields.io/badge/OAuth-$0_Cost-green?style=for-the-badge" alt="OAuth">
  <img src="https://img.shields.io/badge/Tests-421_Passing-brightgreen?style=for-the-badge" alt="Tests">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed v2</h1>

<p align="center">
  <b>Zero-Bug Autonomous AGI Coding Engine</b><br>
  <sub>5 AI systems fused into one self-improving pipeline. Give it a task — it plans, builds, reviews, fixes, deploys, and learns.</sub>
</p>

---

## Why Open Seed?

Every existing AI coding tool does **one thing**:
- **LangGraph** orchestrates — but doesn't code, review, or learn.
- **Claude SDK** reasons deeply — but has no retry loop, no QA, no memory.
- **Codex** generates code fast — but doesn't verify or deploy.
- **mem0** remembers — but has no pipeline to act on memories.

**Open Seed fuses all five into a single autonomous system.** Each part makes the others smarter:

```
Memory remembers past failures
    → Sentinel uses that memory to avoid repeating mistakes
    → Brain retries with checkpoints if anything fails
    → QA Gate verifies with 136 specialist AI reviewers
    → Results feed back into Memory → next run is smarter
```

No other tool does this. Not Claude Code. Not Cursor. Not Codex. They're assistants. **Open Seed is autonomous.**

---

## Architecture

```
                     ┌──────────────────────┐
                     │   🧠 Brain           │
                     │   LangGraph pipeline │
                     │   Retry + Checkpoint │
                     │   5 streaming modes  │
                     └─────────┬────────────┘
                               │
                   ┌───────────┴───────────┐
                   │                       │
          ┌────────┴────────┐    ┌────────┴────────┐
          │  🟣 Left Hand   │    │  🟢 Right Hand  │
          │  Claude Opus    │    │  Codex / GPT    │
          │  Deep reasoning │    │  Fast parallel  │
          │  Structured msg │    │  Git worktree   │
          │  Hooks + MCP    │    │  Sandbox        │
          └────────┬────────┘    └────────┬────────┘
                   │                       │
                   └───────────┬───────────┘
                               │
                   ┌───────────┴───────────┐
                   │  🔍 QA Gate           │
                   │  136 specialist agents │
                   │  LLM agent selection  │
                   │  Knowledge synthesis  │
                   │  4-stage workflow     │
                   └───────────┬───────────┘
                               │
                   ┌───────────┴───────────┐
                   │  🛡️ Sentinel          │
                   │  7-step exec loop     │
                   │  Intent classification│
                   │  Evidence verification│
                   │  Oracle escalation    │
                   └───────────┬───────────┘
                               │ pass
                   ┌───────────┴───────────┐
                   │  📦 Body              │
                   │  Git / npm / Docker   │
                   │  Cron scheduler       │
                   │  Webhook receiver     │
                   └───────────┬───────────┘
                               │
                   ┌───────────┴───────────┐
                   │  🧬 Memory            │
                   │  LLM fact extraction  │
                   │  Vector DB + SQLite   │
                   │  Failure learning     │
                   │  LLM reranking        │
                   └───────────────────────┘
```

---

## The 5 Core Systems

### 🧠 Brain — Orchestration
> Pattern from: [LangGraph](https://github.com/langchain-ai/langgraph)

- **StateGraph** pipeline with 9 nodes and conditional routing
- **RetryPolicy** per node — exponential backoff + jitter, never dies on first failure
- **AsyncSqliteSaver** checkpointing — crash recovery + time travel (fork from any checkpoint)
- **5 streaming modes** — updates, values, messages, tasks, custom
- **Subgraph composition** — QA Gate and Fix loop as nested graphs
- **Human-in-the-loop** — `interrupt_before` pauses for user input when stuck

### 🟣 Left Hand — Claude Agent
> Pattern from: [Claude Agent SDK](https://github.com/anthropics/claude-code-sdk-python)

- **Structured messages** — TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock
- **NDJSON parser** with plain text fallback
- **Cost estimation** — per-model pricing (Opus/Sonnet/Haiku)
- **Token usage tracking** — input, output, cache read/write
- **5 hooks** — PreToolUse, PostToolUse, Stop, OnError, OnThinking
- **MCP integration** — stdio, SSE, HTTP transports for custom tools
- **Structured output** — JSON schema enforcement + validation
- **5 roles** — Architect (Opus), Implementer (Sonnet), Reviewer, Debugger, Oracle

### 🛡️ Sentinel — Verification & Retry
> Pattern from: [OmO](https://github.com/code-yeongyu/oh-my-openagent)

- **Intent Gate** — 6 intent types (research, implementation, investigation, evaluation, fix, open-ended)
- **7-step execution loop** — EXPLORE → PLAN → ROUTE → EXECUTE → VERIFY → RETRY → DONE
- **Multi-model prompts** — Claude (precise), GPT (8-block), Gemini (corrective overlays)
- **Evidence-based verification** — reads actual files, runs actual tests (never trusts agent claims)
- **Delegation system** — 6-section structured prompts (TASK/OUTCOME/TOOLS/MUST DO/MUST NOT/CONTEXT)
- **Oracle escalation** — Claude Opus with extended thinking for stuck situations
- **Stagnation detection** — 3-cycle threshold → strategy switch → oracle → user escalation

### 🔍 QA Gate — Multi-Agent Review
> Pattern from: [awesome-codex-subagents](https://github.com/VoltAgent/awesome-codex-subagents)

- **136 specialist agents** across 10 categories (core dev, language, infra, security, data/AI, DX, domains, business, orchestration, research)
- **LLM agent selection** — Claude Haiku picks the 3-5 most relevant reviewers per task
- **Knowledge synthesizer** — conflict resolution, confidence weighting, false positive detection, evidence traceability
- **4-stage workflow** — Discovery → Review → Validation → Synthesis with go/no-go gates
- **Output contract** — JSON schema enforced on every agent response

### 🧬 Memory — Long-term Learning
> Pattern from: [mem0](https://github.com/mem0ai/mem0)

- **LLM fact extraction** — Claude decomposes raw text into discrete facts, decides ADD/UPDATE/DELETE/NOOP
- **LLM reranking** — search results re-scored by semantic relevance
- **3 backends** — Qdrant (vector), PostgreSQL + pgvector, SQLite (zero-config fallback)
- **Backend factory** — auto-selects best available backend
- **Advanced filters** — AND/OR/NOT, $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin
- **Procedural memory** — stores successful procedures for reuse
- **Failure pattern learning** — records failures → next run avoids same mistakes

---

## The Synergy Cycle

This is what makes Open Seed unique. No individual tool has this:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  intake ── Sentinel(intent) + Memory(recall) + Claude   │
│    ↓                                                    │
│  plan ──── Claude(architecture)                         │
│    ↓                                                    │
│  implement ── Claude/Codex(code) + Brain(retry×3)       │
│    ↓                                                    │
│  qa_gate ── QA(select→review→synthesize) + Brain(retry) │
│    ↓                                                    │
│  sentinel ── Sentinel(verify evidence) + evaluate_loop  │
│    ↓ fail                                               │
│  fix ────── Memory(past failures) + Claude(fix)         │
│    ↓ loop back to qa_gate                               │
│  deploy ─── Body(git/npm/docker) + Brain(retry)         │
│    ↓                                                    │
│  memorize ── Memory(fact extraction + failure learning)  │
│    ↓                                                    │
│  [next run starts smarter]                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Every node connects to at least 2 systems.** Memory feeds Sentinel, Sentinel feeds QA, QA feeds Memory. The cycle never stops improving.

---

## Quick Start

```bash
# Clone
git clone https://github.com/sueun-dev/open-seed.git
cd open-seed

# Install (Python 3.11+ required)
uv sync

# Authenticate (OAuth — $0 cost)
openseed auth login

# Run
openseed run "Build a REST API with JWT authentication"

# Or use the web UI
openseed serve
# → http://localhost:8000
```

### Provider Selection

```bash
# Claude only (deep, sequential)
openseed run --provider claude "Refactor the auth module"

# Codex only (fast, parallel)
openseed run --provider codex "Add unit tests for all endpoints"

# Both (Claude architects, Codex implements)
openseed run --provider both "Build a real-time chat application"
```

---

## Project Structure

```
open-seed/
├── packages/
│   ├── core/          # Shared types, events, config, auth
│   ├── brain/         # LangGraph pipeline, retry, checkpoint, streaming, subgraphs
│   ├── left_hand/     # Claude agent, messages, parser, hooks, MCP
│   ├── right_hand/    # Codex agent, parallel execution, git worktree
│   ├── qa_gate/       # 136 agents, selector, synthesizer, workflow, categories
│   ├── sentinel/      # Intent gate, 7-step loop, multi-model prompts, delegation
│   ├── body/          # Deploy channels (git/npm/docker), cron, webhooks
│   ├── memory/        # Fact extraction, reranker, filters, 3 backends, factory
│   └── cli/           # CLI commands, FastAPI server, WebSocket events
├── config/
│   └── agents/        # 136 TOML specialist agent definitions (10 categories)
├── web/               # React + Vite UI (provider selector, pipeline viz, logs)
└── tests/             # E2E and integration tests
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Python 3.11+ (backend), TypeScript (web UI) |
| Orchestration | LangGraph StateGraph |
| AI Providers | Claude (Opus/Sonnet/Haiku), Codex (GPT) |
| Auth | OAuth only — $0 with Pro subscriptions |
| Vector DB | Qdrant, PostgreSQL+pgvector, SQLite (fallback) |
| Web | FastAPI + WebSocket (backend), React + Vite (frontend) |
| Package Manager | uv workspace (Python), pnpm (web) |
| Testing | pytest + pytest-asyncio (421 tests) |

---

## Key Design Principles

1. **All decisions by AI** — No regex, no hardcoded rules. Every routing, classification, and verdict is an LLM call.
2. **OAuth only** — Never API keys. $0 cost within Claude/OpenAI subscription limits.
3. **Evidence-based** — Never trust agent claims. Read actual files, run actual tests, verify actual output.
4. **Graceful degradation** — Every LLM call has a fallback. Memory unavailable? Proceed without it. Claude down? Try Codex.
5. **Self-improving** — Every run makes the next one smarter through Memory's fact extraction and failure learning.

---

## Tests

```bash
# Run all tests
uv run pytest packages/*/tests/ -q

# 421 passed in 0.53s
```

| Package | Tests | Coverage |
|---------|-------|----------|
| Memory | 121 | Fact extraction, reranker, filters, SQLite, store, failure, procedural |
| Brain | 54 | Retry, checkpoint, routing, graph, subgraphs |
| Sentinel | 55 | Intent gate, execution loop, delegation, backoff, stagnation, progress |
| QA Gate | 62 | Synthesizer, agent selector, gate, workflow, types |
| Left Hand | 129 | Messages, parser, roles, agent, hooks, MCP, structured output |

---

## Status

**v2 stable** — 5-system integration complete, 421 tests passing, ready for production testing.

---

<p align="center">
  <sub>Built by <a href="https://github.com/sueun-dev">@sueun-dev</a></sub>
</p>
