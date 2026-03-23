"""
Open Seed v2 — Knowledge synthesizer.

Aggregates findings from multiple specialist agents into a unified report.
Pattern from: awesome-codex-subagents knowledge-synthesizer TOML.

Process:
1. Normalize findings into comparable claims
2. Deduplicate overlapping findings
3. Rate confidence and severity
4. Produce prioritized action list
"""

from __future__ import annotations

from openseed_core.events import EventBus
from openseed_core.types import Finding, Severity
from openseed_qa_gate.types import SpecialistResult


async def synthesize(
    results: list[SpecialistResult],
    event_bus: EventBus | None = None,
) -> tuple[list[Finding], str]:
    """
    Synthesize findings from multiple specialists.

    Args:
        results: List of specialist results
        event_bus: For streaming

    Returns:
        (findings, synthesis_summary)
    """
    all_findings: list[Finding] = []

    for result in results:
        if not result.success:
            all_findings.append(Finding(
                agent=result.agent_name,
                severity=Severity.INFO,
                title=f"Agent {result.agent_name} failed",
                description=result.error,
            ))
            continue

        for raw_finding in result.findings:
            finding = _normalize_finding(raw_finding, result.agent_name)
            all_findings.append(finding)

    # Deduplicate by title similarity
    deduped = _deduplicate(all_findings)

    # Sort by severity (critical first)
    severity_order = {Severity.CRITICAL: 0, Severity.HIGH: 1, Severity.MEDIUM: 2, Severity.LOW: 3, Severity.INFO: 4}
    deduped.sort(key=lambda f: severity_order.get(f.severity, 5))

    # Build summary
    counts = {}
    for f in deduped:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    summary_parts = [f"{s.value}: {c}" for s, c in sorted(counts.items(), key=lambda x: severity_order.get(x[0], 5))]
    summary = f"{len(deduped)} findings ({', '.join(summary_parts)})" if summary_parts else "No findings"

    return deduped, summary


def _normalize_finding(raw: dict, agent_name: str) -> Finding:
    """Normalize a raw finding dict into a typed Finding."""
    severity_str = str(raw.get("severity", raw.get("level", "medium"))).lower()
    severity_map = {
        "critical": Severity.CRITICAL,
        "high": Severity.HIGH,
        "medium": Severity.MEDIUM,
        "low": Severity.LOW,
        "info": Severity.INFO,
    }
    return Finding(
        agent=raw.get("agent", agent_name),
        severity=severity_map.get(severity_str, Severity.MEDIUM),
        title=str(raw.get("title", raw.get("summary", "")))[:200],
        description=str(raw.get("description", raw.get("details", raw.get("reason", ""))))[:2000],
        file=str(raw.get("file", raw.get("path", ""))),
        line=raw.get("line") if isinstance(raw.get("line"), int) else None,
        suggestion=str(raw.get("suggestion", raw.get("fix", raw.get("recommendation", "")))),
        confidence=str(raw.get("confidence", "medium")),
    )


def _deduplicate(findings: list[Finding]) -> list[Finding]:
    """Simple deduplication by title."""
    seen: set[str] = set()
    deduped: list[Finding] = []
    for f in findings:
        key = f"{f.title}:{f.file}:{f.line}"
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    return deduped
