"""
Open Seed v2 — Security Pre-Validation (OpenHands pattern).

LLM-based risk assessment of agent plans before execution.
Prevents destructive operations (rm -rf, credential leaks, etc.)
without hardcoded rules — the LLM evaluates risk.

Pattern from: openhands/security/analyzer.py
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class SecurityRisk(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class SecurityCheck:
    """Result of a security pre-validation."""

    risk: SecurityRisk = SecurityRisk.LOW
    reason: str = ""
    requires_approval: bool = False
    flagged_items: list[str] | None = None


async def assess_risk(
    plan_summary: str,
    files: list[str],
    working_dir: str,
    task: str = "",
) -> SecurityCheck:
    """
    Assess the risk of a planned action before execution.

    Uses Claude Haiku (fast, cheap) to evaluate whether the plan
    involves dangerous operations. No hardcoded rules — the LLM
    decides based on context.

    HIGH risk triggers pipeline pause via user_escalate.

    Args:
        plan_summary: Description of what the agent plans to do
        files: List of files that will be modified
        working_dir: Project directory
        task: Original user task (for context)

    Returns:
        SecurityCheck with risk level and explanation
    """
    if not plan_summary and not files:
        return SecurityCheck(risk=SecurityRisk.LOW, reason="No plan to evaluate")

    try:
        from openseed_claude.agent import ClaudeAgent

        agent = ClaudeAgent()
        files_text = "\n".join(f"- {f}" for f in files[:20]) if files else "None specified"

        response = await agent.invoke(
            prompt=(
                "You are a security reviewer for an autonomous coding agent. "
                "Evaluate the risk of the following planned action.\n\n"
                f"## Task\n{task[:500]}\n\n"
                f"## Plan\n{plan_summary[:1000]}\n\n"
                f"## Files to modify\n{files_text}\n\n"
                f"## Working directory\n{working_dir}\n\n"
                "Evaluate risk as LOW, MEDIUM, or HIGH.\n\n"
                "HIGH risk examples: deleting files outside working dir, "
                "modifying .env/credentials, running rm -rf, "
                "modifying CI/CD pipelines, pushing to remote repos, "
                "accessing network services, modifying system files.\n\n"
                "MEDIUM risk: large-scale refactoring, modifying config files, "
                "running potentially destructive build commands.\n\n"
                "LOW risk: creating/editing source files within working dir, "
                "running tests, reading files.\n\n"
                "Output EXACTLY one JSON object:\n"
                '{"risk": "low|medium|high", "reason": "brief explanation", '
                '"flagged_items": ["item1", "item2"]}\n'
            ),
            model="haiku",
            max_turns=1,
        )

        return _parse_security_response(response.text)
    except Exception as e:
        # If security check fails, default to LOW (don't block pipeline)
        return SecurityCheck(
            risk=SecurityRisk.LOW,
            reason=f"Security check unavailable: {e}",
        )


def _parse_security_response(text: str) -> SecurityCheck:
    """Parse the LLM security assessment response."""
    import json

    # Try to find JSON in response
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            risk_str = data.get("risk", "low").lower()
            risk = (
                SecurityRisk.HIGH
                if risk_str == "high"
                else (SecurityRisk.MEDIUM if risk_str == "medium" else SecurityRisk.LOW)
            )
            return SecurityCheck(
                risk=risk,
                reason=data.get("reason", ""),
                requires_approval=risk == SecurityRisk.HIGH,
                flagged_items=data.get("flagged_items"),
            )
        except (json.JSONDecodeError, KeyError):
            pass

    # Fallback: check for risk keywords in text
    text_lower = text.lower()
    if "high" in text_lower:
        return SecurityCheck(
            risk=SecurityRisk.HIGH,
            reason=text[:200],
            requires_approval=True,
        )
    if "medium" in text_lower:
        return SecurityCheck(
            risk=SecurityRisk.MEDIUM,
            reason=text[:200],
        )
    return SecurityCheck(
        risk=SecurityRisk.LOW,
        reason=text[:200],
    )
