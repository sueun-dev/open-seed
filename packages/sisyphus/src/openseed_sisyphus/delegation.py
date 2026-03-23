"""
Delegation prompt builder.

Pattern from: OmO Sisyphus — "Delegation Prompt Structure (MANDATORY - ALL 6 sections)".

When delegating to a sub-agent, the prompt MUST include all 6 sections:
1. TASK: Atomic, specific goal (one action per delegation)
2. EXPECTED OUTCOME: Concrete deliverables with success criteria
3. REQUIRED TOOLS: Explicit tool whitelist (prevents tool sprawl)
4. MUST DO: Exhaustive requirements — leave NOTHING implicit
5. MUST NOT DO: Forbidden actions — anticipate and block rogue behaviour
6. CONTEXT: File paths, existing patterns, constraints

Vague prompts are rejected. Be exhaustive.
"""

from __future__ import annotations


def build_delegation_prompt(
    task: str,
    expected_outcome: str,
    required_tools: list[str],
    must_do: list[str],
    must_not: list[str],
    context: str,
) -> str:
    """
    Build a structured 6-section delegation prompt for sub-agent delegation.

    Args:
        task: Atomic, specific goal — one action per delegation.
        expected_outcome: Concrete deliverables with measurable success criteria.
        required_tools: Explicit tool whitelist (prevents tool sprawl).
        must_do: Exhaustive list of requirements — leave nothing implicit.
        must_not: Forbidden actions — anticipate and block rogue behaviour.
        context: Relevant file paths, existing patterns, and constraints.

    Returns:
        Formatted delegation prompt with all 6 mandatory sections.
    """
    tools_str = "\n".join(f"- {t}" for t in required_tools) if required_tools else "- (all tools available)"
    must_do_str = "\n".join(f"- {r}" for r in must_do) if must_do else "- (none specified)"
    must_not_str = "\n".join(f"- {f}" for f in must_not) if must_not else "- (none specified)"

    return f"""\
## TASK
{task}

## EXPECTED OUTCOME
{expected_outcome}

## REQUIRED TOOLS
{tools_str}

## MUST DO
{must_do_str}

## MUST NOT DO
{must_not_str}

## CONTEXT
{context}
"""
