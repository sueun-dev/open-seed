"""
7-Step Execution Loop: EXPLORE → PLAN → ROUTE → EXECUTE → VERIFY → RETRY → DONE

Pattern from: OmO Sisyphus protocol — Phase 0 through Phase 3.

Steps:
  1. EXPLORE  — search memory, assess codebase context
  2. PLAN     — what files to change, approach
  3. ROUTE    — delegate vs execute vs ask vs challenge
  4. EXECUTE  — placeholder for Brain's implement node
  5. VERIFY   — evidence-based, don't trust agent claims
  6. RETRY    — up to 3 times if verify fails
  7. DONE     — complete with final verification

All decisions by LLM. No regex, no hardcoded rules.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from openseed_core.auth.claude import require_claude_auth
from openseed_core.config import SisyphusConfig
from openseed_core.events import EventBus, EventType
from openseed_core.subprocess import run_streaming
from openseed_sisyphus.evidence import (
    auto_detect_test_commands,
    verify_files_exist,
    verify_implementation,
)
from openseed_sisyphus.prompts import (
    ModelFamily,
    PromptVariant,
    detect_model_family,
    get_prompt_variant,
)


@dataclass
class ExecutionResult:
    """Result of the full 7-step execution loop."""
    success: bool
    summary: str
    steps_completed: list[str]
    retry_count: int = 0
    final_verification: dict[str, Any] = field(default_factory=dict)


# ─── LLM helpers ─────────────────────────────────────────────────────────────


async def _call_claude(
    prompt: str,
    model: str,
    cli_path: str,
    timeout_seconds: int = 120,
) -> str:
    """Call Claude CLI in --print mode and return stdout text."""
    text_parts: list[str] = []

    async def on_line(line: Any) -> None:
        if line.source == "stdout" and line.text.strip():
            text_parts.append(line.text)

    await run_streaming(
        command=[
            cli_path,
            "--print",
            "--dangerously-skip-permissions",
            "--model", model,
            "--max-turns", "1",
            prompt,
        ],
        timeout_seconds=timeout_seconds,
        on_line=on_line,
    )

    return "\n".join(text_parts)


def _parse_json_from_text(text: str) -> dict[str, Any]:
    """Extract the first JSON object from arbitrary text."""
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except (json.JSONDecodeError, ValueError):
            pass
    return {}


# ─── Execution Loop ───────────────────────────────────────────────────────────


class ExecutionLoop:
    """
    The 7-step Sisyphus execution loop.

    Integrates intent classification, codebase exploration, planning,
    routing, execution context, evidence-based verification, and retry.

    Routing options (from ROUTE step):
      - "delegate"  — task should be sent to a sub-agent
      - "execute"   — proceed with direct implementation
      - "ask"       — clarification needed before proceeding
      - "challenge" — user's approach seems problematic; propose alternative
    """

    def __init__(
        self,
        config: SisyphusConfig | None = None,
        event_bus: EventBus | None = None,
        model: str | None = None,
    ) -> None:
        self.config = config or SisyphusConfig()
        self.event_bus = event_bus
        self.model = model
        self._model_family: ModelFamily = (
            detect_model_family(model) if model else ModelFamily.CLAUDE
        )
        self._prompt_variant: PromptVariant = get_prompt_variant(self._model_family)

    # ── Public API ────────────────────────────────────────────────────────────

    async def run(
        self,
        task: str,
        working_dir: str,
        context: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        """
        Run the full 7-step execution loop.

        Args:
            task: The user task description.
            working_dir: Absolute path to the working directory.
            context: Optional extra context (e.g. intent classification result).

        Returns:
            ExecutionResult with success flag, summary, and steps completed.
        """
        cli_path = require_claude_auth()
        ctx = context or {}
        steps_completed: list[str] = []

        # ── Step 1: EXPLORE ───────────────────────────────────────────────────
        await self._emit(EventType.NODE_START, node="explore", task=task[:100])
        explore = await self._explore(task, working_dir, ctx, cli_path)
        steps_completed.append("explore")
        await self._emit(EventType.NODE_COMPLETE, node="explore")

        # ── Step 2: PLAN ──────────────────────────────────────────────────────
        await self._emit(EventType.NODE_START, node="plan")
        plan = await self._plan(task, working_dir, explore, cli_path)
        steps_completed.append("plan")
        await self._emit(EventType.NODE_COMPLETE, node="plan")

        # ── Step 3: ROUTE ─────────────────────────────────────────────────────
        await self._emit(EventType.NODE_START, node="route")
        route = await self._route(task, plan, cli_path)
        steps_completed.append("route")
        await self._emit(EventType.NODE_COMPLETE, node="route", decision=route.get("decision", "execute"))

        # ── Step 4: EXECUTE ───────────────────────────────────────────────────
        await self._emit(EventType.NODE_START, node="execute")
        exec_result = await self._execute(task, working_dir, route, plan)
        steps_completed.append("execute")
        await self._emit(EventType.NODE_COMPLETE, node="execute")

        # ── Step 5: VERIFY ────────────────────────────────────────────────────
        await self._emit(EventType.NODE_START, node="verify")
        verify = await self._verify(working_dir, exec_result, plan)
        steps_completed.append("verify")
        await self._emit(EventType.NODE_COMPLETE, node="verify", passed=verify.get("passed", False))

        # ── Step 6: RETRY (max 3) ─────────────────────────────────────────────
        retry_count = 0
        while not verify.get("passed", False) and retry_count < 3:
            retry_count += 1
            await self._emit(
                EventType.SISYPHUS_RETRY,
                node="sisyphus",
                retry_count=retry_count,
            )
            exec_result = await self._retry(task, working_dir, verify, retry_count, plan, cli_path)
            verify = await self._verify(working_dir, exec_result, plan)
            steps_completed.append(f"retry_{retry_count}")

        # ── Step 7: DONE ──────────────────────────────────────────────────────
        steps_completed.append("done")

        return ExecutionResult(
            success=verify.get("passed", False),
            summary=verify.get("summary", ""),
            steps_completed=steps_completed,
            retry_count=retry_count,
            final_verification=verify,
        )

    # ── Private Steps ─────────────────────────────────────────────────────────

    async def _explore(
        self,
        task: str,
        working_dir: str,
        context: dict[str, Any],
        cli_path: str,
    ) -> dict[str, Any]:
        """
        Step 1: EXPLORE — ask Claude to analyse the task and codebase context.

        Uses Haiku for speed. Returns structured JSON with:
          - codebase_state: "disciplined" | "transitional" | "chaotic" | "greenfield"
          - relevant_patterns: list of observed patterns
          - assumptions: implicit assumptions that may affect outcome
          - summary: free-text exploration summary
        """
        intent_summary = ""
        if "intent" in context:
            ic = context["intent"]
            intent_summary = (
                f"Intent classification: {getattr(ic, 'intent_type', ic)} "
                f"(suggested: {getattr(ic, 'suggested_approach', '')})"
            )

        # Search memory for similar past tasks
        memory_context = ""
        try:
            from openseed_memory.store import MemoryStore
            store = MemoryStore()
            await store.initialize()
            results = await store.search(task, limit=5)
            if results:
                memory_context = "\nPast experiences:\n" + "\n".join(
                    f"- {r.entry.content[:200]}" for r in results
                )
        except Exception:
            pass

        if memory_context:
            intent_summary = (intent_summary + memory_context).strip()

        prompt = self._prompt_variant.explore_prompt.format(
            task=task,
            working_dir=working_dir,
            intent_summary=intent_summary,
        )
        call_model = self.model or "claude-haiku-4-5"
        raw = await _call_claude(prompt, model=call_model, cli_path=cli_path, timeout_seconds=90)
        data = _parse_json_from_text(raw)
        if not data:
            data = {"summary": raw[:500], "codebase_state": "unknown"}
        return data

    async def _plan(
        self,
        task: str,
        working_dir: str,
        explore: dict[str, Any],
        cli_path: str,
    ) -> dict[str, Any]:
        """
        Step 2: PLAN — ask Claude (Sonnet) to produce a structured implementation plan.

        Returns structured JSON with:
          - files_to_change: list of file paths
          - files_to_create: list of new file paths
          - steps: ordered list of step descriptions
          - expected_test_commands: commands to verify success
          - complexity: "trivial" | "moderate" | "complex"
        """
        codebase_state = explore.get("codebase_state", "unknown")
        patterns = explore.get("relevant_patterns", [])
        summary = explore.get("summary", "")

        prompt = self._prompt_variant.plan_prompt.format(
            task=task,
            working_dir=working_dir,
            codebase_state=codebase_state,
            patterns=", ".join(patterns) if patterns else "none identified",
            summary=summary,
        )
        call_model = self.model or "claude-sonnet-4-6"
        raw = await _call_claude(prompt, model=call_model, cli_path=cli_path, timeout_seconds=120)
        data = _parse_json_from_text(raw)
        if not data:
            data = {
                "files_to_change": [],
                "files_to_create": [],
                "steps": [raw[:300]],
                "expected_test_commands": [],
                "complexity": "moderate",
                "approach_summary": raw[:200],
            }
        return data

    async def _route(
        self,
        task: str,
        plan: dict[str, Any],
        cli_path: str,
    ) -> dict[str, Any]:
        """
        Step 3: ROUTE — ask Claude to decide the execution strategy.

        Returns structured JSON with:
          - decision: "delegate" | "execute" | "ask" | "challenge"
          - reason: explanation
          - sub_agent_type: (only for "delegate") recommended agent type
          - clarification_question: (only for "ask")
          - concern: (only for "challenge")
        """
        complexity = plan.get("complexity", "moderate")
        steps = plan.get("steps", [])
        approach = plan.get("approach_summary", "")

        prompt = self._prompt_variant.route_prompt.format(
            task=task,
            complexity=complexity,
            approach=approach,
            steps=steps[:5],
        )
        call_model = self.model or "claude-haiku-4-5"
        raw = await _call_claude(prompt, model=call_model, cli_path=cli_path, timeout_seconds=60)
        data = _parse_json_from_text(raw)
        if not data:
            data = {"decision": "execute", "reason": "Unable to route; defaulting to execute"}
        return data

    async def _execute(
        self,
        task: str,
        working_dir: str,
        route: dict[str, Any],
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Step 4: EXECUTE — placeholder for Brain's implement node.

        Actual code execution is performed by the Brain's implement node
        (LangGraph node that invokes Claude with full tool access). This step
        returns the execution context so the verify step knows what to check.

        Returns a dict that verify can consume:
          - claimed_files: files the plan intended to create/modify
          - working_dir: the working directory
          - route_decision: the routing decision
        """
        return {
            "working_dir": working_dir,
            "claimed_files": plan.get("files_to_create", []) + plan.get("files_to_change", []),
            "route_decision": route.get("decision", "execute"),
            "plan_steps": plan.get("steps", []),
            "test_commands": plan.get("expected_test_commands", []),
        }

    async def _verify(
        self,
        working_dir: str,
        exec_result: dict[str, Any],
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Step 5: VERIFY — evidence-based verification. Don't trust agent claims.

        Uses evidence.py to:
          1. Check that expected files actually exist on disk
          2. Auto-detect and run test commands
          3. Return structured pass/fail with evidence

        Returns:
          - passed: bool
          - summary: human-readable result
          - evidence: list of Evidence checks
          - missing_files: list of files that should exist but don't
          - failing_commands: list of commands that failed
        """
        expected_files = exec_result.get("claimed_files", [])
        test_commands = exec_result.get("test_commands") or plan.get("expected_test_commands", [])

        verification = await verify_implementation(
            working_dir=working_dir,
            expected_files=expected_files if expected_files else None,
            test_commands=test_commands if test_commands else None,
        )

        evidence_summaries = [
            f"{'PASS' if e.passed else 'FAIL'}: {e.check}" + (f" — {e.detail}" if e.detail else "")
            for e in verification.evidence
        ]

        if verification.all_passed:
            summary = f"All {len(verification.evidence)} checks passed."
        else:
            fail_count = sum(1 for e in verification.evidence if not e.passed)
            summary = (
                f"{fail_count}/{len(verification.evidence)} checks failed. "
                f"Missing: {verification.missing_files[:3]}. "
                f"Failing commands: {verification.failing_commands[:3]}."
            )

        return {
            "passed": verification.all_passed,
            "summary": summary,
            "evidence": evidence_summaries,
            "missing_files": verification.missing_files,
            "failing_commands": verification.failing_commands,
        }

    async def _retry(
        self,
        task: str,
        working_dir: str,
        verify: dict[str, Any],
        retry_count: int,
        plan: dict[str, Any],
        cli_path: str,
    ) -> dict[str, Any]:
        """
        Step 6: RETRY — ask Claude to analyse the failure and suggest a different approach.

        Uses Sonnet to diagnose what went wrong and propose corrective steps.
        Returns updated execution context (same shape as _execute output).
        """
        missing = verify.get("missing_files", [])
        failing = verify.get("failing_commands", [])
        evidence = verify.get("evidence", [])[:10]

        prompt = self._prompt_variant.retry_prompt.format(
            retry_count=retry_count,
            task=task,
            working_dir=working_dir,
            missing=missing,
            failing=failing,
            evidence="\n".join(f"  - {e}" for e in evidence),
            approach_summary=plan.get("approach_summary", ""),
        )
        call_model = self.model or "claude-sonnet-4-6"
        raw = await _call_claude(prompt, model=call_model, cli_path=cli_path, timeout_seconds=120)
        data = _parse_json_from_text(raw)

        corrective_files = data.get("files_to_check", [])
        new_commands = data.get("new_test_commands", [])

        # Merge with original plan context
        return {
            "working_dir": working_dir,
            "claimed_files": corrective_files or (plan.get("files_to_create", []) + plan.get("files_to_change", [])),
            "route_decision": "execute",
            "plan_steps": data.get("corrective_steps", []),
            "test_commands": new_commands or plan.get("expected_test_commands", []),
            "retry_diagnosis": data.get("diagnosis", ""),
        }

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _emit(self, event_type: EventType, **data: Any) -> None:
        """Fire an event on the event bus if available."""
        if self.event_bus:
            await self.event_bus.emit_simple(event_type, **data)
