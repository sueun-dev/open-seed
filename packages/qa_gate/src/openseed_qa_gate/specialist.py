"""
Open Seed v2 — Specialist agent runner.

Runs a single TOML-defined specialist agent by invoking the appropriate
CLI (Claude or Codex) with the agent's instructions as system prompt.

Pattern from: awesome-codex-subagents agent definitions + codex spawn
"""

from __future__ import annotations

import time
from typing import Any

from openseed_core.events import EventBus, EventType
from openseed_qa_gate.types import AgentDefinition, SpecialistResult


async def run_specialist(
    agent: AgentDefinition,
    context: str,
    working_dir: str,
    event_bus: EventBus | None = None,
) -> SpecialistResult:
    """
    Run a single specialist agent against the given context.

    Args:
        agent: The TOML-loaded agent definition
        context: Code/diff/files to review
        working_dir: Project directory
        event_bus: For streaming events

    Returns:
        SpecialistResult with findings
    """
    start = time.monotonic()

    if event_bus:
        await event_bus.emit_simple(
            EventType.QA_AGENT_START,
            node="qa_gate",
            agent=agent.name,
            model=agent.model,
        )

    try:
        # QA review always uses Claude (OAuth, read-only analysis).
        # TOML agents may specify gpt-5.4 as their design model, but for
        # review purposes Claude Haiku is faster, cheaper, and doesn't need
        # Codex's full-auto mode which is designed for code generation, not review.
        result = await _run_via_claude(agent, context, working_dir)

        duration = int((time.monotonic() - start) * 1000)
        result.duration_ms = duration

        if event_bus:
            await event_bus.emit_simple(
                EventType.QA_AGENT_COMPLETE,
                node="qa_gate",
                agent=agent.name,
                findings_count=len(result.findings),
                duration_ms=duration,
            )

        return result

    except Exception as e:
        duration = int((time.monotonic() - start) * 1000)
        return SpecialistResult(
            agent_name=agent.name,
            success=False,
            error=str(e),
            duration_ms=duration,
        )


async def _run_via_claude(
    agent: AgentDefinition,
    context: str,
    working_dir: str,
) -> SpecialistResult:
    """Run specialist via Claude CLI."""
    from openseed_left_hand.agent import ClaudeAgent

    claude = ClaudeAgent()
    # Read-only agents get only read tools
    tools = ["Read", "Grep", "Glob"] if agent.sandbox_mode == "read-only" else None

    output_contract = """

Output your findings as a JSON array:
[
  {"severity": "critical|high|medium|low|info", "title": "short title", "description": "details", "file": "path", "line": null, "suggestion": "how to fix", "confidence": "high|medium|low"}
]

If no issues found, output: []
"""

    response = await claude.invoke(
        prompt=f"{context}\n\n---\n\nApply the following review focus:\n{agent.instructions}\n{output_contract}",
        system_prompt=agent.instructions,
        model="sonnet",   # Sonnet for thorough review (reads files, runs checks)
        max_turns=5,      # Enough turns to: read files → analyze → output findings
        working_dir=working_dir,
    )

    return SpecialistResult(
        agent_name=agent.name,
        raw_output=response.text,
        findings=_extract_findings(response.text, agent.name),
    )


async def _run_via_codex(
    agent: AgentDefinition,
    context: str,
    working_dir: str,
) -> SpecialistResult:
    """Run specialist via Codex CLI."""
    try:
        from openseed_right_hand.agent import CodexAgent
    except ImportError as exc:
        # Codex (right_hand) package not installed — fall back to Claude
        import logging
        logging.getLogger(__name__).debug("CodexAgent unavailable (%s); falling back to Claude", exc)
        return await _run_via_claude(agent, context, working_dir)

    try:
        codex = CodexAgent()
        response = await codex.invoke(
            prompt=f"{context}\n\n---\n\nApply the following review focus:\n{agent.instructions}",
            working_dir=working_dir,
            auto_mode=agent.sandbox_mode == "workspace-write",
        )

        return SpecialistResult(
            agent_name=agent.name,
            raw_output=response.text,
            findings=_extract_findings(response.text, agent.name),
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).debug("CodexAgent invocation failed (%s); falling back to Claude", exc)
        return await _run_via_claude(agent, context, working_dir)


def _extract_findings(text: str, agent_name: str) -> list[dict[str, Any]]:
    """
    Extract structured findings from agent output.
    The agent is instructed to output structured findings.
    We try JSON parsing, fall back to treating full text as one finding.
    """
    import json

    # Try to find JSON array in output
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    # Fallback: whole output is one finding
    if text.strip():
        return [{"agent": agent_name, "description": text.strip()[:2000]}]
    return []
