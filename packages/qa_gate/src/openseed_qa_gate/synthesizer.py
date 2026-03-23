"""
Open Seed v2 — Knowledge synthesizer.

LLM-driven aggregation of findings from multiple specialist agents.
Pattern from: awesome-codex-subagents knowledge-synthesizer TOML.

1. Collect all raw findings
2. Ask AI to deduplicate, resolve conflicts, assess false positives
3. Produce prioritized action list with confidence
"""

from __future__ import annotations

from openseed_core.types import Finding, Severity
from openseed_qa_gate.types import SpecialistResult


async def synthesize(
    results: list[SpecialistResult],
    event_bus=None,
) -> tuple[list[Finding], str]:
    """
    LLM-driven synthesis of findings from multiple specialists.
    """
    # Collect all raw findings
    all_raw: list[dict] = []
    for result in results:
        if not result.success:
            all_raw.append({"agent": result.agent_name, "severity": "info", "title": f"Agent failed", "description": result.error})
            continue
        for f in result.findings:
            if isinstance(f, dict):
                f["agent"] = f.get("agent", result.agent_name)
                all_raw.append(f)

    if not all_raw:
        return [], "No findings from any specialist"

    # Try LLM-driven synthesis
    try:
        from openseed_left_hand.agent import ClaudeAgent
        agent = ClaudeAgent()

        findings_text = "\n".join(
            f"- [{f.get('severity', 'medium')}] ({f.get('agent', '?')}): {f.get('title', f.get('description', ''))[:200]}"
            for f in all_raw
        )

        response = await agent.invoke(
            prompt=f"""You are a knowledge synthesizer for a QA gate.

{len(all_raw)} findings from {len(results)} specialist agents:

{findings_text}

Your job:
1. Deduplicate — merge findings about the same issue
2. Resolve contradictions — if agents disagree, explain why and pick the right one
3. Assess false positives — flag findings that seem overly cautious
4. Prioritize — critical issues first, cosmetic last
5. Produce a verdict: PASS (no issues), WARN (minor issues), BLOCK (critical issues)

Output valid JSON:
{{
  "verdict": "pass|warn|block",
  "summary": "one-line synthesis",
  "findings": [
    {{"severity": "critical|high|medium|low|info", "title": "...", "description": "...", "file": "...", "confidence": "high|medium|low"}}
  ]
}}""",
            model="sonnet",
            max_turns=1,
        )

        # Parse LLM response
        import json
        start = response.text.find("{")
        end = response.text.rfind("}")
        if start != -1 and end > start:
            data = json.loads(response.text[start:end + 1])

            findings = [
                _normalize_finding(f, "synthesizer")
                for f in data.get("findings", [])
            ]
            summary = data.get("summary", f"{len(findings)} findings after synthesis")
            return findings, summary

    except Exception:
        pass

    # Fallback: basic dedup without LLM
    findings = [_normalize_finding(f, f.get("agent", "unknown")) for f in all_raw]
    deduped = _deduplicate(findings)
    severity_order = {Severity.CRITICAL: 0, Severity.HIGH: 1, Severity.MEDIUM: 2, Severity.LOW: 3, Severity.INFO: 4}
    deduped.sort(key=lambda f: severity_order.get(f.severity, 5))
    counts = {}
    for f in deduped:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    summary = f"{len(deduped)} findings ({', '.join(f'{s.value}: {c}' for s, c in sorted(counts.items(), key=lambda x: severity_order.get(x[0], 5)))})"
    return deduped, summary


def _normalize_finding(raw: dict, agent_name: str) -> Finding:
    severity_map = {"critical": Severity.CRITICAL, "high": Severity.HIGH, "medium": Severity.MEDIUM, "low": Severity.LOW, "info": Severity.INFO}
    return Finding(
        agent=raw.get("agent", agent_name),
        severity=severity_map.get(str(raw.get("severity", "medium")).lower(), Severity.MEDIUM),
        title=str(raw.get("title", raw.get("summary", "")))[:200],
        description=str(raw.get("description", raw.get("details", "")))[:2000],
        file=str(raw.get("file", raw.get("path", ""))),
        line=raw.get("line") if isinstance(raw.get("line"), int) else None,
        suggestion=str(raw.get("suggestion", raw.get("fix", ""))),
        confidence=str(raw.get("confidence", "medium")),
    )


def _deduplicate(findings: list[Finding]) -> list[Finding]:
    seen: set[str] = set()
    deduped: list[Finding] = []
    for f in findings:
        key = f"{f.title}:{f.file}:{f.line}"
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    return deduped
