"""
Intent Gate — classify task intent before execution.

Classify task intent before routing to the correct pipeline path.
All decisions by LLM (Claude Haiku for speed). No regex, no hardcoded rules.

Intent → Routing Map:
  research        → explore/recall → synthesize → answer
  implementation  → plan → delegate or execute
  investigation   → explore → report findings
  evaluation      → evaluate → propose → wait for confirmation
  fix             → diagnose → fix minimally
  open_ended      → assess codebase → propose approach
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum

from openseed_core.auth.claude import require_claude_auth
from openseed_core.subprocess import StreamLine, run_streaming

from openseed_guard.prompts import ModelFamily, detect_model_family


class IntentType(StrEnum):
    RESEARCH = "research"
    IMPLEMENTATION = "implementation"
    INVESTIGATION = "investigation"
    EVALUATION = "evaluation"
    FIX = "fix"
    OPEN_ENDED = "open_ended"


@dataclass
class IntentClassification:
    """Classification of a task's intent."""

    intent_type: IntentType
    confidence: float  # 0.0 – 1.0
    reasoning: str
    suggested_approach: str


_INTENT_PROMPT_TEMPLATE = """\
You are a task intent classifier. Given a task description, classify the true intent.

## Intent → Routing Map

| Surface Form | True Intent | Type |
|---|---|---|
| "explain X", "how does Y work" | Research/understanding | research |
| "implement X", "add Y", "create Z" | Explicit implementation | implementation |
| "look into X", "check Y", "investigate" | Investigation | investigation |
| "what do you think about X?" | Evaluation/proposal | evaluation |
| "error X", "broken", "fix Y" | Bug fix needed | fix |
| "refactor", "improve", "clean up", open scope | Open-ended change | open_ended |

## Task to Classify

{task}

## Codebase Context (if any)

{codebase_context}

## Output

Respond with ONLY valid JSON (no markdown, no explanation):
{{"intent_type": "<one of: research, implementation, investigation, evaluation, fix, open_ended>", "confidence": <float 0.0-1.0>, "reasoning": "<1-2 sentences explaining why this intent type>", "suggested_approach": "<brief routing suggestion, e.g. 'explore codebase → answer' or 'plan → implement → verify'>"}}
"""

# Gemini-specific prefix injected before the standard intent prompt.
# Gemini skips intent classification — this overlay enforces it.
_GEMINI_INTENT_PREFIX = """\
<GEMINI_INTENT_GATE_ENFORCEMENT>
YOU MUST CLASSIFY INTENT BEFORE ACTING. NO EXCEPTIONS.
Your failure mode: you skip classification and jump to implementation.
Do NOT start implementing. Do NOT start investigating. Classify FIRST.
Output ONLY the JSON specified. No preamble, no explanation, no tool calls.
</GEMINI_INTENT_GATE_ENFORCEMENT>

"""

# GPT-specific prefix: make the output contract explicit.
_GPT_INTENT_PREFIX = """\
<constraints>
- Output ONLY valid JSON — the exact schema specified below
- Do not produce prose, markdown, or preamble
- The output contract is binding
</constraints>

"""


async def classify_intent(
    task: str,
    codebase_context: str = "",
    model: str | None = None,
) -> IntentClassification:
    """
    Call Claude Haiku (or a specified model) to classify task intent.

    Uses --print --dangerously-skip-permissions for fast, non-interactive
    classification. Haiku is sufficient — this is routing logic, not deep analysis.

    Args:
        task: The user's task description.
        codebase_context: Optional codebase summary to improve accuracy.
        model: Optional model name. Selects model-specific prompt prefix.
               Defaults to claude-sonnet-4-6 if not specified.

    Returns:
        IntentClassification with type, confidence, reasoning, and approach.
    """
    cli_path = require_claude_auth()

    # Select model-specific prefix overlay
    model_family = detect_model_family(model) if model else ModelFamily.CLAUDE
    if model_family == ModelFamily.GEMINI:
        prefix = _GEMINI_INTENT_PREFIX
    elif model_family == ModelFamily.GPT:
        prefix = _GPT_INTENT_PREFIX
    else:
        prefix = ""

    base_prompt = _INTENT_PROMPT_TEMPLATE.format(
        task=task,
        codebase_context=codebase_context[:500] if codebase_context else "(none provided)",
    )
    prompt = prefix + base_prompt

    call_model = model or "claude-sonnet-4-6"
    cmd = [
        cli_path,
        "--print",
        "--dangerously-skip-permissions",
        "--model",
        call_model,
        "--max-turns",
        "1",
        prompt,
    ]

    text_parts: list[str] = []

    async def on_line(line: StreamLine) -> None:
        if line.source == "stdout" and line.text.strip():
            text_parts.append(line.text)

    await run_streaming(cmd, timeout_seconds=60, on_line=on_line)

    raw = "\n".join(text_parts)

    # Extract JSON from response
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(raw[start : end + 1])
            raw_type = data.get("intent_type", "open_ended")
            try:
                intent_type = IntentType(raw_type)
            except ValueError:
                intent_type = IntentType.OPEN_ENDED
            return IntentClassification(
                intent_type=intent_type,
                confidence=float(data.get("confidence", 0.5)),
                reasoning=data.get("reasoning", ""),
                suggested_approach=data.get("suggested_approach", ""),
            )
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    # Fallback: unable to parse
    return IntentClassification(
        intent_type=IntentType.OPEN_ENDED,
        confidence=0.1,
        reasoning="Failed to parse LLM response",
        suggested_approach="Clarify the task before proceeding",
    )
