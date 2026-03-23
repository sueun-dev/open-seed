<p align="center">
  <img src="https://img.shields.io/badge/AGI-Zero_Bug_Autonomous-blue?style=for-the-badge" alt="AGI Badge">
  <img src="https://img.shields.io/badge/v2-Alpha-purple?style=for-the-badge" alt="v2">
  <img src="https://img.shields.io/badge/OAuth-$0_Cost-green?style=for-the-badge" alt="OAuth">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License">
</p>

<h1 align="center">Open Seed v2</h1>

<p align="center">
  <b>Zero-Bug Autonomous AGI Coding Engine</b><br>
  <sub>7 systems. 2 AI providers. 0 errors. Fully autonomous.</sub>
</p>

---

## Architecture

```
                    ┌─────────────────────┐
                    │   Brain (LangGraph)  │
                    │   Task analysis +    │
                    │   routing + state    │
                    └────────┬────────────┘
                             │
                 ┌───────────┴───────────┐
                 │                       │
        ┌────────┴────────┐    ┌────────┴────────┐
        │  Left Hand      │    │  Right Hand     │
        │  Claude Opus    │    │  Codex GPT-5    │
        │  Deep reasoning │    │  Fast parallel  │
        └────────┬────────┘    └────────┬────────┘
                 │                       │
                 └───────────┬───────────┘
                             │
                 ┌───────────┴───────────┐
                 │     QA Gate           │
                 │  136 specialist       │
                 │  reviewers (parallel) │
                 └───────────┬───────────┘
                             │
                 ┌───────────┴───────────┐
                 │     Sisyphus          │
                 │  Build → Test → Fail? │
                 │  → Fix → Retest      │
                 │  Loop until 0 errors  │
                 └───────────┬───────────┘
                             │ pass
                 ┌───────────┴───────────┐
                 │       Body            │
                 │  Deploy / Publish     │
                 │  Channels / Cron      │
                 └───────────┬───────────┘
                             │
                 ┌───────────┴───────────┐
                 │      Memory           │
                 │  Vector DB + SQLite   │
                 │  Failure learning     │
                 └───────────────────────┘
```

## The 7 Systems

| # | System | Source | Role |
|---|--------|--------|------|
| 1 | **Brain** | [LangGraph](https://github.com/langchain-ai/langgraph) | Task analysis, routing, parallel dispatch, checkpointing |
| 2 | **Left Hand** | [Claude Agent SDK](https://github.com/anthropics/claude-code-sdk-python) | Opus deep reasoning, architecture, analysis |
| 3 | **Right Hand** | [Codex](https://github.com/openai/codex) | GPT-5 fast parallel code generation |
| 4 | **QA Gate** | [Codex Subagents](https://github.com/VoltAgent/awesome-codex-subagents) | 136 specialist reviewers (security, correctness, tests, perf) |
| 5 | **Sisyphus** | [OmO](https://github.com/code-yeongyu/oh-my-openagent) | Infinite retry loop until zero errors |
| 6 | **Body** | [OpenClaw](https://github.com/openclaw/openclaw) | Deployment, channels, cron, webhooks |
| 7 | **Memory** | [mem0](https://github.com/mem0ai/mem0) | Vector DB, failure learning, experience accumulation |

## Zero-Bug Pipeline

1. **Brain** analyzes task, routes to Claude and/or Codex
2. **Claude (Opus)** designs architecture, analyzes complexity
3. **Codex (GPT-5)** generates implementation code in parallel
4. **QA Gate** spawns specialist reviewers (security, correctness, tests, performance)
5. **Sisyphus** loops: build → test → fail? → fix → retest. Until 0 errors.
6. **Body** deploys the verified code (git push, npm publish, docker)
7. **Memory** stores everything (results, failures, learnings) for next time

## Quick Start

```bash
git clone https://github.com/sueun-dev/open-seed.git
cd open-seed
uv sync
openseed auth login
openseed run "Build a REST API with authentication"
```

## Tech Stack

- **Python 3.11+** — primary language (LangGraph, Claude SDK, mem0 are Python)
- **TypeScript** — web UI only (React + Vite)
- **uv** — Python monorepo workspace
- **OAuth only** — $0 cost with Claude + OpenAI subscriptions
- **No regex, no hardcoded rules** — every decision by AI

## Status

**v2 alpha** — repo structure established, implementation in progress.

---

<p align="center">
  <sub>Built by <a href="https://github.com/sueun-dev">@sueun-dev</a></sub>
</p>
