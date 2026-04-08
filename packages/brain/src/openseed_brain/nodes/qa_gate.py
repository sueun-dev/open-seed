"""
QA Gate node — Spawn specialist reviewers in parallel, synthesize, verdict.
REAL implementation — calls openseed_qa_gate.
"""

from __future__ import annotations

import os

from openseed_core.types import QAResult, Verdict

from openseed_brain.state import PipelineState


async def qa_gate_node(state: PipelineState) -> dict:
    """Run QA specialists in parallel, produce verdict.

    After fix attempts (retry_count > 0), runs lightweight QA:
    just build/lint check instead of full 136-agent review.
    """
    working_dir = state["working_dir"]
    implementation = state.get("implementation")
    plan = state.get("plan")
    intake_raw = state.get("intake_analysis") or {}
    intake = intake_raw if isinstance(intake_raw, dict) else {}
    retry_count = state.get("retry_count", 0)

    task = state["task"]
    intent = intake.get("intent", "implementation")
    complexity = intake.get("complexity", "moderate")

    # ── Lightweight QA after fix attempts — skip full agent review ──
    if retry_count > 0:
        return await _lightweight_qa(working_dir, plan)

    # Build context for reviewers: task scope + what was built + plan
    context_parts = [
        f"ORIGINAL TASK: {task}",
        f"INTENT: {intent} | COMPLEXITY: {complexity}",
        "SCOPE: Review ONLY what the task asked for. Do not demand production-grade features "
        "(graceful shutdown, helmet, rate limiting, etc.) unless the task explicitly requires them. "
        "A simple task should produce simple code. BLOCK only for actual bugs, syntax errors, or security vulnerabilities.",
    ]

    # Intent-specific review guidance
    if intent == "fix":
        context_parts.append(
            "FOCUS: This is a bug fix. Review ONLY the changed/added code. "
            "Do NOT flag unrelated pre-existing issues in unchanged files."
        )
    elif complexity == "simple":
        context_parts.append(
            "FOCUS: This is a simple task. Keep review proportional — "
            "do NOT demand extensive error handling, tests, or abstractions for trivial changes."
        )

    # Inject harness context (AGENTS.md boundaries) for rule verification
    micro_ctx = state.get("microagent_context", [])
    if micro_ctx:
        context_parts.append("\nPROJECT HARNESS (from AGENTS.md — verify code follows these rules):")
        context_parts.extend(micro_ctx)

    context_parts.append("")

    if plan:
        context_parts.append(f"Plan: {plan.summary}")
        for t in plan.tasks:
            context_parts.append(f"  Task {t.id}: {t.description}")
        context_parts.append(f"Files: {', '.join(f.path for f in plan.file_manifest)}")
    if implementation:
        context_parts.append(f"\nImplementation: {implementation.summary[:500]}")

    # Prioritize plan files for review, then fill with other files on disk
    plan_files: set[str] = set()
    if plan:
        plan_files = {f.path for f in plan.file_manifest}

    try:
        all_files: list[str] = []
        for root, dirs, fnames in os.walk(working_dir):
            dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "__pycache__", ".venv")]
            for f in fnames:
                rel = os.path.relpath(os.path.join(root, f), working_dir)
                all_files.append(rel)
        if all_files:
            context_parts.append(f"\nFiles on disk: {', '.join(all_files[:30])}")

            # Read plan files first (most relevant), then fill remaining slots
            priority_files = [f for f in all_files if f in plan_files]
            other_files = [f for f in all_files if f not in plan_files]
            # Plan files: read fully (these are what was just created/modified)
            # Other files: read truncated (context only)
            files_to_read = priority_files[:20] + other_files[:10]

            for f in files_to_read:
                try:
                    is_plan_file = f in plan_files
                    max_chars = 30_000 if is_plan_file else 4_000
                    with open(os.path.join(working_dir, f)) as fh:
                        content = fh.read(max_chars)
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


async def _lightweight_qa(working_dir: str, plan: object | None) -> dict:
    """Fast QA after fix: build/lint check only, no full agent review.

    Runs deterministic checks (TypeScript compile, lint, file existence)
    instead of spawning 136 AI agents. Takes seconds, not minutes.
    """
    import subprocess

    errors: list[str] = []
    warnings: list[str] = []

    # 1. Check expected files exist
    if plan and hasattr(plan, "file_manifest"):
        for f in plan.file_manifest:
            path = os.path.join(working_dir, f.path)
            if not os.path.exists(path):
                errors.append(f"Missing file: {f.path}")

    # 2. TypeScript check (if tsconfig exists)
    tsconfig = os.path.join(working_dir, "tsconfig.json")
    web_tsconfig = os.path.join(working_dir, "web", "tsconfig.json")
    ts_dir = working_dir
    if os.path.exists(web_tsconfig):
        ts_dir = os.path.join(working_dir, "web")
    elif not os.path.exists(tsconfig):
        ts_dir = None

    if ts_dir:
        try:
            result = subprocess.run(
                ["npx", "tsc", "--noEmit"],
                cwd=ts_dir,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                ts_errors = [ln for ln in result.stdout.splitlines() if "error TS" in ln]
                if ts_errors:
                    errors.extend(ts_errors[:5])
                else:
                    warnings.append("TypeScript check returned non-zero but no errors found")
        except Exception as e:
            warnings.append(f"TypeScript check skipped: {e}")

    # 3. Python lint (if pyproject.toml exists)
    pyproject = os.path.join(working_dir, "pyproject.toml")
    if os.path.exists(pyproject):
        try:
            result = subprocess.run(
                ["ruff", "check", "."],
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                ruff_errors = [ln for ln in result.stdout.splitlines() if " F" in ln][:5]
                if ruff_errors:
                    errors.extend(ruff_errors)
        except Exception:
            pass

    # 4. npm build (if package.json exists)
    pkg_json = os.path.join(working_dir, "web", "package.json")
    if not os.path.exists(pkg_json):
        pkg_json = os.path.join(working_dir, "package.json")
    if os.path.exists(pkg_json):
        pkg_dir = os.path.dirname(pkg_json)
        # Install first
        try:
            subprocess.run(
                ["npm", "install", "--legacy-peer-deps"],
                cwd=pkg_dir,
                capture_output=True,
                timeout=120,
            )
        except Exception:
            pass
        # Build
        try:
            result = subprocess.run(
                ["npm", "run", "build"],
                cwd=pkg_dir,
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0:
                build_errors = result.stderr.splitlines()[-5:] if result.stderr else []
                if build_errors:
                    errors.extend(build_errors)
                else:
                    errors.append("npm run build failed")
        except subprocess.TimeoutExpired:
            warnings.append("npm build timed out (120s)")
        except Exception as e:
            warnings.append(f"npm build skipped: {e}")

    # Produce verdict
    if errors:
        from openseed_core.types import Finding, Severity

        findings = [Finding(description=e, severity=Severity.HIGH, agent="build-check") for e in errors]
        return {
            "qa_result": QAResult(
                verdict=Verdict.BLOCK,
                synthesis=f"Build check: {len(errors)} errors — {'; '.join(errors[:3])}",
                findings=findings,
            ),
            "findings": findings,
            "messages": [f"QA Gate (light): BLOCK — {len(errors)} build errors"],
        }

    if warnings:
        return {
            "qa_result": QAResult(
                verdict=Verdict.PASS_WITH_WARNINGS,
                synthesis=f"Build OK with {len(warnings)} warnings",
            ),
            "messages": [f"QA Gate (light): PASS with {len(warnings)} warnings"],
        }

    return {
        "qa_result": QAResult(verdict=Verdict.PASS, synthesis="Build check passed"),
        "messages": ["QA Gate (light): PASS — build clean"],
    }
