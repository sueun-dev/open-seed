"""
Sentinel node — Zero-error guarantee loop.

Uses the 7-step ExecutionLoop (EXPLORE→PLAN→ROUTE→EXECUTE→VERIFY→RETRY→DONE)
for intelligent verification, plus the evaluate_loop for retry/insight/escalate decisions.

Integration:
  - ExecutionLoop._verify() checks evidence (files exist, tests pass)
  - evaluate_loop() decides: pass / retry / insight / user_escalate / abort
  - Memory is queried for similar past failures (in fix_node)

Escalation chain: retry → retry (different approach) → Insight → User
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from openseed_core.types import Error, Verdict

if TYPE_CHECKING:
    from openseed_brain.state import PipelineState


async def sentinel_check_node(state: PipelineState) -> dict:
    """
    Evaluate QA result + run evidence verification via Sentinel ExecutionLoop.
    The routing function route_after_qa reads qa_result to decide next node.

    Flow:
    1. If QA passed → run ExecutionLoop._verify() to double-check with evidence
    2. If QA failed → run evaluate_loop() for retry/insight/escalate decision
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
            from openseed_guard.execution_loop import ExecutionLoop

            loop = ExecutionLoop()
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

            # Evidence failed — distinguish critical vs minor failures
            summary = verify.get("summary", "")
            verify.get("evidence", [])
            failing_cmds = verify.get("failing_commands", [])

            # Critical: test/build commands actually fail → must fix
            if failing_cmds:
                from openseed_core.types import QAResult

                failed_qa = QAResult(
                    verdict=Verdict.WARN,
                    synthesis=f"Evidence: commands failed: {', '.join(failing_cmds[:3])}",
                    findings=qa_result.findings if qa_result else [],
                )
                return {
                    "qa_result": failed_qa,
                    "retry_count": retry_count + 1,
                    "messages": [f"Sentinel: QA passed but build/test FAILED — {summary}. Retry #{retry_count + 1}"],
                }

            # Minor: just missing file paths (likely in subdirectory) → QA said PASS, trust it
            from openseed_core.types import QAResult

            passed_qa = QAResult(
                verdict=Verdict.PASS_WITH_WARNINGS,
                synthesis=f"QA passed. Minor evidence notes: {summary}",
                findings=qa_result.findings if qa_result else [],
            )
            return {
                "qa_result": passed_qa,
                "messages": [f"Sentinel: PASSED WITH WARNINGS — QA clean, minor evidence notes: {summary}"],
            }
        except Exception as e:
            return {"messages": [f"Sentinel: PASSED (evidence check skipped: {e})"]}

    # ── Stuck detection (OpenHands pattern) — check BEFORE evaluate_loop ──
    try:
        from openseed_guard.stuck_detector import detect_stuck

        stuck = await detect_stuck(
            step_results=state.get("step_results", []),
            messages=state.get("messages", []),
            errors=state.get("errors", []),
            retry_count=retry_count,
        )
        if stuck.is_stuck:
            return {
                "retry_count": retry_count + 1,
                "messages": [
                    f"Sentinel: STUCK ({stuck.pattern}) — {stuck.suggestion}. Escalating after {retry_count} retries."
                ],
                "errors": [
                    Error(
                        step="sentinel",
                        message=f"Stuck pattern: {stuck.pattern}. {stuck.suggestion}",
                    )
                ],
            }
    except Exception:
        pass  # Stuck detection is best-effort; don't block pipeline

    # ── QA FAILED — evaluate_loop for retry/insight/escalate ──
    try:
        from openseed_guard.evidence import verify_implementation
        from openseed_guard.loop import LoopState, evaluate_loop

        verification = await verify_implementation(working_dir=working_dir, expected_files=expected_files)

        loop_state = LoopState(
            retry_count=retry_count,
            consecutive_failures=retry_count,
            failure_history=[
                f"Attempt {i + 1}: {(qa_result.findings[i].description if qa_result and i < len(qa_result.findings) else 'unknown')}"
                for i in range(retry_count)
            ],
        )

        # Include harness rules in evaluation context
        harness_ctx = ""
        micro_ctx = state.get("microagent_context", [])
        if micro_ctx:
            harness_ctx = "\n".join(micro_ctx)

        decision = await evaluate_loop(
            qa_result=qa_result,
            verification=verification,
            loop_state=loop_state,
            task=task + (f"\n\n[Harness rules]\n{harness_ctx}" if harness_ctx else ""),
        )

        if decision.action == "pass":
            return {"messages": [f"Sentinel: {decision.reason}"]}
        elif decision.action in ("retry", "insight"):
            # Actually apply backoff — wait before returning so the next node doesn't fire instantly
            if decision.backoff_ms > 0:
                import asyncio

                await asyncio.sleep(decision.backoff_ms / 1000.0)
            label = "INSIGHT consulted" if decision.action == "insight" else "RETRY"
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

    Key behaviors:
    1. Session continuity — reuses Claude session across fix attempts
    2. Structured fix strategy — diagnose, fix, verify (not just "fix this")
    3. Consecutive failure tracking — after 3 failures, consults Insight
    4. Evidence-based verification — detects no-op "fixes"
    5. Git stash revert — reverts to pre-fix state after 3 consecutive failures

    Escalation chain: retry → retry (different approach) → Insight → User
    """
    task = state["task"]
    working_dir = state["working_dir"]
    qa_result = state.get("qa_result")
    retry_count = state.get("retry_count", 0)

    # Collect failure context from previous attempts — condensed to prevent context explosion
    all_messages = state.get("messages", [])
    failure_history = [m for m in all_messages if "Fix:" in m or "RETRY" in m or "BLOCK" in m]
    # Condense if history is large (OpenHands pattern)
    if len(failure_history) > 15:
        try:
            from openseed_memory.condenser import condense_for_prompt

            condensed = await condense_for_prompt(failure_history, max_messages=10)
            failure_history = [condensed]
        except Exception:
            failure_history = failure_history[-10:]  # Fallback: keep last 10

    # Build findings text
    findings_text = _build_findings_text(qa_result)

    # Recall similar failures from memory
    memory_context = await _recall_past_fixes(task, qa_result)

    # ── Git stash for revert capability (first attempt only) ──
    if retry_count == 0:
        await _git_stash_push(working_dir)

    # ── After 3 consecutive failures: STOP, REVERT, CONSULT Insight ──
    insight_advice = None
    if retry_count >= 3 and retry_count % 3 == 0:
        # REVERT to pre-fix state before trying Insight's approach
        await _git_stash_revert(working_dir)

        insight_advice = await _consult_insight_for_fix(
            task,
            failure_history,
            qa_result,
        )

        if insight_advice and insight_advice.should_abandon:
            # Insight says this is unfixable — escalate to user
            return {
                "retry_count": retry_count + 1,
                "messages": [
                    f"Fix: Insight advises ABANDON after {retry_count} failures. Diagnosis: {insight_advice.diagnosis}",
                ],
                "errors": [
                    Error(
                        step="fix",
                        message=f"Needs user help: {insight_advice.reason}",
                    )
                ],
            }

        # Re-stash so we have a clean revert point for Insight's approach
        await _git_stash_push(working_dir)

    # ── Gather plan/intake context for fix ──
    intake_raw = state.get("intake_analysis") or {}
    intake = intake_raw if isinstance(intake_raw, dict) else {}
    plan = state.get("plan")

    plan_context = ""
    if plan:
        plan_context = f"\n## Original Plan\n{plan.summary}\n"
        for t in plan.tasks[:10]:
            plan_context += f"- {t.id}: {t.description} ({t.role}) files: {', '.join(t.files[:5])}\n"

    intake_context = ""
    if intake:
        parts = []
        approach = intake.get("approach", "")
        if approach:
            parts.append(f"Approach: {approach}")
        reqs = intake.get("requirements", [])
        if reqs:
            parts.append(f"Requirements: {', '.join(reqs) if isinstance(reqs, list) else reqs}")
        tech = intake.get("tech_stack", "")
        if tech:
            parts.append(f"Tech stack: {tech}")
        if parts:
            intake_context = "\n## Project Context\n" + "\n".join(parts) + "\n"

    # Inject harness context (AGENTS.md boundaries) so fixes respect project rules
    micro_ctx = state.get("microagent_context", [])
    if micro_ctx:
        intake_context += "\n## Project Harness (from AGENTS.md — fixes must follow these rules)\n"
        intake_context += "\n".join(micro_ctx) + "\n"

    # Build skill-aware system prompt so fix preserves patterns from original implementation
    skill_system_prompt = _build_fix_skill_prompt(state)

    # ── Main fix with session continuity ──
    from openseed_claude.agent import ClaudeAgent

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
        insight_advice=insight_advice,
        plan_context=plan_context,
        intake_context=intake_context,
    )

    # Snapshot files BEFORE fix
    before = _snapshot_dir(working_dir)

    # Escalate to Opus after initial Sonnet attempts fail
    fix_model = "sonnet" if retry_count < 2 else "opus"

    # Use session continuity: first attempt creates session, subsequent reuse it
    await agent.invoke(
        prompt=prompt,
        system_prompt=skill_system_prompt if skill_system_prompt else None,
        model=fix_model,
        working_dir=working_dir,
        max_turns=20,
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
                    f"Fix: NO files changed after 2 invocations. Claude failed to edit anything. Attempt {retry_count}",
                ],
                "errors": [
                    Error(
                        step="fix",
                        message="Fix produced no file changes after explicit retry",
                    )
                ],
            }
        all_changes = all_changes2

    # Fix succeeded (files changed) — don't increment retry_count.
    # Only sentinel_check_node increments retry_count on actual failures.
    return {
        "messages": [
            f"Fix: {len(all_changes)} files changed ({', '.join(all_changes[:5])}). Attempt {retry_count}",
        ],
    }


# ── Private helpers ──────────────────────────────────────────────────────────


def _build_findings_text(qa_result: object | None) -> str:
    """Format QA findings into readable text, sorted by severity (critical first)."""
    if not qa_result or not getattr(qa_result, "findings", None):
        return ""
    # Sort findings so the LLM sees the most severe issues first.
    # The ordering itself is just data presentation — the LLM decides what to fix.
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    sorted_findings = sorted(
        qa_result.findings,  # type: ignore[union-attr]
        key=lambda f: severity_order.get(f.severity.value, 5),
    )
    return "\n".join(
        f"- [{f.severity.value}] {f.title}: {f.description} (file: {f.file})" for f in sorted_findings[:10]
    )


async def _recall_past_fixes(task: str, qa_result: object | None) -> str:
    """Query memory for similar past failures. Returns context string or empty."""
    try:
        from openseed_memory.failure import recall_similar_failures
        from openseed_memory.store import MemoryStore

        store = MemoryStore()
        await store.initialize()
        findings = getattr(qa_result, "findings", None) or []
        patterns = await recall_similar_failures(
            store,
            task,
            [f.description for f in findings],
        )
        if patterns:
            return "\n\nPast similar failures:\n" + "\n".join(
                f"- {p.error_type[:200]} -> {p.successful_fix}" for p in patterns[:3]
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


async def _consult_insight_for_fix(
    task: str,
    failure_history: list[str],
    qa_result: object | None,
) -> object | None:
    """Consult Insight (Opus with extended thinking) for a different strategy."""
    try:
        from openseed_guard.insight import consult_insight

        current_errors = []
        if qa_result and getattr(qa_result, "findings", None):
            current_errors = [
                f.description
                for f in qa_result.findings[:10]  # type: ignore[union-attr]
            ]

        return await consult_insight(
            task=task,
            failure_history=failure_history[-10:],
            current_errors=current_errors,
        )
    except Exception:
        return None


def _snapshot_dir(d: str) -> dict[str, str]:
    """Hash all files in directory (excluding node_modules/.git)."""
    import hashlib
    import os

    hashes: dict[str, str] = {}
    try:
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in ("node_modules", ".git", "__pycache__", ".venv")]
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


def _build_fix_skill_prompt(state: PipelineState) -> str | None:
    """
    Build system prompt from skills used during implementation.
    Ensures fix_node preserves patterns/conventions established by the original skills.
    """
    intake_raw = state.get("intake_analysis") or {}
    intake_raw if isinstance(intake_raw, dict) else {}
    plan = state.get("plan")
    if not plan:
        return None

    # Collect all unique skills from plan tasks
    skill_names: list[str] = []
    seen: set[str] = set()
    for t in plan.tasks:
        for s in getattr(t, "skills", []):
            if s not in seen:
                skill_names.append(s)
                seen.add(s)

    if not skill_names:
        return None

    try:
        from openseed_brain.skill_loader import get_skill_content

        parts = [
            "You are fixing code that was written following these official skills. "
            "Preserve the patterns and conventions from these skills when making fixes.\n"
        ]
        for name in skill_names:
            content = get_skill_content(name)
            if content:
                parts.append(f"\n{'=' * 40}\nSKILL: {name}\n{'=' * 40}\n{content}")
        return "\n".join(parts) if len(parts) > 1 else None
    except Exception:
        return None


def _build_fix_prompt(
    *,
    task: str,
    working_dir: str,
    findings_text: str,
    memory_context: str,
    retry_count: int,
    failure_history: list[str],
    insight_advice: object | None = None,
    plan_context: str = "",
    intake_context: str = "",
) -> str:
    """
    Build a structured fix prompt. Strategy changes based on retry_count:
    - retry 0-2: Standard root-cause fix with 3-phase approach
    - retry 3+:  Completely different strategy, informed by Insight if available
    """
    # Insight advice section
    insight_section = ""
    if insight_advice:
        diagnosis = getattr(insight_advice, "diagnosis", "")
        approach = getattr(insight_advice, "suggested_approach", "")
        insight_section = f"""
## INSIGHT GUIDANCE (from deeper analysis)
Diagnosis: {diagnosis}
Suggested approach: {approach}

You MUST follow Insight's suggested approach. Your previous attempts failed.
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
{intake_context}{plan_context}
## Retry Attempt
{retry_count} (of max 10)

## Issues Found by QA (sorted by severity — fix from top to bottom)
{findings_text or "No specific findings — general verification failed"}
{memory_context}
{history_section}

PRIORITY: Fix CRITICAL and HIGH severity issues FIRST. A "non-functional feature" or \
"crash-level bug" must be resolved before touching any MEDIUM or LOW issues. If you run \
out of turns, it is better to have fixed 2 critical bugs than 5 low-severity ones.

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
{intake_context}{plan_context}
## Working Directory
{working_dir}

## Current Issues (sorted by severity — fix from top to bottom)
{findings_text or "No specific findings — general verification failed"}
{memory_context}
{history_section}
{insight_section}

PRIORITY: Fix CRITICAL and HIGH severity issues FIRST. A "non-functional feature" or \
"crash-level bug" must be resolved before touching any MEDIUM or LOW issues.

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
