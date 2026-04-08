"""
Open Seed v2 — LLM-based agent selector.

Uses Claude Haiku (fast decision) to pick which specialist agents are
most relevant for a given task instead of running all available agents.

Pattern from: awesome-codex-subagents agent-organizer TOML.
Working mode:
- Map the full task into critical-path and sidecar components
- Decide what needs to be reviewed by which specialists
- Assign roles with explicit read/write boundaries
- Optimize delegation so each thread has one clear purpose

Rules:
- OAuth only (no API keys), uses Claude CLI subprocess
- All decisions by LLM — no hardcoded selection rules
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openseed_qa_gate.types import AgentDefinition

logger = logging.getLogger(__name__)


async def select_agents(
    task: str,
    implementation_summary: str,
    available_agents: list[AgentDefinition],
    max_agents: int = 5,
) -> list[AgentDefinition]:
    """
    Ask Claude Haiku which agents are most relevant for this task.

    Follows the agent-organizer.toml pattern:
    - Each selected agent gets one clear purpose
    - No duplicate ownership across concurrent review threads
    - Prompt specificity for bounded, high-signal subagent output

    Args:
        task: The original task / user request being reviewed
        implementation_summary: Brief summary of what was implemented
        available_agents: Full list of loaded AgentDefinition objects
        max_agents: Maximum number of agents to select (default 5)

    Returns:
        Subset of available_agents most relevant to this task.
        Falls back to all available_agents if selection fails.
    """
    if not available_agents:
        return []

    # If only a few agents available, no need to filter
    if len(available_agents) <= max_agents:
        logger.debug(
            "select_agents: only %d agents available (max=%d), using all",
            len(available_agents),
            max_agents,
        )
        return available_agents

    try:
        selected = await _select_with_llm(task, implementation_summary, available_agents, max_agents)
        logger.info(
            "select_agents: LLM selected %d/%d agents: %s",
            len(selected),
            len(available_agents),
            [a.name for a in selected],
        )
        return selected
    except Exception as exc:
        logger.warning(
            "select_agents: LLM selection failed (%s), using all %d agents",
            exc,
            len(available_agents),
        )
        return available_agents


async def _select_with_llm(
    task: str,
    implementation_summary: str,
    available_agents: list[AgentDefinition],
    max_agents: int,
) -> list[AgentDefinition]:
    """
    Call Claude Haiku via subprocess to choose the most relevant agents.

    Returns a filtered subset of available_agents.
    Raises on failure so the caller can fall back.
    """
    from openseed_core.auth.openai import require_openai_auth
    from openseed_core.subprocess import run_streaming

    cli = require_openai_auth()

    # Build agent catalog for the prompt
    agent_lines = []
    for agent in available_agents:
        sandbox_note = "(read-only)" if agent.sandbox_mode == "read-only" else "(write)"
        description = agent.description or agent.instructions[:120].replace("\n", " ")
        agent_lines.append(f'- name="{agent.name}" model={agent.model} {sandbox_note}\n  focus: {description}')
    agent_catalog = "\n".join(agent_lines)

    prompt = f"""You are an agent organizer. A task has been implemented and needs QA review.
Your job is to select the {max_agents} most relevant specialist reviewers from the catalog below.

TASK:
{task[:1000]}

IMPLEMENTATION SUMMARY:
{implementation_summary[:500]}

AVAILABLE SPECIALIST AGENTS ({len(available_agents)} total):
{agent_catalog}

SELECTION RULES (from agent-organizer pattern):
- Each selected agent must have one clear, non-overlapping review purpose
- Prioritize agents that cover the highest-risk areas of this specific task
- Do not select agents whose focus does not apply to this task at all
- Maximum {max_agents} agents — quality over quantity
- Prefer read-only agents for pure analysis, write-capable only if needed

Output ONLY a JSON array of agent names (strings), no markdown, no explanation:
["agent-name-1", "agent-name-2", ...]"""

    cmd = [
        cli,
        "exec",
        "--full-auto",
        "-m",
        "gpt-5.4",
        prompt,
    ]

    proc_result = await run_streaming(cmd, timeout_seconds=60)

    if proc_result.timed_out:
        raise RuntimeError("Claude agent selection timed out after 60s")
    if proc_result.exit_code != 0 and not proc_result.stdout.strip():
        raise RuntimeError(f"Claude agent selection failed (exit {proc_result.exit_code}): {proc_result.stderr[:300]}")

    raw_text = proc_result.stdout.strip()

    # Extract JSON array from response
    start = raw_text.find("[")
    end = raw_text.rfind("]")
    if start == -1 or end <= start:
        raise RuntimeError(f"No JSON array found in Claude agent-selector response: {raw_text[:300]}")

    selected_names: list[str] = json.loads(raw_text[start : end + 1])

    if not isinstance(selected_names, list):
        raise RuntimeError(f"Expected JSON array, got: {type(selected_names)}")

    # Validate and filter — only keep names that exist in available_agents
    name_to_agent = {a.name: a for a in available_agents}
    selected: list[AgentDefinition] = []
    seen: set[str] = set()
    for name in selected_names:
        if not isinstance(name, str):
            continue
        if name in name_to_agent and name not in seen:
            selected.append(name_to_agent[name])
            seen.add(name)

    if not selected:
        raise RuntimeError(f"LLM returned no valid agent names from: {selected_names[:10]}")

    # Enforce max_agents cap
    return selected[:max_agents]
