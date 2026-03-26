"""
Open Seed v2 — Brain state schema.

Re-exports PipelineState from core and adds Brain-specific state helpers.
LangGraph nodes read/write this state.
"""

from __future__ import annotations

from openseed_core.types import (
    AgentProvider,
    Error,
    FileEntry,
    Finding,
    Implementation,
    Plan,
    PlanTask,
    PipelineState,
    QAResult,
    DeployResult,
    Memory,
    StepResult,
    Severity,
)


def initial_state(task: str, working_dir: str, provider: str = "claude") -> PipelineState:
    """Create the initial pipeline state for a new run."""
    return PipelineState(
        task=task,
        working_dir=working_dir,
        provider=provider,
        plan=None,
        implementation=None,
        qa_result=None,
        retry_count=0,
        max_retries=10,
        deploy_result=None,
        relevant_memories=[],
        skip_planning=False,
        errors=[],
        messages=[],
        step_results=[],
        findings=[],
        intake_analysis={},
        microagent_context=[],
        _specialist_task=None,
    )


__all__ = [
    "PipelineState",
    "initial_state",
    "AgentProvider",
    "Error",
    "Finding",
    "Implementation",
    "Plan",
    "QAResult",
    "DeployResult",
    "Memory",
    "StepResult",
    "Severity",
]
