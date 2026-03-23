"""
Open Seed v2 — Claude agent role definitions.

Pattern from: claude-code-sdk-python AgentDefinition + examples/agents.py
Each role has a specific system prompt, model, and tool access.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Role:
    """A specialized role for the Claude agent."""
    name: str
    description: str
    system_prompt: str
    model: str = "sonnet"  # "opus" for deep reasoning, "sonnet" for implementation
    tools: list[str] = field(default_factory=list)
    thinking_budget: int = 0  # 0 = no extended thinking
    max_turns: int | None = None  # Per-role max turns (None = use agent default)


# ─── Pre-defined Roles ───────────────────────────────────────────────────────

ARCHITECT = Role(
    name="architect",
    description="Deep technical analysis and architecture design",
    system_prompt=(
        "You are an expert software architect. Analyze the task deeply, "
        "consider trade-offs, and produce a detailed implementation plan. "
        "Think step-by-step. Be specific about file structure, data flow, "
        "and component boundaries."
    ),
    model="opus",
    tools=["Read", "Grep", "Glob", "Bash"],
    thinking_budget=10_000,
)

IMPLEMENTER = Role(
    name="implementer",
    description="Write production-quality code",
    system_prompt=(
        "You are a senior software engineer. Write complete, production-ready code. "
        "No placeholders, no TODOs, no shortcuts. Every file must be runnable. "
        "Follow existing patterns in the codebase."
    ),
    model="sonnet",
    tools=["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
)

REVIEWER = Role(
    name="reviewer",
    description="Code review for correctness, security, and quality",
    system_prompt=(
        "You are a strict code reviewer. Check for: correctness, security vulnerabilities, "
        "missing error handling, test coverage gaps, and style inconsistencies. "
        "Be specific — cite file paths and line numbers."
    ),
    model="opus",
    tools=["Read", "Grep", "Glob"],
    thinking_budget=5_000,
)

DEBUGGER = Role(
    name="debugger",
    description="Diagnose and fix errors",
    system_prompt=(
        "You are an expert debugger. Read the error, trace the root cause, "
        "and fix it with minimal changes. Do not refactor — fix only the bug. "
        "Verify your fix by re-running the failing command."
    ),
    model="sonnet",
    tools=["Read", "Write", "Edit", "Bash", "Grep"],
)

ORACLE = Role(
    name="oracle",
    description="High-reasoning advisor for stuck situations",
    system_prompt=(
        "You are an oracle — a last-resort advisor when the agent is stuck. "
        "Analyze the full failure context, previous attempts, and suggest "
        "a completely different approach. Be creative. Think outside the box. "
        "You cannot execute — only advise."
    ),
    model="opus",
    tools=["Read", "Grep", "Glob"],
    thinking_budget=20_000,
)


# ─── Role Registry ───────────────────────────────────────────────────────────

ROLES: dict[str, Role] = {
    "architect": ARCHITECT,
    "implementer": IMPLEMENTER,
    "reviewer": REVIEWER,
    "debugger": DEBUGGER,
    "oracle": ORACLE,
}


def get_role(name: str) -> Role:
    """Get a role by name. Raises KeyError if not found."""
    return ROLES[name]
