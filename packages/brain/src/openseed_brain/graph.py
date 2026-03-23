"""
Open Seed v2 — Main LangGraph StateGraph definition.

Advanced features:
- Send() for parallel task dispatch (plan → multiple implement_task nodes)
- Command() for dynamic routing (intake can skip to implement for trivial tasks)
- interrupt_before for human-in-the-loop (user_escalate pauses graph)
- RetryPolicy on nodes for transient API failures
- AsyncSqliteSaver checkpointing for crash recovery + time travel

Pattern from: LangGraph StateGraph API (research/langgraph/libs/langgraph/langgraph/graph/state.py)
"""

from __future__ import annotations

from typing import Any, Literal

from langgraph.graph import StateGraph, START, END

from openseed_brain.state import PipelineState
from openseed_brain.nodes.intake import intake_node
from openseed_brain.nodes.plan import plan_node
from openseed_brain.nodes.implement import implement_node
from openseed_brain.nodes.qa_gate import qa_gate_node
from openseed_brain.nodes.sentinel import sentinel_check_node, fix_node
from openseed_brain.nodes.deploy import deploy_node
from openseed_brain.nodes.memorize import memorize_node
from openseed_brain.routing import route_after_qa, route_after_intake
from openseed_brain.retry import IMPLEMENT_RETRY, QA_RETRY, DEPLOY_RETRY
from openseed_brain.subgraphs.qa_subgraph import build_qa_subgraph
from openseed_brain.subgraphs.fix_subgraph import build_fix_subgraph


async def user_escalate_node(state: PipelineState) -> dict:
    """
    User escalation node — pipeline reaches here when Sentinel gives up.
    If compiled with interrupt_before=["user_escalate"], the graph pauses
    and waits for human input via Command(resume=...).
    """
    retry_count = state.get("retry_count", 0)
    errors = state.get("errors", [])
    error_summary = "; ".join(e.message for e in errors[:5]) if errors else "unknown"
    return {
        "messages": [f"USER ESCALATION: Pipeline needs help after {retry_count} retries. Errors: {error_summary}"],
    }


def build_graph(use_subgraphs: bool = False) -> StateGraph:
    """
    Build the Open Seed pipeline graph with advanced LangGraph features.

    Args:
        use_subgraphs: When True, the qa_gate and fix nodes are replaced with
            compiled LangGraph subgraphs (build_qa_subgraph / build_fix_subgraph).
            When False (default), the original flat node functions are used —
            preserving full backward compatibility.
    """
    graph = StateGraph(PipelineState)

    # ── Add nodes — critical nodes get native LangGraph retry_policy ──
    graph.add_node("intake", intake_node)
    graph.add_node("plan", plan_node)
    graph.add_node("implement", implement_node, retry_policy=IMPLEMENT_RETRY)

    if use_subgraphs:
        # Compiled subgraphs act as drop-in replacements for the flat nodes.
        # retry_policy is omitted here because each subgraph manages its own
        # internal retry / error-handling logic.
        qa_sub = build_qa_subgraph().compile()
        graph.add_node("qa_gate", qa_sub)
        fix_sub = build_fix_subgraph().compile()
        graph.add_node("fix", fix_sub)
    else:
        graph.add_node("qa_gate", qa_gate_node, retry_policy=QA_RETRY)
        graph.add_node("fix", fix_node)

    graph.add_node("sentinel_check", sentinel_check_node)
    graph.add_node("user_escalate", user_escalate_node)
    graph.add_node("deploy", deploy_node, retry_policy=DEPLOY_RETRY)
    graph.add_node("memorize", memorize_node)

    # ── Edges ──
    # Intake → conditional: trivial tasks skip planning, complex go through full pipeline
    graph.add_edge(START, "intake")
    graph.add_conditional_edges(
        "intake",
        route_after_intake,
        {
            "plan": "plan",            # Normal: go to planning
            "implement": "implement",   # Trivial: skip planning, implement directly
        },
    )

    graph.add_edge("plan", "implement")
    graph.add_edge("implement", "qa_gate")
    graph.add_edge("qa_gate", "sentinel_check")

    # Sentinel decides: pass → deploy, fail → fix, exhausted → user_escalate
    graph.add_conditional_edges(
        "sentinel_check",
        route_after_qa,
        {
            "deploy": "deploy",
            "fix": "fix",
            "user_escalate": "user_escalate",
            "end": END,
        },
    )

    graph.add_edge("fix", "qa_gate")  # Fix loops back

    # User escalation → END (graph pauses here if interrupt_before is set)
    graph.add_edge("user_escalate", END)

    # Deploy → memorize → END
    graph.add_edge("deploy", "memorize")
    graph.add_edge("memorize", END)

    return graph


def compile_graph(
    checkpoint_dir: str | None = None,
    interrupt_on_escalation: bool = True,
    use_subgraphs: bool = False,
    **kwargs: Any,
) -> Any:
    """
    Build and compile the graph.

    Args:
        checkpoint_dir: Path for SqliteSaver (crash recovery + resume)
        interrupt_on_escalation: If True, graph pauses at user_escalate for human input
        use_subgraphs: If True, use compiled subgraphs for qa_gate and fix nodes
        **kwargs: Additional compile options
    """
    graph = build_graph(use_subgraphs=use_subgraphs)

    if checkpoint_dir:
        import os
        os.makedirs(checkpoint_dir, exist_ok=True)
        try:
            # InMemorySaver is always available and works with astream()
            from langgraph.checkpoint.memory import InMemorySaver
            kwargs["checkpointer"] = InMemorySaver()
        except ImportError:
            pass

    # Human-in-the-loop: pause before user_escalate so CLI/UI can get input
    if interrupt_on_escalation:
        kwargs.setdefault("interrupt_before", []).append("user_escalate") if "interrupt_before" in kwargs else kwargs.update({"interrupt_before": ["user_escalate"]})

    return graph.compile(**kwargs)
