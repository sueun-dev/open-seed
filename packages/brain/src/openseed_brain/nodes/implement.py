"""
Implement node — Execute the plan by generating code.

Supports 3 modes based on state["provider"]:
  "claude" → Claude only (deep, sequential)
  "codex"  → Codex only (fast, parallel)
  "both"   → Claude architecture + Codex parallel implementation
"""

from __future__ import annotations

import asyncio

from openseed_brain.state import PipelineState, Implementation


def _build_plan_text(state: PipelineState) -> str:
    plan = state.get("plan")
    if not plan:
        return ""
    parts = [f"Summary: {plan.summary}"]
    for t in plan.tasks:
        parts.append(f"- {t.id}: {t.description} (files: {', '.join(t.files)})")
    parts.append("\nFiles to create:")
    for f in plan.file_manifest:
        parts.append(f"- {f.path}: {f.purpose}")
    return "\n".join(parts)


async def _implement_claude(state: PipelineState) -> Implementation:
    """Full implementation via Claude."""
    from openseed_left_hand.agent import ClaudeAgent
    agent = ClaudeAgent()
    plan_text = _build_plan_text(state)

    response = await agent.invoke(
        prompt=f"""Implement this plan. Write ALL files with COMPLETE code.

Task: {state["task"]}
Working directory: {state["working_dir"]}

Plan:
{plan_text}

Rules:
- Write EVERY file listed in the plan
- Each file must be COMPLETE and RUNNABLE
- No placeholders, no TODOs
- If package.json is needed, create it with all deps
- Run npm install after creating package.json if needed""",
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=15,
    )

    return Implementation(summary=response.text[:500], raw_output=response.text)


async def _implement_codex(state: PipelineState) -> Implementation:
    """Fast parallel implementation via Codex."""
    from openseed_right_hand.agent import CodexAgent
    agent = CodexAgent()
    plan_text = _build_plan_text(state)

    response = await agent.invoke(
        prompt=f"""Implement this plan. Write ALL files.

Task: {state["task"]}

Plan:
{plan_text}

Write every file with complete code. No placeholders.""",
        working_dir=state["working_dir"],
    )

    return Implementation(
        summary=response.text[:500],
        files_created=response.files_created,
        files_modified=response.files_modified,
        raw_output=response.text,
    )


async def _implement_both(state: PipelineState) -> Implementation:
    """Claude designs architecture, Codex implements in parallel."""
    from openseed_left_hand.agent import ClaudeAgent
    from openseed_right_hand.agent import CodexAgent

    plan_text = _build_plan_text(state)

    # Phase 1: Claude creates the core architecture files
    claude = ClaudeAgent()
    arch_response = await claude.invoke(
        prompt=f"""Create the core architecture files for this project.
Focus on: entry point, main server/app file, config, types.
Other files will be created by a parallel agent.

Task: {state["task"]}
Working directory: {state["working_dir"]}

Plan:
{plan_text}

Write only the 3-4 most critical files. Be thorough.""",
        model="sonnet",
        working_dir=state["working_dir"],
        max_turns=8,
    )

    # Phase 2: Codex fills in remaining files in parallel
    codex = CodexAgent()
    impl_response = await codex.invoke(
        prompt=f"""Complete the remaining files for this project.
Some core files already exist — read them first, then create the rest.

Task: {state["task"]}

Plan:
{plan_text}

Read existing files, then write ALL missing files. No duplicates.""",
        working_dir=state["working_dir"],
    )

    return Implementation(
        summary=f"Claude: {arch_response.text[:200]} | Codex: {impl_response.text[:200]}",
        files_created=impl_response.files_created,
        raw_output=f"=== Claude ===\n{arch_response.text}\n\n=== Codex ===\n{impl_response.text}",
    )


async def implement_node(state: PipelineState) -> dict:
    """Execute the plan using the selected provider."""
    provider = state.get("provider", "claude")

    if provider == "codex":
        impl = await _implement_codex(state)
    elif provider == "both":
        impl = await _implement_both(state)
    else:
        impl = await _implement_claude(state)

    return {
        "implementation": impl,
        "messages": [f"Implement [{provider}]: {impl.summary[:300]}"],
    }
