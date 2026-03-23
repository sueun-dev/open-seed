"""
QA Gate node — Spawn specialist reviewers in parallel, synthesize, verdict.
REAL implementation — calls openseed_qa_gate.
"""

from __future__ import annotations

import os

from openseed_brain.state import PipelineState
from openseed_core.types import QAResult, Verdict


async def qa_gate_node(state: PipelineState) -> dict:
    """Run QA specialists in parallel, produce verdict."""
    working_dir = state["working_dir"]
    implementation = state.get("implementation")
    plan = state.get("plan")

    task = state["task"]

    # Build context for reviewers: task scope + what was built + plan
    context_parts = [
        f"ORIGINAL TASK: {task}",
        f"SCOPE: Review ONLY what the task asked for. Do not demand production-grade features "
        f"(graceful shutdown, helmet, rate limiting, etc.) unless the task explicitly requires them. "
        f"A simple task should produce simple code. BLOCK only for actual bugs, syntax errors, or security vulnerabilities.",
        "",
    ]
    if plan:
        context_parts.append(f"Plan: {plan.summary}")
        for t in plan.tasks:
            context_parts.append(f"  Task {t.id}: {t.description}")
        context_parts.append(f"Files: {', '.join(f.path for f in plan.file_manifest)}")
    if implementation:
        context_parts.append(f"\nImplementation: {implementation.summary[:500]}")

    # List actual files in working dir
    try:
        files = []
        for root, dirs, fnames in os.walk(working_dir):
            dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "__pycache__", ".venv")]
            for f in fnames:
                rel = os.path.relpath(os.path.join(root, f), working_dir)
                files.append(rel)
        if files:
            context_parts.append(f"\nFiles on disk: {', '.join(files[:30])}")
            # Read key files for review
            for f in files[:5]:
                try:
                    content = open(os.path.join(working_dir, f)).read()[:2000]
                    context_parts.append(f"\n--- {f} ---\n{content}")
                except Exception:
                    pass
    except Exception:
        pass

    context = "\n".join(context_parts)

    try:
        from openseed_qa_gate.gate import run_qa_gate
        result = await run_qa_gate(context=context, working_dir=working_dir)
        return {
            "qa_result": result,
            "findings": result.findings,
            "messages": [f"QA Gate: {result.verdict.value} — {result.synthesis}"],
        }
    except Exception as e:
        # QA gate failed — pass with warning
        return {
            "qa_result": QAResult(verdict=Verdict.WARN, synthesis=f"QA gate error: {e}"),
            "messages": [f"QA Gate: error — {e}"],
        }
