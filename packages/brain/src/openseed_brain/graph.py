"""
Open Seed v2 — Main LangGraph StateGraph definition.

This is the Brain. It defines the zero-bug pipeline as a graph:

    intake → plan → implement → qa_gate → sisyphus_check
                                              │
                                    ┌─────────┴─────────┐
                                    │ pass              │ fail
                                    ▼                   ▼
                                  deploy          fix → qa_gate (loop)
                                    │
                                    ▼
                                 memorize → END

Pattern from: LangGraph StateGraph API (research/langgraph/libs/langgraph/langgraph/graph/state.py)
"""

from __future__ import annotations

from typing import Any

from langgraph.graph import StateGraph, START, END

from openseed_brain.state import PipelineState
from openseed_brain.nodes.intake import intake_node
from openseed_brain.nodes.plan import plan_node
from openseed_brain.nodes.implement import implement_node
from openseed_brain.nodes.qa_gate import qa_gate_node
from openseed_brain.nodes.sisyphus import sisyphus_check_node, fix_node
from openseed_brain.nodes.deploy import deploy_node
from openseed_brain.nodes.memorize import memorize_node
from openseed_brain.routing import route_after_qa


def build_graph() -> StateGraph:
    """
    Build the Open Seed pipeline graph.

    Returns a compiled StateGraph ready to invoke.
    """
    graph = StateGraph(PipelineState)

    # ── Add nodes ──
    graph.add_node("intake", intake_node)
    graph.add_node("plan", plan_node)
    graph.add_node("implement", implement_node)
    graph.add_node("qa_gate", qa_gate_node)
    graph.add_node("sisyphus_check", sisyphus_check_node)
    graph.add_node("fix", fix_node)
    graph.add_node("deploy", deploy_node)
    graph.add_node("memorize", memorize_node)

    # ── Add edges ──
    # Linear flow: intake → plan → implement → qa_gate → sisyphus_check
    graph.add_edge(START, "intake")
    graph.add_edge("intake", "plan")
    graph.add_edge("plan", "implement")
    graph.add_edge("implement", "qa_gate")
    graph.add_edge("qa_gate", "sisyphus_check")

    # Conditional: sisyphus_check decides pass/fail/exhausted
    graph.add_conditional_edges(
        "sisyphus_check",
        route_after_qa,
        {
            "deploy": "deploy",      # QA passed → deploy
            "fix": "fix",            # QA failed → fix and retry
            "end": END,              # Retries exhausted → stop
        },
    )

    # Fix loops back to qa_gate
    graph.add_edge("fix", "qa_gate")

    # Deploy → memorize → END
    graph.add_edge("deploy", "memorize")
    graph.add_edge("memorize", END)

    return graph


def compile_graph(**kwargs: Any) -> Any:
    """Build and compile the graph with optional checkpointer."""
    graph = build_graph()
    return graph.compile(**kwargs)
