"""
Sentinel node — Zero-error guarantee loop.

Uses the 7-step ExecutionLoop (EXPLORE→PLAN→ROUTE→EXECUTE→VERIFY→RETRY→DONE)
for intelligent verification, plus the evaluate_loop for retry/oracle/escalate decisions.

Integration:
  - ExecutionLoop._verify() checks evidence (files exist, tests pass)
  - evaluate_loop() decides: pass / retry / oracle / user_escalate / abort
  - Memory is queried for similar past failures (in fix_node)

Escalation chain: retry → retry (different approach) → Oracle → User
"""

from __future__ import annotations

from openseed_brain.state import PipelineState
from openseed_core.types import Error, Verdict


async def sentinel_check_node(state: PipelineState) -> dict:
    """
    Evaluate QA result + run evidence verification via Sentinel ExecutionLoop.
    The routing function route_after_qa reads qa_result to decide next node.

    Flow:
    1. If QA passed → run ExecutionLoop._verify() to double-check with evidence
    2. If QA failed → run evaluate_loop() for retry/oracle/escalate decision
    """
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)
    plan = state.get("plan")
    working_dir = state["working_dir"]
    task = state["task"]

    # Collect expected files from plan — if no plan (skip_planning), scan working_dir
    expected_files = [f.path for f in (plan.file_manifest if plan else [])]
    if not expected_files:
        import os
        try:
            for f in os.listdir(working_dir):
                if f.startswith(".") or f == "node_modules" or f == "__pycache__":
                    continue
                expected_files.append(f)
        except OSError:
            pass

    # ── QA PASSED — evidence verification via ExecutionLoop ──
    if qa_result and qa_result.verdict == Verdict.PASS:
        try:
            from openseed_sentinel.execution_loop import ExecutionLoop
            loop = ExecutionLoop()
            # Run only the VERIFY step with the plan context
            verify = await loop._verify(
                working_dir=working_dir,
                exec_result={
                    "claimed_files": expected_files,
                    "test_commands": [],
                },
                plan={
                    "files_to_create": expected_files,
                    "expected_test_commands": [],
                },
            )
            if verify.get("passed", False):
                return {"messages": [f"Sentinel: PASSED — QA clean + evidence verified ({retry_count} retries)"]}
            else:
                # Evidence failed — override QA verdict to WARN so route_after_qa sends to fix
                from openseed_core.types import QAResult
                failed_qa = QAResult(
                    verdict=Verdict.WARN,
                    synthesis=f"Evidence check failed: {verify.get('summary', '')}",
                    findings=qa_result.findings if qa_result else [],
                )
                return {
                    "qa_result": failed_qa,
                    "retry_count": retry_count + 1,
                    "messages": [f"Sentinel: QA passed but evidence FAILED — {verify.get('summary', '')}. Retry #{retry_count + 1}"],
                }
        except Exception as e:
            return {"messages": [f"Sentinel: PASSED (evidence check skipped: {e})"]}

    # ── QA FAILED — evaluate_loop for retry/oracle/escalate ──
    try:
        from openseed_sentinel.loop import evaluate_loop, LoopState
        from openseed_sentinel.evidence import verify_implementation

        verification = await verify_implementation(working_dir=working_dir, expected_files=expected_files)

        loop_state = LoopState(
            retry_count=retry_count,
            consecutive_failures=retry_count,
            failure_history=[
                f"Attempt {i+1}: {(qa_result.findings[i].description if qa_result and i < len(qa_result.findings) else 'unknown')}"
                for i in range(retry_count)
            ],
        )

        decision = await evaluate_loop(
            qa_result=qa_result,
            verification=verification,
            loop_state=loop_state,
            task=task,
        )

        if decision.action == "pass":
            return {"messages": [f"Sentinel: {decision.reason}"]}
        elif decision.action in ("retry", "oracle"):
            label = "ORACLE consulted" if decision.action == "oracle" else "RETRY"
            return {
                "retry_count": retry_count + 1,
                "messages": [f"Sentinel: {label} — {decision.reason}"],
            }
        elif decision.action == "user_escalate":
            return {
                "retry_count": retry_count + 1,
                "messages": [f"Sentinel: USER ESCALATION — {decision.reason}"],
                "errors": [Error(step="sentinel", message=f"Needs user help: {decision.reason}")],
            }
        else:  # abort
            return {
                "messages": [f"Sentinel: ABORT — {decision.reason}"],
                "errors": [Error(step="sentinel", message=f"Aborted: {decision.reason}")],
            }
    except Exception as e:
        return {
            "retry_count": retry_count + 1,
            "messages": [f"Sentinel: evaluation error — {e}. Retrying."],
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
- Write the COMPLETE file from start to finish — never truncate
- Do NOT introduce new features — only fix what's broken
- Keep it simple — a minimal server does not need graceful shutdown or signal handlers
- After fixing, read the file back to verify it's syntactically valid"""

    # Snapshot files BEFORE fix
    import os
    import hashlib

    def _snapshot_dir(d: str) -> dict[str, str]:
        """Hash all files in directory (excluding node_modules/.git)."""
        hashes = {}
        try:
            for root, dirs, files in os.walk(d):
                dirs[:] = [x for x in dirs if x not in ("node_modules", ".git", "__pycache__", ".venv")]
                for f in files:
                    path = os.path.join(root, f)
                    try:
                        with open(path, "rb") as fh:
                            hashes[os.path.relpath(path, d)] = hashlib.md5(fh.read()).hexdigest()
                    except OSError:
                        pass
        except OSError:
            pass
        return hashes

    before = _snapshot_dir(working_dir)

    response = await agent.invoke(
        prompt=prompt,
        model="sonnet",
        working_dir=working_dir,
        max_turns=10,
    )

    # Verify files actually changed
    after = _snapshot_dir(working_dir)
    changed_files = [f for f in after if after[f] != before.get(f)]
    new_files = [f for f in after if f not in before]
    all_changes = changed_files + new_files

    if not all_changes:
        # Claude said "fixed" but changed nothing — force a more explicit retry
        return {
            "retry_count": retry_count + 1,
            "messages": [f"Fix: NO files changed on disk. Claude claimed fix but didn't edit anything. Attempt {retry_count}"],
            "errors": [Error(step="fix", message="Fix produced no file changes — agent may need stronger instructions")],
        }

    return {
        "messages": [f"Fix: {len(all_changes)} files changed ({', '.join(all_changes[:5])}). Attempt {retry_count}"],
    }
