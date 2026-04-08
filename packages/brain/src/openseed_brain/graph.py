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

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from openseed_brain.nodes.deploy import deploy_node
from openseed_brain.nodes.implement import implement_node
from openseed_brain.nodes.intake import intake_node
from openseed_brain.nodes.memorize import memorize_node
from openseed_brain.nodes.plan import plan_node
from openseed_brain.nodes.qa_gate import qa_gate_node
from openseed_brain.nodes.sentinel import fix_node, sentinel_check_node
from openseed_brain.retry import DEPLOY_RETRY, IMPLEMENT_RETRY, QA_RETRY
from openseed_brain.routing import route_after_intake, route_after_qa
from openseed_brain.state import PipelineState
from openseed_brain.subgraphs.fix_subgraph import build_fix_subgraph
from openseed_brain.subgraphs.qa_subgraph import build_qa_subgraph


def route_plan_to_specialists(state: PipelineState) -> list[Send] | Literal["implement"]:
    """
    After planning, dispatch tasks to specialists via LangGraph Send().

    If the plan has routable tasks, each domain gets its own Send() —
    LangGraph manages these as independent parallel branches with
    per-branch checkpointing and crash recovery.

    Falls back to the single 'implement' node when:
    - No plan exists (skip_planning)
    - Plan has no tasks
    - Provider is legacy codex/both
    - Task routing fails
    """
    plan = state.get("plan")

    # No plan — use single implement node
    if not plan or not plan.tasks:
        return "implement"

    try:
        # Import here to avoid circular deps at module level

        # We can't await in a routing function, so we use Send() to dispatch
        # each task as a separate parallel branch. The implement_task node
        # will handle the actual specialist invocation.
        sends = []
        for task in plan.tasks:
            sends.append(
                Send(
                    "implement_task",
                    {
                        **state,
                        "_specialist_task": task,
                    },
                )
            )

        return sends if sends else "implement"
    except Exception:
        return "implement"


async def implement_task_node(state: PipelineState) -> dict:
    """
    Implement a single specialist task dispatched via Send().

    Each Send() branch receives the full state plus a _specialist_task field
    identifying which PlanTask to implement. The specialist domain is determined
    by LLM routing within this node.
    """
    from openseed_brain.nodes.implement import _implement_fullstack, _run_specialist
    from openseed_brain.task_router import route_tasks

    task_obj = state.get("_specialist_task")
    if not task_obj:
        # Fallback: no specific task, run fullstack
        impl = await _implement_fullstack(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack-send]: {impl.summary[:300]}"],
        }

    plan = state.get("plan")
    if not plan:
        impl = await _implement_fullstack(state)
        return {
            "implementation": impl,
            "messages": [f"Implement [fullstack-send]: {impl.summary[:300]}"],
        }

    # Route this single task to its domain
    try:
        routed = await route_tasks(plan, state["task"])
        # Find which domain this task was assigned to
        domain = "fullstack"
        for d, tasks in routed.items():
            if any(t.id == task_obj.id for t in tasks):
                domain = d
                break
        impl = await _run_specialist(domain, [task_obj], state)
    except Exception:
        impl = await _run_specialist("fullstack", [task_obj], state)

    return {
        "implementation": impl,
        "messages": [f"Implement [send:{task_obj.id}]: {impl.summary[:200]}"],
    }


async def user_escalate_node(state: PipelineState) -> dict:
    """
    User escalation node — asks the user what to do and AI interprets the response.

    When max retries are exhausted, instead of aborting:
    1. Show the user current errors
    2. Ask: "오류가 있는데 더 수정해볼까?"
    3. AI interprets the user's free-form response (yes/no/specific instructions)
    4. Returns appropriate action based on interpretation
    """
    from openseed_core.types import Error

    retry_count = state.get("retry_count", 0)
    errors = state.get("errors", [])
    qa_result = state.get("qa_result")
    error_summary = "; ".join(e.message for e in errors[:5]) if errors else "unknown"

    # Build status message for the user
    qa_text = ""
    if qa_result and hasattr(qa_result, "synthesis"):
        qa_text = qa_result.synthesis[:300]

    status = (
        f"\n{'=' * 60}\n"
        f"Pipeline has attempted {retry_count} fixes.\n"
        f"Current issues: {qa_text or error_summary}\n"
        f"{'=' * 60}\n"
        f"오류가 좀 있는데 더 수정해볼까? (응답을 자유롭게 입력하세요)\n"
        f"> "
    )

    # Get user input
    try:
        print(status, end="", flush=True)
        user_response = input().strip()
    except (EOFError, KeyboardInterrupt):
        user_response = ""

    if not user_response:
        return {
            "messages": [f"USER ESCALATION: No response — stopping pipeline after {retry_count} retries."],
            "errors": [Error(step="user_escalate", message="User did not respond. Pipeline stopped.")],
        }

    # AI interprets the user's response
    action = await _interpret_user_response(user_response, error_summary, qa_text)

    if action == "continue":
        # Reset retry_count and send back to fix loop
        return {
            "retry_count": 0,
            "messages": [f"USER: Continuing fixes. User said: {user_response[:200]}"],
        }
    elif action == "deploy":
        # User says deploy as-is
        from openseed_core.types import QAResult, Verdict

        return {
            "qa_result": QAResult(
                verdict=Verdict.PASS_WITH_WARNINGS,
                synthesis=f"User approved deployment: {user_response[:200]}",
            ),
            "messages": [f"USER: Deploy as-is. User said: {user_response[:200]}"],
        }
    else:
        # User says stop
        return {
            "messages": [f"USER ESCALATION: User chose to stop. Response: {user_response[:200]}"],
            "errors": [Error(step="user_escalate", message=f"User stopped: {user_response[:100]}")],
        }


async def _interpret_user_response(
    user_response: str,
    error_summary: str,
    qa_text: str,
) -> str:
    """
    Use AI to interpret the user's free-form response.

    Returns: "continue" | "deploy" | "stop"

    The user can say anything in any language:
    - "ㅇㅇ 해" / "yes" / "계속" → continue
    - "그냥 배포해" / "deploy it" → deploy
    - "아니" / "stop" / "그만" → stop
    - "저 에러 무시하고 나머지만 고쳐" → continue (with context)
    """
    try:
        from openseed_codex.agent import CodexAgent

        agent = CodexAgent()
        response = await agent.invoke(
            prompt=(
                f"A coding pipeline asked the user if they want to continue fixing errors.\n\n"
                f"Current errors: {error_summary[:300]}\n"
                f"QA status: {qa_text[:300]}\n\n"
                f'User\'s response: "{user_response}"\n\n'
                f"Interpret the user's intent. Answer EXACTLY one word:\n"
                f"- 'continue' if they want to keep fixing (yes, ㅇㅇ, 해, 계속, fix it, etc.)\n"
                f"- 'deploy' if they want to deploy/ship as-is (배포해, ship it, deploy, 그냥 써, etc.)\n"
                f"- 'stop' if they want to stop completely (아니, stop, 그만, 됐어, etc.)\n\n"
                f"Answer:"
            ),
            model="light",
            max_turns=1,
        )
        result = response.text.strip().lower()
        if "continue" in result:
            return "continue"
        if "deploy" in result:
            return "deploy"
        return "stop"
    except Exception:
        # If AI fails, check for simple patterns as fallback
        lower = user_response.lower()
        if any(w in lower for w in ["ㅇㅇ", "yes", "응", "해", "계속", "fix", "고쳐"]):
            return "continue"
        if any(w in lower for w in ["배포", "deploy", "ship"]):
            return "deploy"
        return "stop"


def build_graph(use_subgraphs: bool = False, use_send: bool = False) -> StateGraph:
    """
    Build the Open Seed pipeline graph with advanced LangGraph features.

    Args:
        use_subgraphs: When True, the qa_gate and fix nodes are replaced with
            compiled LangGraph subgraphs (build_qa_subgraph / build_fix_subgraph).
            When False (default), the original flat node functions are used —
            preserving full backward compatibility.
        use_send: When True, plan dispatches tasks via LangGraph Send() for
            per-branch checkpointing. When False (default), uses the single
            implement node with asyncio.gather (backward compatible).
    """
    graph = StateGraph(PipelineState)

    # ── Add nodes — critical nodes get native LangGraph retry_policy ──
    graph.add_node("intake", intake_node)
    graph.add_node("plan", plan_node)
    graph.add_node("implement", implement_node, retry_policy=IMPLEMENT_RETRY)

    # Send() parallel dispatch node — each task gets its own branch
    if use_send:
        graph.add_node("implement_task", implement_task_node, retry_policy=IMPLEMENT_RETRY)

    if use_subgraphs:
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
            "plan": "plan",  # Normal: go to planning
            "implement": "implement",  # Trivial: skip planning, implement directly
        },
    )

    if use_send:
        # Plan → Send() parallel dispatch → qa_gate
        # route_plan_to_specialists returns list[Send] or "implement"
        graph.add_conditional_edges(
            "plan",
            route_plan_to_specialists,
            {"implement": "implement"},
        )
        graph.add_edge("implement_task", "qa_gate")
    else:
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

    # User escalation → conditional: continue fixing, deploy, or stop
    def route_after_user_escalation(state: PipelineState) -> Literal["fix", "deploy", "end"]:
        """Route based on user's response (interpreted by AI)."""
        messages = state.get("messages", [])
        last = messages[-1] if messages else ""
        if "Continuing fixes" in last:
            return "fix"
        if "Deploy as-is" in last:
            return "deploy"
        return "end"

    graph.add_conditional_edges(
        "user_escalate",
        route_after_user_escalation,
        {
            "fix": "fix",
            "deploy": "deploy",
            "end": END,
        },
    )

    # Deploy → memorize → END
    graph.add_edge("deploy", "memorize")
    graph.add_edge("memorize", END)

    return graph


def compile_graph(
    checkpoint_dir: str | None = None,
    interrupt_on_escalation: bool = True,
    use_subgraphs: bool = False,
    use_send: bool = False,
    **kwargs: Any,
) -> Any:
    """
    Build and compile the graph.

    Args:
        checkpoint_dir: Path for SqliteSaver (crash recovery + resume)
        interrupt_on_escalation: If True, graph pauses at user_escalate for human input
        use_subgraphs: If True, use compiled subgraphs for qa_gate and fix nodes
        use_send: If True, use LangGraph Send() for per-task parallel dispatch
        **kwargs: Additional compile options
    """
    graph = build_graph(use_subgraphs=use_subgraphs, use_send=use_send)

    if checkpoint_dir:
        import os

        os.makedirs(checkpoint_dir, exist_ok=True)
        # MemorySaver works with both sync and async — always safe.
        # For persistent checkpoints, the CLI runner sets up AsyncSqliteSaver
        # in its own async context and passes it via kwargs["checkpointer"].
        if "checkpointer" not in kwargs:
            try:
                from langgraph.checkpoint.memory import MemorySaver

                kwargs["checkpointer"] = MemorySaver()
            except ImportError:
                pass

    # Human-in-the-loop: pause before user_escalate so CLI/UI can get input
    if interrupt_on_escalation:
        kwargs.setdefault("interrupt_before", []).append(
            "user_escalate"
        ) if "interrupt_before" in kwargs else kwargs.update({"interrupt_before": ["user_escalate"]})

    return graph.compile(**kwargs)
