"""
Open Seed v2 — Knowledge synthesizer.

LLM-driven aggregation of findings from multiple specialist agents.
Pattern from: awesome-codex-subagents knowledge-synthesizer TOML.

Working mode (mirrors knowledge-synthesizer.toml):
1. Normalize inputs into comparable claims, evidence, and confidence levels
2. Deduplicate overlapping findings while preserving unique constraints
3. Separate confirmed facts from inference and open hypotheses
4. Build a decision-oriented synthesis with explicit unresolved gaps

Features:
- Conflict resolution: When agents disagree on severity, Claude examines
  evidence and picks the correct answer with explanation
- Confidence weighting: High confidence findings get priority, low get
  flagged as "needs verification"
- Evidence traceability: Each finding tracks source agents and evidence
  type (confirmed / hypothesis / false_positive)
- False positive detection: Claude flags overly cautious findings
"""

from __future__ import annotations

import json
import logging

from openseed_core.types import Finding, Severity

from openseed_qa_gate.types import SpecialistResult, SynthesisStats

logger = logging.getLogger(__name__)


async def synthesize(
    results: list[SpecialistResult],
    event_bus=None,
) -> tuple[list[Finding], str, str | None]:
    """
    LLM-driven synthesis of findings from multiple specialists.

    Uses Claude Sonnet to:
    - Group findings about the same issue across agents
    - Resolve conflicts when agents disagree on severity
    - Flag false positives / overly cautious findings
    - Separate confirmed facts from hypotheses
    - Weight by confidence level

    Falls back to basic deduplication if Claude is unavailable.

    Returns:
        (findings, summary_text, llm_verdict_or_none)
    """
    stats = SynthesisStats()

    # Collect and annotate all raw findings with their source agent
    all_raw: list[dict] = []
    for result in results:
        if not result.success:
            stats.agents_failed += 1
            all_raw.append(
                {
                    "agent": result.agent_name,
                    "severity": "info",
                    "title": "Agent failed",
                    "description": result.error or "Unknown error",
                    "confidence": "low",
                }
            )
            continue

        stats.agents_succeeded += 1
        for f in result.findings:
            if isinstance(f, dict):
                enriched = dict(f)
                enriched["agent"] = f.get("agent", result.agent_name)
                all_raw.append(enriched)

    stats.total_raw_findings = len(all_raw)

    if not all_raw:
        return [], "No findings from any specialist", None

    # Try LLM-driven synthesis via Claude Sonnet subprocess
    try:
        synth_findings, summary, llm_stats = await _synthesize_with_llm(all_raw, results)
        stats.conflicts_resolved = llm_stats.get("conflicts_resolved", 0)
        stats.false_positives_removed = llm_stats.get("false_positives_removed", 0)
        stats.llm_used = True

        if event_bus:
            try:
                from openseed_core.events import EventType

                await event_bus.emit_simple(
                    EventType.QA_SYNTHESIS_COMPLETE,
                    node="qa_gate",
                    raw_findings=stats.total_raw_findings,
                    synthesized_findings=len(synth_findings),
                    conflicts_resolved=stats.conflicts_resolved,
                    false_positives_removed=stats.false_positives_removed,
                    llm_used=True,
                )
            except Exception:
                pass

        llm_verdict = llm_stats.get("verdict")
        return synth_findings, summary, llm_verdict

    except Exception as exc:
        logger.warning("LLM synthesis failed (%s), falling back to basic dedup", exc)

    # Fallback: basic deduplication without LLM
    findings = [_normalize_finding(f, f.get("agent", "unknown")) for f in all_raw]
    deduped = _deduplicate(findings)

    severity_order = {
        Severity.CRITICAL: 0,
        Severity.HIGH: 1,
        Severity.MEDIUM: 2,
        Severity.LOW: 3,
        Severity.INFO: 4,
    }
    deduped.sort(key=lambda f: severity_order.get(f.severity, 5))

    counts: dict = {}
    for f in deduped:
        counts[f.severity] = counts.get(f.severity, 0) + 1

    summary = f"{len(deduped)} findings (basic dedup, LLM unavailable) — " + ", ".join(
        f"{s.value}: {c}" for s, c in sorted(counts.items(), key=lambda x: severity_order.get(x[0], 5))
    )
    return deduped, summary, None


async def _synthesize_with_llm(
    all_raw: list[dict],
    results: list[SpecialistResult],
) -> tuple[list[Finding], str, dict]:
    """
    Call Claude Sonnet via subprocess to perform full knowledge synthesis.

    Follows the knowledge-synthesizer.toml working mode:
    - Normalize, deduplicate, separate confirmed from hypothesis
    - Resolve conflicts, detect false positives
    - Return decision-oriented synthesis with traceability
    """
    from openseed_core.auth.openai import require_openai_auth
    from openseed_core.subprocess import run_streaming

    cli = require_openai_auth()

    n_agents = len(results)
    n_findings = len(all_raw)

    # Build structured findings text for the prompt
    findings_lines = []
    for i, f in enumerate(all_raw, 1):
        agent = f.get("agent", "unknown")
        severity = f.get("severity", "medium")
        confidence = f.get("confidence", "medium")
        title = f.get("title", f.get("description", ""))[:200]
        description = f.get("description", "")[:500]
        file_ref = f.get("file", "")
        line_ref = f.get("line", "")

        loc = ""
        if file_ref:
            loc = f" [{file_ref}"
            if line_ref:
                loc += f":{line_ref}"
            loc += "]"

        findings_lines.append(
            f"{i}. [{severity.upper()}] agent={agent} confidence={confidence}{loc}\n"
            f"   Title: {title}\n"
            f"   Detail: {description}"
        )

    findings_text = "\n\n".join(findings_lines)

    # Build agent summary for context
    agent_summary_lines = []
    for r in results:
        status = "OK" if r.success else f"FAILED: {r.error[:100] if r.error else '?'}"
        desc = f" ({r.agent_description})" if r.agent_description else ""
        agent_summary_lines.append(f"- {r.agent_name}{desc}: {status}, {len(r.findings)} findings")
    agent_summary = "\n".join(agent_summary_lines)

    prompt = f"""You are a knowledge synthesizer for a QA gate. {n_agents} specialist agents reviewed code and produced {n_findings} raw findings.

AGENTS THAT RAN:
{agent_summary}

RAW FINDINGS (with source agent and confidence):
{findings_text}

YOUR TASKS:
1. GROUP findings about the same underlying issue (even if worded differently by different agents)
2. RESOLVE CONFLICTS — when agents disagree on severity or impact, examine the evidence, pick the correct answer, and explain why in "conflict_resolution"
3. FLAG FALSE POSITIVES — overly cautious or context-missing findings should have evidence_type="false_positive"
4. SEPARATE facts from hypotheses — use evidence_type="confirmed" for clear issues, "hypothesis" for uncertain ones
5. WEIGHT by confidence — high-confidence findings are prioritized, low-confidence get confidence="low" in output
6. VERDICT: "pass" (safe to deploy), "warn" (minor issues, deploy with caution), "block" (must fix before deploy)

SYNTHESIS RULES (from knowledge-synthesizer pattern):
- Do not flatten contradictory results into false consensus
- Each synthesized finding must be traceable to at least one source agent via source_agents
- Preserve unique constraints even when deduplicating
- Surface conflicts rather than averaging them away
- Uncertainty language must reflect actual evidence strength

Output ONLY valid JSON, no markdown, no explanation outside the JSON:
{{
  "verdict": "pass|warn|block",
  "summary": "one concise sentence describing the overall state",
  "findings": [
    {{
      "severity": "critical|high|medium|low|info",
      "title": "short descriptive title",
      "description": "full details including why this matters",
      "file": "path/to/file or empty string",
      "line": null,
      "suggestion": "how to fix this",
      "confidence": "high|medium|low",
      "source_agents": ["agent-name-1", "agent-name-2"],
      "evidence_type": "confirmed|hypothesis|false_positive",
      "conflict_resolution": "explanation if agents disagreed, else empty string"
    }}
  ],
  "conflicts_resolved": 0,
  "false_positives_removed": 0
}}"""

    cmd = [
        cli,
        "exec",
        "--full-auto",
        "-m",
        "gpt-5.4",
        prompt,
    ]

    proc_result = await run_streaming(cmd, timeout_seconds=120)

    if proc_result.timed_out:
        raise RuntimeError("Claude synthesis timed out after 120s")
    if proc_result.exit_code != 0 and not proc_result.stdout.strip():
        raise RuntimeError(f"Claude synthesis failed (exit {proc_result.exit_code}): {proc_result.stderr[:300]}")

    raw_text = proc_result.stdout.strip()

    # Extract JSON from response (Claude may wrap in markdown code fences)
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError(f"No JSON object found in Claude response: {raw_text[:300]}")

    data = json.loads(raw_text[start : end + 1])

    findings: list[Finding] = []
    for raw_f in data.get("findings", []):
        # Skip explicit false positives from the synthesized output
        if raw_f.get("evidence_type") == "false_positive":
            continue
        findings.append(_normalize_finding_with_metadata(raw_f))

    # Sort by severity
    severity_order = {
        Severity.CRITICAL: 0,
        Severity.HIGH: 1,
        Severity.MEDIUM: 2,
        Severity.LOW: 3,
        Severity.INFO: 4,
    }
    findings.sort(key=lambda f: severity_order.get(f.severity, 5))

    summary = data.get("summary", f"{len(findings)} findings after LLM synthesis")
    llm_stats = {
        "conflicts_resolved": int(data.get("conflicts_resolved", 0)),
        "false_positives_removed": int(data.get("false_positives_removed", 0)),
        "verdict": data.get("verdict"),
    }

    return findings, summary, llm_stats


def _normalize_finding_with_metadata(raw: dict) -> Finding:
    """
    Normalize a finding dict from LLM synthesis output.

    Preserves source_agents and evidence_type in the description
    for traceability (Finding dataclass has no extra fields).
    """
    severity_map = {
        "critical": Severity.CRITICAL,
        "high": Severity.HIGH,
        "medium": Severity.MEDIUM,
        "low": Severity.LOW,
        "info": Severity.INFO,
    }

    source_agents = raw.get("source_agents", [])
    evidence_type = raw.get("evidence_type", "confirmed")
    conflict_resolution = raw.get("conflict_resolution", "")

    # Enrich description with traceability metadata
    description = str(raw.get("description", ""))[:1800]
    if source_agents:
        description += f"\n\n[Sources: {', '.join(source_agents)}]"
    if evidence_type and evidence_type != "confirmed":
        description += f"\n[Evidence type: {evidence_type}]"
    if conflict_resolution:
        description += f"\n[Conflict resolution: {conflict_resolution}]"

    # Primary agent attribution: first source agent or "synthesizer"
    agent_name = source_agents[0] if source_agents else "synthesizer"

    return Finding(
        agent=agent_name,
        severity=severity_map.get(str(raw.get("severity", "medium")).lower(), Severity.MEDIUM),
        title=str(raw.get("title", raw.get("summary", "")))[:200],
        description=description[:2000],
        file=str(raw.get("file", raw.get("path", ""))),
        line=raw.get("line") if isinstance(raw.get("line"), int) else None,
        suggestion=str(raw.get("suggestion", raw.get("fix", "")))[:500],
        confidence=str(raw.get("confidence", "medium")),
    )


def _normalize_finding(raw: dict, agent_name: str) -> Finding:
    """Normalize a raw finding dict to a Finding dataclass (basic fallback path)."""
    severity_map = {
        "critical": Severity.CRITICAL,
        "high": Severity.HIGH,
        "medium": Severity.MEDIUM,
        "low": Severity.LOW,
        "info": Severity.INFO,
    }
    return Finding(
        agent=raw.get("agent", agent_name),
        severity=severity_map.get(str(raw.get("severity", "medium")).lower(), Severity.MEDIUM),
        title=str(raw.get("title", raw.get("summary", "")))[:200],
        description=str(raw.get("description", raw.get("details", "")))[:2000],
        file=str(raw.get("file", raw.get("path", ""))),
        line=raw.get("line") if isinstance(raw.get("line"), int) else None,
        suggestion=str(raw.get("suggestion", raw.get("fix", "")))[:500],
        confidence=str(raw.get("confidence", "medium")),
    )


def _deduplicate(findings: list[Finding]) -> list[Finding]:
    """Basic deduplication by title + file + line key (fallback path only)."""
    seen: set[str] = set()
    deduped: list[Finding] = []
    for f in findings:
        key = f"{f.title}:{f.file}:{f.line}"
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    return deduped
