"""
QA Gate subgraph — encapsulates the entire QA review pipeline as a LangGraph subgraph.

Nodes within the QA subgraph:
1. select_agents — LLM picks relevant specialists
2. run_specialists — parallel agent execution
3. synthesize — LLM knowledge synthesis

This can be embedded in the parent graph as:
    parent.add_node("qa_gate", build_qa_subgraph().compile())

The subgraph uses QASubState, which is a focused slice of PipelineState.
On entry, the parent graph maps relevant fields into this state;
on exit, the parent graph merges findings/verdict/synthesis back.
"""

from __future__ import annotations

import operator
from typing import TYPE_CHECKING, Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

if TYPE_CHECKING:
    from openseed_core.types import Finding


class QASubState(TypedDict):
    """State schema for the QA Gate subgraph."""

    # Inputs (set by parent before entering subgraph)
    context: str  # Code/diff/files to review
    working_dir: str

    # Accumulated by parallel specialist runs (reducer: list append)
    findings: Annotated[list[Finding], operator.add]

    # Set by synthesize node
    synthesis: str
    verdict: str  # "pass" | "warn" | "block"

    # Tracking
    agents_run: list[str]

    # Internal — agent definitions selected by LLM (ephemeral)
    _selected_agents: list[Any]


# ── Node implementations ──────────────────────────────────────────────────────


async def select_agents_node(state: QASubState) -> dict:
    """
    LLM picks the most relevant specialist agents for this context.
    Wraps openseed_qa_gate.agent_selector.select_agents and
    openseed_qa_gate.agent_loader.load_active_agents.
    """
    from pathlib import Path

    from openseed_core.config import QAGateConfig
    from openseed_qa_gate.agent_loader import load_active_agents
    from openseed_qa_gate.agent_selector import select_agents

    cfg = QAGateConfig()
    all_agents = load_active_agents(Path(cfg.agents_dir), cfg.active_agents)

    if not all_agents:
        return {"_selected_agents": [], "agents_run": []}

    context = state.get("context", "")
    summary = context[:500]

    selected = await select_agents(
        task=context,
        implementation_summary=summary,
        available_agents=all_agents,
        max_agents=cfg.max_parallel_agents,
    )

    return {
        "_selected_agents": selected,
        "agents_run": [a.name for a in selected],
    }


async def run_specialists_node(state: QASubState) -> dict:
    """
    Run each selected specialist in parallel (bounded concurrency).
    Wraps openseed_qa_gate.specialist.run_specialist.
    """
    import asyncio

    from openseed_core.config import QAGateConfig
    from openseed_qa_gate.specialist import run_specialist

    agents = state.get("_selected_agents", [])
    context = state.get("context", "")
    working_dir = state.get("working_dir", "")

    if not agents:
        return {"findings": []}

    cfg = QAGateConfig()
    semaphore = asyncio.Semaphore(cfg.max_parallel_agents)

    async def run_one(agent):
        async with semaphore:
            return await run_specialist(agent, context, working_dir, None)

    results = await asyncio.gather(*[run_one(a) for a in agents], return_exceptions=True)

    # Collect findings from successful runs; ignore exceptions
    all_findings: list = []
    for r in results:
        if isinstance(r, Exception):
            continue
        if hasattr(r, "findings") and r.findings:
            all_findings.extend(r.findings)

    return {"findings": all_findings}


async def synthesize_node(state: QASubState) -> dict:
    """
    Synthesize all specialist findings into a verdict via LLM.
    Wraps openseed_qa_gate.synthesizer.synthesize.
    """
    from openseed_qa_gate.synthesizer import synthesize
    from openseed_qa_gate.types import SpecialistResult

    findings = state.get("findings", [])
    agents_run = state.get("agents_run", [])

    # Build minimal SpecialistResult wrappers so synthesize() works without
    # re-running the specialists (it only needs the findings list).
    specialist_results = (
        [SpecialistResult(agent_name=name, success=True, findings=findings) for name in (agents_run or ["qa_subgraph"])]
        if findings
        else []
    )

    try:
        synthesized_findings, synthesis_text = await synthesize(specialist_results, None)
    except Exception as exc:
        synthesized_findings = findings
        synthesis_text = f"Synthesis error: {exc}"

    # Determine verdict from findings
    from openseed_core.config import QAGateConfig
    from openseed_qa_gate.gate import _determine_verdict

    cfg = QAGateConfig()
    verdict = _determine_verdict(synthesized_findings, cfg.block_on_critical)

    return {
        "synthesis": synthesis_text,
        "verdict": verdict.value,
        "findings": synthesized_findings,
    }


# ── Graph builder ─────────────────────────────────────────────────────────────


def build_qa_subgraph() -> StateGraph:
    """
    Build the QA Gate as a self-contained LangGraph subgraph.

    Usage in the parent graph:
        qa_sub = build_qa_subgraph().compile()
        parent.add_node("qa_gate", qa_sub)

    The subgraph flow:
        START → select_agents → run_specialists → synthesize → END
    """
    graph = StateGraph(QASubState)

    graph.add_node("select_agents", select_agents_node)
    graph.add_node("run_specialists", run_specialists_node)
    graph.add_node("synthesize", synthesize_node)

    graph.add_edge(START, "select_agents")
    graph.add_edge("select_agents", "run_specialists")
    graph.add_edge("run_specialists", "synthesize")
    graph.add_edge("synthesize", END)

    return graph
