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
    Fix errors reported by QA gate — OmO Sisyphus Phase 2C implementation.

    Key behaviors:
    1. Session continuity — reuses Claude session across fix attempts
    2. Structured fix strategy — diagnose, fix, verify (not just "fix this")
    3. Consecutive failure tracking — after 3 failures, consults Oracle
    4. Evidence-based verification — detects no-op "fixes"
    5. Git stash revert — reverts to pre-fix state after 3 consecutive failures

    Escalation chain: retry → retry (different approach) → Oracle → User
    """
    task = state["task"]
    working_dir = state["working_dir"]
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)

    # Collect failure context from previous attempts
    failure_history = [
        m for m in state.get("messages", [])
        if "Fix:" in m or "RETRY" in m or "BLOCK" in m
    ]

    # Build findings text
    findings_text = _build_findings_text(qa_result)

    # Recall similar failures from memory
    memory_context = await _recall_past_fixes(task, qa_result)

    # ── Git stash for revert capability (first attempt only) ──
    if retry_count == 0:
        await _git_stash_push(working_dir)

    # ── After 3 consecutive failures: STOP, REVERT, CONSULT Oracle ──
    oracle_advice = None
    if retry_count >= 3 and retry_count % 3 == 0:
        # REVERT to pre-fix state before trying Oracle's approach
        await _git_stash_revert(working_dir)

        oracle_advice = await _consult_oracle_for_fix(
            task, failure_history, qa_result,
        )

        if oracle_advice and oracle_advice.should_abandon:
            # Oracle says this is unfixable — escalate to user
            return {
                "retry_count": retry_count + 1,
                "messages": [
                    f"Fix: Oracle advises ABANDON after {retry_count} failures. "
                    f"Diagnosis: {oracle_advice.diagnosis}",
                ],
                "errors": [Error(
                    step="fix",
                    message=f"Needs user help: {oracle_advice.reason}",
                )],
            }

        # Re-stash so we have a clean revert point for Oracle's approach
        await _git_stash_push(working_dir)

    # ── Main fix with session continuity ──
    import os
    import hashlib

    from openseed_left_hand.agent import ClaudeAgent
    agent = ClaudeAgent()

    # Deterministic session key based on task content
    task_hash = abs(hash(task)) % 10000

    prompt = _build_fix_prompt(
        task=task,
        working_dir=working_dir,
        findings_text=findings_text,
        memory_context=memory_context,
        retry_count=retry_count,
        failure_history=failure_history[-5:],
        oracle_advice=oracle_advice,
    )

    # Snapshot files BEFORE fix
    before = _snapshot_dir(working_dir)

    # Use session continuity: first attempt creates session, subsequent reuse it
    response = await agent.invoke(
        prompt=prompt,
        model="sonnet",
        working_dir=working_dir,
        max_turns=10,
        session_id=f"fix-{task_hash}" if retry_count == 0 else None,
        continue_session=retry_count > 0,
    )

    # ── Evidence-based verification ──
    after = _snapshot_dir(working_dir)
    changed_files = [f for f in after if after[f] != before.get(f)]
    new_files = [f for f in after if f not in before]
    all_changes = changed_files + new_files

    if not all_changes:
        # Claude claimed fix but changed nothing — retry with explicit instruction
        # On retry_count > 0 and continue_session, Claude keeps context so we
        # can tell it directly that its previous attempt was a no-op.
        noop_prompt = (
            "You said you fixed the issues but NO files changed on disk. "
            "You MUST use the Write or Edit tools to actually modify the files. "
            "Read the broken files, then write the corrected versions. "
            "Do NOT just describe what to change — actually make the edits."
        )
        # Second chance: invoke again in the same session
        before2 = _snapshot_dir(working_dir)
        await agent.invoke(
            prompt=noop_prompt,
            model="sonnet",
            working_dir=working_dir,
            max_turns=10,
            continue_session=True,
        )
        after2 = _snapshot_dir(working_dir)
        changed2 = [f for f in after2 if after2[f] != before2.get(f)]
        new2 = [f for f in after2 if f not in before2]
        all_changes2 = changed2 + new2

        if not all_changes2:
            return {
                "retry_count": retry_count + 1,
                "messages": [
                    f"Fix: NO files changed after 2 invocations. "
                    f"Claude failed to edit anything. Attempt {retry_count}",
                ],
                "errors": [Error(
                    step="fix",
                    message="Fix produced no file changes after explicit retry",
                )],
            }
        all_changes = all_changes2

    return {
        "retry_count": retry_count + 1,
        "messages": [
            f"Fix: {len(all_changes)} files changed "
            f"({', '.join(all_changes[:5])}). Attempt {retry_count}",
        ],
    }


# ── Private helpers ──────────────────────────────────────────────────────────


def _build_findings_text(qa_result: object | None) -> str:
    """Format QA findings into readable text."""
    if not qa_result or not getattr(qa_result, "findings", None):
        return ""
    return "\n".join(
        f"- [{f.severity.value}] {f.title}: {f.description} (file: {f.file})"
        for f in qa_result.findings[:10]  # type: ignore[union-attr]
    )


async def _recall_past_fixes(task: str, qa_result: object | None) -> str:
    """Query memory for similar past failures. Returns context string or empty."""
    try:
        from openseed_memory.store import MemoryStore
        from openseed_memory.failure import recall_similar_failures

        store = MemoryStore()
        await store.initialize()
        findings = getattr(qa_result, "findings", None) or []
        patterns = await recall_similar_failures(
            store, task, [f.description for f in findings],
        )
        if patterns:
            return "\n\nPast similar failures:\n" + "\n".join(
                f"- {p.error_type[:200]} -> {p.successful_fix}"
                for p in patterns[:3]
            )
    except Exception:
        pass
    return ""


async def _git_stash_push(working_dir: str) -> bool:
    """Stash current state for revert capability. Returns True if stashed."""
    import os

    if not os.path.isdir(os.path.join(working_dir, ".git")):
        return False
    try:
        from openseed_core.subprocess import run_simple

        result = await run_simple(
            ["git", "stash", "push", "-m", "pre-fix-snapshot"],
            cwd=working_dir,
            timeout_seconds=15,
        )
        return result.returncode == 0
    except Exception:
        return False


async def _git_stash_revert(working_dir: str) -> bool:
    """Revert to last stashed state. Returns True if reverted."""
    import os

    if not os.path.isdir(os.path.join(working_dir, ".git")):
        return False
    try:
        from openseed_core.subprocess import run_simple

        result = await run_simple(
            ["git", "stash", "pop"],
            cwd=working_dir,
            timeout_seconds=15,
        )
        return result.returncode == 0
    except Exception:
        return False


async def _consult_oracle_for_fix(
    task: str,
    failure_history: list[str],
    qa_result: object | None,
) -> object | None:
    """Consult Oracle (Opus with extended thinking) for a different strategy."""
    try:
        from openseed_sentinel.oracle import consult_oracle

        current_errors = []
        if qa_result and getattr(qa_result, "findings", None):
            current_errors = [
                f.description for f in qa_result.findings[:10]  # type: ignore[union-attr]
            ]

        return await consult_oracle(
            task=task,
            failure_history=failure_history[-10:],
            current_errors=current_errors,
        )
    except Exception:
        return None


def _snapshot_dir(d: str) -> dict[str, str]:
    """Hash all files in directory (excluding node_modules/.git)."""
    import os
    import hashlib

    hashes: dict[str, str] = {}
    try:
        for root, dirs, files in os.walk(d):
            dirs[:] = [
                x for x in dirs
                if x not in ("node_modules", ".git", "__pycache__", ".venv")
            ]
            for f in files:
                path = os.path.join(root, f)
                try:
                    with open(path, "rb") as fh:
                        hashes[os.path.relpath(path, d)] = hashlib.md5(
                            fh.read(),
                        ).hexdigest()
                except OSError:
                    pass
    except OSError:
        pass
    return hashes


def _build_fix_prompt(
    *,
    task: str,
    working_dir: str,
    findings_text: str,
    memory_context: str,
    retry_count: int,
    failure_history: list[str],
    oracle_advice: object | None = None,
) -> str:
    """
    Build a structured fix prompt. Strategy changes based on retry_count:
    - retry 0-2: Standard root-cause fix with 3-phase approach
    - retry 3+:  Completely different strategy, informed by Oracle if available
    """
    # Oracle advice section
    oracle_section = ""
    if oracle_advice:
        diagnosis = getattr(oracle_advice, "diagnosis", "")
        approach = getattr(oracle_advice, "suggested_approach", "")
        oracle_section = f"""
## ORACLE GUIDANCE (from deeper analysis)
Diagnosis: {diagnosis}
Suggested approach: {approach}

You MUST follow the Oracle's suggested approach. Your previous attempts failed.
Do NOT repeat what was tried before.
"""

    # Failure history section
    history_section = ""
    if failure_history:
        history_section = "\n## Previous Fix Attempts (DO NOT repeat these)\n" + "\n".join(
            f"- {h[:300]}" for h in failure_history[-5:]
        )

    if retry_count < 3:
        # Standard structured fix prompt
        return f"""Fix the following issues in the project at {working_dir}.

## Task
{task}

## Retry Attempt
{retry_count} (of max 10)

## Issues Found by QA
{findings_text or "No specific findings — general verification failed"}
{memory_context}
{history_section}

## Your 3-Phase Approach

### PHASE 1: DIAGNOSE
- Read EVERY file mentioned in the issues above
- Identify the ROOT CAUSE (not symptoms)
- If the error says "X is undefined", find WHERE X should be defined

### PHASE 2: FIX
- Make minimal, targeted changes to fix the root cause
- Write COMPLETE files from start to finish — never truncate with "..." or "// rest unchanged"
- Do NOT introduce new features — only fix what is broken
- Keep it simple — minimal code that works correctly

### PHASE 3: VERIFY
- Read back EVERY file you changed
- Verify the syntax is valid (matching braces, correct imports, no typos)
- Confirm the fix addresses the original issue

## Rules
- Fix the ROOT CAUSE, not the symptom
- Write COMPLETE files — never truncate
- Do NOT introduce new features
- After fixing, read the file back to verify it is syntactically valid
- If you are unsure what to change, read more files first"""

    else:
        # Retry 3+: completely different strategy
        return f"""CRITICAL: Your previous {retry_count} fix attempts ALL FAILED.
You MUST try a COMPLETELY DIFFERENT approach this time.

## Task
{task}

## Working Directory
{working_dir}

## Current Issues
{findings_text or "No specific findings — general verification failed"}
{memory_context}
{history_section}
{oracle_section}

## MANDATORY: Different Strategy

Your previous approaches did not work. You MUST:

1. STOP and think about WHY previous fixes failed
2. Consider if the problem is architectural (not just a typo)
3. Try a fundamentally different solution:
   - If you were patching, try rewriting from scratch
   - If you were adding code, try removing/simplifying
   - If you were fixing imports, check if the module structure is wrong
   - If tests fail, check if the test expectations are correct

### PHASE 1: RE-DIAGNOSE (fresh eyes)
- Read ALL relevant files (not just the ones that error)
- Look at the BROADER context — maybe the issue is in a different file
- Check if dependencies/imports are structured correctly

### PHASE 2: REWRITE (not patch)
- Write a clean solution from scratch if patching has not worked
- Write COMPLETE files — never truncate
- Keep it as simple as possible

### PHASE 3: VERIFY
- Read back every file you changed
- Run any available test/build commands
- Confirm the fix resolves the original issue

## Rules
- DIFFERENT approach than before — do NOT repeat failed strategies
- Write COMPLETE files — never truncate
- Minimal changes that actually work"""
