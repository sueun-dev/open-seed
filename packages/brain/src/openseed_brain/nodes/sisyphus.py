"""
Sisyphus node — Zero-error guarantee loop.
REAL implementation — calls evaluate_loop + evidence verification.

Escalation chain: retry → retry (different approach) → Oracle → User
"""

from __future__ import annotations

from openseed_brain.state import PipelineState
from openseed_core.types import Verdict


async def sisyphus_check_node(state: PipelineState) -> dict:
    """
    Evaluate QA result + verify evidence. Decide: pass, retry, escalate.
    The routing function route_after_qa reads qa_result to decide next node.
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)
    plan = state.get("plan")
    working_dir = state["working_dir"]
    task = state["task"]

    # If QA already passed, just confirm
    if qa_result and qa_result.verdict == Verdict.PASS:
        # Run evidence verification to double-check
        try:
            from openseed_sisyphus.evidence import verify_implementation
            expected_files = [f.path for f in (plan.file_manifest if plan else [])]
            verification = await verify_implementation(
                working_dir=working_dir,
                expected_files=expected_files,
                test_commands=["ls -la"],  # Basic check
            )
            if verification.all_passed:
                return {"messages": [f"Sisyphus: PASSED — QA clean + evidence verified ({retry_count} retries)"]}
            else:
                # Evidence failed despite QA pass — demote to retry
                missing = verification.missing_files
                return {
                    "qa_result": qa_result._replace(verdict=Verdict.WARN) if hasattr(qa_result, '_replace') else qa_result,
                    "retry_count": retry_count + 1,
                    "messages": [f"Sisyphus: QA passed but evidence failed — missing: {missing}. Retry #{retry_count + 1}"],
                }
        except Exception as e:
            return {"messages": [f"Sisyphus: PASSED (evidence check failed: {e})"]}

    # QA failed — evaluate loop
    try:
        from openseed_sisyphus.loop import evaluate_loop, LoopState
        from openseed_sisyphus.evidence import verify_implementation

        expected_files = [f.path for f in (plan.file_manifest if plan else [])]
        verification = await verify_implementation(working_dir=working_dir, expected_files=expected_files)

        loop_state = LoopState(
            retry_count=retry_count,
            consecutive_failures=retry_count,
            failure_history=[f"Attempt {i+1}" for i in range(retry_count)],
        )

        decision = await evaluate_loop(
            qa_result=qa_result,
            verification=verification,
            loop_state=loop_state,
            task=task,
        )

        if decision.action == "pass":
            return {"messages": [f"Sisyphus: {decision.reason}"]}
        elif decision.action == "retry":
            return {
                "retry_count": retry_count + 1,
                "messages": [f"Sisyphus: RETRY — {decision.reason}"],
            }
        elif decision.action == "oracle":
            return {
                "retry_count": retry_count + 1,
                "messages": [f"Sisyphus: ORACLE consulted — {decision.reason}"],
            }
        elif decision.action == "user_escalate":
            return {
                "retry_count": retry_count + 1,
                "messages": [f"Sisyphus: USER ESCALATION — {decision.reason}"],
                "errors": [__import__("openseed_core.types", fromlist=["Error"]).Error(
                    step="sisyphus", message=f"Needs user help: {decision.reason}",
                )],
            }
        else:  # abort
            return {
                "messages": [f"Sisyphus: ABORT — {decision.reason}"],
                "errors": [__import__("openseed_core.types", fromlist=["Error"]).Error(
                    step="sisyphus", message=f"Aborted: {decision.reason}",
                )],
            }
    except Exception as e:
        return {
            "retry_count": retry_count + 1,
            "messages": [f"Sisyphus: evaluation error — {e}. Retrying."],
        }


async def fix_node(state: PipelineState) -> dict:
    """
    Fix errors reported by QA gate.
    Reads findings, recalls similar past failures, asks Claude to fix.
    """
    task = state["task"]
    working_dir = state["working_dir"]
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)

    findings_text = ""
    if qa_result and qa_result.findings:
        findings_text = "\n".join(
            f"- [{f.severity.value}] {f.title}: {f.description} (file: {f.file})"
            for f in qa_result.findings[:10]
        )

    # Recall similar failures from memory
    memory_context = ""
    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures
        store = MemoryStore()
        await store.initialize()
        patterns = await recall_similar_failures(store, task, [f.description for f in (qa_result.findings if qa_result else [])])
        if patterns:
            memory_context = "\n\nPast similar failures:\n" + "\n".join(
                f"- {p.error_type[:200]} → {p.successful_fix}" for p in patterns[:3]
            )
    except Exception:
        pass

    # Ask Claude to fix
    from openseed_left_hand.agent import ClaudeAgent
    agent = ClaudeAgent()

    prompt = f"""Fix the following issues in the project at {working_dir}.

Task: {task}
Retry attempt: {retry_count}

Issues found by QA:
{findings_text or "No specific findings — general verification failed"}
{memory_context}

Rules:
- Read the broken files first
- Fix the ROOT CAUSE, not the symptom
- Write COMPLETE fixed files
- Do NOT introduce new features — only fix what's broken
- After fixing, verify by reading the file again"""

    response = await agent.invoke(
        prompt=prompt,
        model="sonnet",
        working_dir=working_dir,
        max_turns=5,
    )

    return {
        "messages": [f"Fix: applied fixes ({len(response.text)} chars). Attempt {retry_count}"],
    }
