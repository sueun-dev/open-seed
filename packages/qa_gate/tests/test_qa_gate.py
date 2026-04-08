"""
Comprehensive tests for the QA Gate package.

Covers:
- Synthesizer: LLM-driven finding aggregation, fallback, dedup, conflict resolution
- AgentSelector: LLM-based agent selection, fallback, validation
- Gate: full integration flow, verdict logic
- Types: dataclass field validation
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

from openseed_core.types import Finding, QAResult, Severity, Verdict
from openseed_qa_gate.types import AgentDefinition, SpecialistResult, SynthesisStats

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_subprocess_result(
    stdout: str,
    exit_code: int = 0,
    timed_out: bool = False,
    stderr: str = "",
) -> MagicMock:
    """Build a mock SubprocessResult."""
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.exit_code = exit_code
    result.timed_out = timed_out
    return result


def _make_agent(
    name: str = "test-agent",
    description: str = "A test agent",
    model: str = "gpt-5.4",
    sandbox_mode: str = "read-only",
    instructions: str = "Review the code carefully.",
) -> AgentDefinition:
    return AgentDefinition(
        name=name,
        description=description,
        model=model,
        sandbox_mode=sandbox_mode,
        instructions=instructions,
    )


def _make_specialist_result(
    agent_name: str = "agent-a",
    findings: list[dict] | None = None,
    success: bool = True,
    error: str = "",
    agent_description: str = "",
) -> SpecialistResult:
    return SpecialistResult(
        agent_name=agent_name,
        agent_description=agent_description,
        findings=findings if findings is not None else [],
        success=success,
        error=error,
    )


# ─── 1. Synthesizer tests ─────────────────────────────────────────────────────


class TestSynthesizeNoFindings:
    async def test_synthesize_no_findings_returns_empty(self):
        """When all agents succeed but report no findings, return empty list."""
        from openseed_qa_gate.synthesizer import synthesize

        results = [_make_specialist_result(agent_name="agent-a", findings=[])]
        findings, summary, llm_verdict = await synthesize(results)

        assert findings == []
        assert "No findings" in summary
        assert llm_verdict is None

    async def test_synthesize_empty_results_list(self):
        """An empty results list should return empty findings immediately."""
        from openseed_qa_gate.synthesizer import synthesize

        findings, summary, llm_verdict = await synthesize([])

        assert findings == []
        assert "No findings" in summary
        assert llm_verdict is None


class TestSynthesizeWithLLMSuccess:
    async def test_synthesize_llm_returns_valid_json(self):
        """LLM returns valid JSON — findings are parsed and returned."""
        from openseed_qa_gate.synthesizer import synthesize

        llm_response = json.dumps(
            {
                "verdict": "warn",
                "summary": "One medium issue found",
                "findings": [
                    {
                        "severity": "medium",
                        "title": "Missing null check",
                        "description": "Variable x may be None",
                        "file": "src/foo.py",
                        "line": 42,
                        "suggestion": "Add None guard",
                        "confidence": "high",
                        "source_agents": ["agent-a"],
                        "evidence_type": "confirmed",
                        "conflict_resolution": "",
                    }
                ],
                "conflicts_resolved": 0,
                "false_positives_removed": 0,
            }
        )

        mock_proc = _make_subprocess_result(stdout=llm_response)

        raw_finding = {"severity": "medium", "title": "Missing null check", "description": "Variable x may be None"}
        results = [_make_specialist_result(agent_name="agent-a", findings=[raw_finding])]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        assert len(findings) == 1
        assert findings[0].severity == Severity.MEDIUM
        assert findings[0].title == "Missing null check"
        assert "One medium issue found" in summary
        assert llm_verdict == "warn"

    async def test_synthesize_llm_response_wrapped_in_markdown(self):
        """Claude sometimes wraps JSON in markdown fences — should still parse."""
        from openseed_qa_gate.synthesizer import synthesize

        inner_json = json.dumps(
            {
                "verdict": "pass",
                "summary": "No issues",
                "findings": [],
                "conflicts_resolved": 0,
                "false_positives_removed": 0,
            }
        )
        wrapped = f"```json\n{inner_json}\n```"

        mock_proc = _make_subprocess_result(stdout=wrapped)
        raw_finding = {"severity": "info", "title": "Style note", "description": "Minor style issue"}
        results = [_make_specialist_result(agent_name="agent-a", findings=[raw_finding])]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        assert findings == []
        assert "No issues" in summary
        assert llm_verdict == "pass"

    async def test_synthesize_llm_skips_false_positives(self):
        """Findings with evidence_type=false_positive must be excluded from output."""
        from openseed_qa_gate.synthesizer import synthesize

        llm_response = json.dumps(
            {
                "verdict": "pass",
                "summary": "One false positive filtered",
                "findings": [
                    {
                        "severity": "high",
                        "title": "Looks like SQL injection",
                        "description": "This is actually parameterised",
                        "file": "",
                        "line": None,
                        "suggestion": "",
                        "confidence": "low",
                        "source_agents": ["security-auditor"],
                        "evidence_type": "false_positive",
                        "conflict_resolution": "",
                    }
                ],
                "conflicts_resolved": 0,
                "false_positives_removed": 1,
            }
        )

        mock_proc = _make_subprocess_result(stdout=llm_response)
        raw_finding = {"severity": "high", "title": "Looks like SQL injection", "description": "..."}
        results = [_make_specialist_result(agent_name="security-auditor", findings=[raw_finding])]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        assert findings == []
        assert llm_verdict == "pass"

    async def test_synthesize_llm_sorts_by_severity(self):
        """Output findings must be sorted critical → info."""
        from openseed_qa_gate.synthesizer import synthesize

        llm_response = json.dumps(
            {
                "verdict": "block",
                "summary": "Critical issue found",
                "findings": [
                    {
                        "severity": "info",
                        "title": "Info note",
                        "description": "...",
                        "file": "",
                        "line": None,
                        "suggestion": "",
                        "confidence": "high",
                        "source_agents": ["agent-a"],
                        "evidence_type": "confirmed",
                        "conflict_resolution": "",
                    },
                    {
                        "severity": "critical",
                        "title": "Critical bug",
                        "description": "...",
                        "file": "",
                        "line": None,
                        "suggestion": "",
                        "confidence": "high",
                        "source_agents": ["agent-a"],
                        "evidence_type": "confirmed",
                        "conflict_resolution": "",
                    },
                    {
                        "severity": "medium",
                        "title": "Medium issue",
                        "description": "...",
                        "file": "",
                        "line": None,
                        "suggestion": "",
                        "confidence": "medium",
                        "source_agents": ["agent-a"],
                        "evidence_type": "confirmed",
                        "conflict_resolution": "",
                    },
                ],
                "conflicts_resolved": 0,
                "false_positives_removed": 0,
            }
        )

        mock_proc = _make_subprocess_result(stdout=llm_response)
        results = [
            _make_specialist_result(
                agent_name="agent-a", findings=[{"severity": "info", "title": "x", "description": "y"}]
            )
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, _, llm_verdict = await synthesize(results)

        assert len(findings) == 3
        assert findings[0].severity == Severity.CRITICAL
        assert llm_verdict == "block"
        assert findings[1].severity == Severity.MEDIUM
        assert findings[2].severity == Severity.INFO


class TestSynthesizeFallback:
    async def test_synthesize_fallback_on_llm_failure(self):
        """When Claude subprocess raises, fallback to basic dedup without crashing."""
        from openseed_qa_gate.synthesizer import synthesize

        results = [
            _make_specialist_result(
                agent_name="agent-a",
                findings=[{"severity": "high", "title": "Bug", "description": "A serious bug"}],
            )
        ]

        with (
            patch(
                "openseed_core.subprocess.run_streaming",
                new_callable=AsyncMock,
                side_effect=RuntimeError("subprocess failed"),
            ),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        # Fallback path should still return the finding
        assert len(findings) == 1
        assert findings[0].severity == Severity.HIGH
        assert "LLM unavailable" in summary
        assert llm_verdict is None

    async def test_synthesize_fallback_on_timeout(self):
        """A timed-out subprocess triggers the fallback path."""
        from openseed_qa_gate.synthesizer import synthesize

        mock_proc = _make_subprocess_result(stdout="", timed_out=True)
        results = [
            _make_specialist_result(
                agent_name="agent-b",
                findings=[{"severity": "low", "title": "Minor", "description": "Style"}],
            )
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        assert len(findings) == 1
        assert "LLM unavailable" in summary
        assert llm_verdict is None

    async def test_synthesize_fallback_on_invalid_json(self):
        """Malformed JSON in LLM output triggers the fallback path gracefully."""
        from openseed_qa_gate.synthesizer import synthesize

        mock_proc = _make_subprocess_result(stdout="not valid json at all!!!")
        results = [
            _make_specialist_result(
                agent_name="agent-c",
                findings=[{"severity": "medium", "title": "Issue", "description": "Something"}],
            )
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, llm_verdict = await synthesize(results)

        assert len(findings) >= 1
        assert "LLM unavailable" in summary
        assert llm_verdict is None


class TestSynthesizeDeduplicate:
    async def test_synthesize_dedup_same_finding_in_fallback(self):
        """Fallback dedup removes identical title+file+line findings."""
        from openseed_qa_gate.synthesizer import synthesize

        dup_finding = {"severity": "medium", "title": "Same bug", "description": "Dup", "file": "foo.py", "line": 10}
        results = [
            _make_specialist_result(agent_name="agent-a", findings=[dup_finding, dup_finding]),
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=RuntimeError("fail")),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, _, _ = await synthesize(results)

        # After dedup, the same finding should appear only once
        titles = [f.title for f in findings]
        assert titles.count("Same bug") == 1

    async def test_synthesize_different_files_not_deduped(self):
        """Findings with same title but different files are treated as distinct."""
        from openseed_qa_gate.synthesizer import synthesize

        f1 = {"severity": "low", "title": "Style issue", "description": "x", "file": "a.py", "line": 1}
        f2 = {"severity": "low", "title": "Style issue", "description": "x", "file": "b.py", "line": 1}
        results = [_make_specialist_result(agent_name="agent-a", findings=[f1, f2])]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=RuntimeError("fail")),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, _, _ = await synthesize(results)

        assert len(findings) == 2


class TestSynthesizeAgentFailures:
    async def test_synthesize_handles_agent_failures(self):
        """Failed agents inject an 'Agent failed' info finding into the synthesis input."""
        from openseed_qa_gate.synthesizer import synthesize

        results = [
            _make_specialist_result(agent_name="broken-agent", success=False, error="Connection refused"),
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=RuntimeError("fail")),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, summary, _ = await synthesize(results)

        # The fallback should have normalised the failure finding
        assert len(findings) == 1
        assert findings[0].title == "Agent failed"
        assert findings[0].severity == Severity.INFO

    async def test_synthesize_mixed_success_and_failure(self):
        """Mix of successful and failed agents — both contribute to synthesis input."""
        from openseed_qa_gate.synthesizer import synthesize

        results = [
            _make_specialist_result(
                agent_name="good-agent",
                findings=[{"severity": "high", "title": "Real bug", "description": "Serious"}],
                success=True,
            ),
            _make_specialist_result(agent_name="bad-agent", success=False, error="Timeout"),
        ]

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=RuntimeError("fail")),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            findings, _, _ = await synthesize(results)

        titles = {f.title for f in findings}
        assert "Real bug" in titles
        assert "Agent failed" in titles


class TestNormalizeFinding:
    def test_normalize_finding_maps_severities(self):
        """_normalize_finding correctly maps all severity strings."""
        from openseed_qa_gate.synthesizer import _normalize_finding

        for raw_sev, expected in [
            ("critical", Severity.CRITICAL),
            ("high", Severity.HIGH),
            ("medium", Severity.MEDIUM),
            ("low", Severity.LOW),
            ("info", Severity.INFO),
        ]:
            raw = {"severity": raw_sev, "title": "T", "description": "D"}
            finding = _normalize_finding(raw, "agent-x")
            assert finding.severity == expected, f"Failed for severity={raw_sev}"

    def test_normalize_finding_unknown_severity_defaults_to_medium(self):
        """Unknown severity strings should fall back to MEDIUM."""
        from openseed_qa_gate.synthesizer import _normalize_finding

        raw = {"severity": "bogus", "title": "T", "description": "D"}
        finding = _normalize_finding(raw, "agent-x")
        assert finding.severity == Severity.MEDIUM

    def test_normalize_finding_with_metadata_appends_sources(self):
        """_normalize_finding_with_metadata embeds source_agents in description."""
        from openseed_qa_gate.synthesizer import _normalize_finding_with_metadata

        raw = {
            "severity": "high",
            "title": "Issue",
            "description": "Details here",
            "source_agents": ["agent-a", "agent-b"],
            "evidence_type": "hypothesis",
            "conflict_resolution": "agent-a said high, agent-b said medium, chose high",
        }
        finding = _normalize_finding_with_metadata(raw)

        assert "[Sources: agent-a, agent-b]" in finding.description
        assert "[Evidence type: hypothesis]" in finding.description
        assert "agent-a said high" in finding.description
        assert finding.agent == "agent-a"  # First source agent


class TestSynthesizeConflictResolution:
    async def test_synthesize_conflict_resolution_in_prompt(self):
        """Verify that when agents produce conflicting findings, the prompt sent to Claude
        contains both agents' inputs so Claude can adjudicate."""
        from openseed_qa_gate.synthesizer import synthesize

        # Two agents reporting the same issue with different severities
        results = [
            _make_specialist_result(
                agent_name="agent-low",
                findings=[
                    {"severity": "low", "title": "SQL query", "description": "Possibly slow", "confidence": "high"}
                ],
                agent_description="Performance reviewer",
            ),
            _make_specialist_result(
                agent_name="agent-high",
                findings=[
                    {"severity": "high", "title": "SQL query", "description": "N+1 problem", "confidence": "high"}
                ],
                agent_description="Security reviewer",
            ),
        ]

        captured_cmd: list = []

        async def fake_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            # Simulate no JSON returned to trigger fallback
            raise RuntimeError("no claude")

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=fake_run),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            await synthesize(results)  # returns 3-tuple but we only care about the prompt

        # The prompt (last element of cmd) should contain both agent names
        prompt_text = " ".join(str(c) for c in captured_cmd)
        assert "agent-low" in prompt_text
        assert "agent-high" in prompt_text


# ─── 2. AgentSelector tests ───────────────────────────────────────────────────


class TestSelectAgentsReturnAllWhenFew:
    async def test_select_agents_returns_all_when_few(self):
        """When available agents <= max_agents, all are returned without LLM call."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name=f"agent-{i}") for i in range(3)]

        with patch("openseed_qa_gate.agent_selector._select_with_llm", new_callable=AsyncMock) as mock_llm:
            result = await select_agents("task", "summary", agents, max_agents=5)

        mock_llm.assert_not_called()
        assert result == agents

    async def test_select_agents_empty_list(self):
        """Empty available_agents list returns empty without error."""
        from openseed_qa_gate.agent_selector import select_agents

        result = await select_agents("task", "summary", [], max_agents=5)
        assert result == []


class TestSelectAgentsLLMSelectsSubset:
    async def test_select_agents_llm_selects_subset(self):
        """LLM response picks a valid named subset; result respects that selection."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name=f"agent-{i}") for i in range(6)]
        # LLM picks only agent-1 and agent-3
        llm_response = json.dumps(["agent-1", "agent-3"])
        mock_proc = _make_subprocess_result(stdout=llm_response)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=3)

        assert len(result) == 2
        assert {a.name for a in result} == {"agent-1", "agent-3"}

    async def test_select_agents_respects_max_agents_cap(self):
        """Even if LLM returns more names than max_agents, cap is enforced."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name=f"agent-{i}") for i in range(10)]
        # LLM returns 8 valid names, but max_agents=3
        llm_response = json.dumps([f"agent-{i}" for i in range(8)])
        mock_proc = _make_subprocess_result(stdout=llm_response)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=3)

        assert len(result) == 3


class TestSelectAgentsFallback:
    async def test_select_agents_fallback_on_failure(self):
        """When LLM selection fails, all available agents are returned."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name=f"agent-{i}") for i in range(6)]

        with (
            patch(
                "openseed_core.subprocess.run_streaming", new_callable=AsyncMock, side_effect=RuntimeError("timeout")
            ),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=3)

        # Fallback: all 6 agents returned
        assert result == agents

    async def test_select_agents_fallback_on_timeout(self):
        """Timed-out subprocess triggers fallback to all agents."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name=f"agent-{i}") for i in range(6)]
        mock_proc = _make_subprocess_result(stdout="", timed_out=True)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=3)

        assert result == agents


class TestSelectAgentsValidatesNames:
    async def test_select_agents_validates_names(self):
        """Names returned by LLM that don't match available agents are silently dropped."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name="real-agent"), _make_agent(name="other-agent")]
        # LLM returns one valid and one hallucinated name
        llm_response = json.dumps(["real-agent", "hallucinated-agent", "also-fake"])
        mock_proc = _make_subprocess_result(stdout=llm_response)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=1)

        assert len(result) == 1
        assert result[0].name == "real-agent"

    async def test_select_agents_all_names_invalid_triggers_fallback(self):
        """When every LLM-returned name is invalid, RuntimeError triggers fallback."""
        from openseed_qa_gate.agent_selector import select_agents

        agents = [_make_agent(name="real-agent")]
        llm_response = json.dumps(["fake-1", "fake-2"])
        mock_proc = _make_subprocess_result(stdout=llm_response)

        with (
            patch("openseed_core.subprocess.run_streaming", new_callable=AsyncMock, return_value=mock_proc),
            patch("openseed_core.auth.openai.require_openai_auth", return_value="/usr/local/bin/codex"),
        ):
            result = await select_agents("task", "summary", agents, max_agents=5)

        # Should fall back to returning all agents
        assert result == agents


# ─── 3. Gate tests ────────────────────────────────────────────────────────────


class TestDetermineVerdict:
    """Unit tests for verdict resolution — pure logic, no mocking needed."""

    def test_determine_verdict_pass(self):
        """No findings → PASS."""
        from openseed_qa_gate.gate import _determine_verdict

        assert _determine_verdict([], block_on_critical=True) == Verdict.PASS

    def test_determine_verdict_pass_with_low_and_info(self):
        """Only low/info findings → PASS."""
        from openseed_qa_gate.gate import _determine_verdict

        findings = [
            Finding(severity=Severity.LOW, title="Minor"),
            Finding(severity=Severity.INFO, title="FYI"),
        ]
        assert _determine_verdict(findings, block_on_critical=True) == Verdict.PASS

    def test_determine_verdict_warn_on_high(self):
        """High finding → WARN (not BLOCK) when block_on_critical=True."""
        from openseed_qa_gate.gate import _determine_verdict

        findings = [Finding(severity=Severity.HIGH, title="High issue")]
        assert _determine_verdict(findings, block_on_critical=True) == Verdict.WARN

    def test_determine_verdict_warn_on_critical_when_blocking_disabled(self):
        """Critical finding with block_on_critical=False → WARN, not BLOCK."""
        from openseed_qa_gate.gate import _determine_verdict

        findings = [Finding(severity=Severity.CRITICAL, title="Critical bug")]
        assert _determine_verdict(findings, block_on_critical=False) == Verdict.WARN

    def test_determine_verdict_block(self):
        """Critical finding with block_on_critical=True → BLOCK."""
        from openseed_qa_gate.gate import _determine_verdict

        findings = [Finding(severity=Severity.CRITICAL, title="Security hole")]
        assert _determine_verdict(findings, block_on_critical=True) == Verdict.BLOCK

    def test_determine_verdict_block_takes_priority(self):
        """Mix of severities: critical dominates → BLOCK."""
        from openseed_qa_gate.gate import _determine_verdict

        findings = [
            Finding(severity=Severity.LOW, title="Low"),
            Finding(severity=Severity.CRITICAL, title="Critical"),
            Finding(severity=Severity.MEDIUM, title="Medium"),
        ]
        assert _determine_verdict(findings, block_on_critical=True) == Verdict.BLOCK


class TestResolveVerdict:
    """Unit tests for _resolve_verdict — LLM verdict + safety floor."""

    def test_llm_verdict_pass_trusted(self):
        """LLM says pass with no critical findings → PASS."""
        from openseed_qa_gate.gate import _resolve_verdict

        findings = [Finding(severity=Severity.HIGH, title="High issue")]
        assert _resolve_verdict("pass", findings, block_on_critical=True) == Verdict.PASS

    def test_llm_verdict_overridden_by_critical(self):
        """LLM says pass but critical finding exists → BLOCK (safety floor)."""
        from openseed_qa_gate.gate import _resolve_verdict

        findings = [Finding(severity=Severity.CRITICAL, title="RCE")]
        assert _resolve_verdict("pass", findings, block_on_critical=True) == Verdict.BLOCK

    def test_llm_verdict_block_without_critical(self):
        """LLM says block with no critical findings → BLOCK (trust LLM)."""
        from openseed_qa_gate.gate import _resolve_verdict

        findings = [Finding(severity=Severity.HIGH, title="Pattern issue")]
        assert _resolve_verdict("block", findings, block_on_critical=True) == Verdict.BLOCK

    def test_llm_verdict_none_falls_back(self):
        """No LLM verdict → fallback to severity-based logic."""
        from openseed_qa_gate.gate import _resolve_verdict

        findings = [Finding(severity=Severity.HIGH, title="High")]
        assert _resolve_verdict(None, findings, block_on_critical=True) == Verdict.WARN

    def test_llm_verdict_invalid_string_falls_back(self):
        """Invalid LLM verdict string → fallback to severity-based logic."""
        from openseed_qa_gate.gate import _resolve_verdict

        findings = [Finding(severity=Severity.LOW, title="Low")]
        assert _resolve_verdict("maybe", findings, block_on_critical=True) == Verdict.PASS


class TestRunQAGateFullFlow:
    async def test_run_qa_gate_full_flow(self):
        """Full integration: load agents → select → run specialists → synthesize → verdict."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        agent = _make_agent(name="reviewer")
        specialist_result = _make_specialist_result(
            agent_name="reviewer",
            findings=[{"severity": "low", "title": "Minor style", "description": "A style issue"}],
        )

        with (
            patch("openseed_qa_gate.gate.load_active_agents", return_value=[agent]),
            patch("openseed_qa_gate.gate.select_agents", new_callable=AsyncMock, return_value=[agent]),
            patch("openseed_qa_gate.gate.run_specialist", new_callable=AsyncMock, return_value=specialist_result),
            patch(
                "openseed_qa_gate.gate.synthesize",
                new_callable=AsyncMock,
                return_value=(
                    [Finding(severity=Severity.LOW, title="Minor style", description="A style issue")],
                    "1 finding (low)",
                    "pass",
                ),
            ),
        ):
            cfg = QAGateConfig(active_agents=["reviewer"])
            result = await run_qa_gate("Review this code", "/tmp/project", config=cfg)

        assert isinstance(result, QAResult)
        assert result.verdict == Verdict.PASS
        assert len(result.findings) == 1
        assert "reviewer" in result.agents_run

    async def test_run_qa_gate_no_agents(self):
        """When no agents are loaded, return WARN with empty findings."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        with patch("openseed_qa_gate.gate.load_active_agents", return_value=[]):
            cfg = QAGateConfig(active_agents=[])
            result = await run_qa_gate("Review this code", "/tmp/project", config=cfg)

        assert result.verdict == Verdict.WARN
        assert result.findings == []
        assert result.agents_run == []
        assert "No QA agents" in result.synthesis

    async def test_run_qa_gate_blocks_on_critical(self):
        """Critical finding from specialist causes BLOCK verdict."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        agent = _make_agent(name="security-auditor")
        specialist_result = _make_specialist_result(
            agent_name="security-auditor",
            findings=[{"severity": "critical", "title": "RCE", "description": "Remote code execution"}],
        )
        critical_finding = Finding(severity=Severity.CRITICAL, title="RCE", description="Remote code execution")

        with (
            patch("openseed_qa_gate.gate.load_active_agents", return_value=[agent]),
            patch("openseed_qa_gate.gate.select_agents", new_callable=AsyncMock, return_value=[agent]),
            patch("openseed_qa_gate.gate.run_specialist", new_callable=AsyncMock, return_value=specialist_result),
            patch(
                "openseed_qa_gate.gate.synthesize",
                new_callable=AsyncMock,
                return_value=([critical_finding], "Critical: RCE found", "block"),
            ),
        ):
            cfg = QAGateConfig(active_agents=["security-auditor"], block_on_critical=True)
            result = await run_qa_gate("Review auth code", "/tmp/project", config=cfg)

        assert result.verdict == Verdict.BLOCK

    async def test_run_qa_gate_specialist_exception_handled(self):
        """If a specialist raises an exception (via gather), it is wrapped in SpecialistResult."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        agent = _make_agent(name="flaky-agent")

        # run_specialist raises instead of returning
        with (
            patch("openseed_qa_gate.gate.load_active_agents", return_value=[agent]),
            patch("openseed_qa_gate.gate.select_agents", new_callable=AsyncMock, return_value=[agent]),
            patch("openseed_qa_gate.gate.run_specialist", new_callable=AsyncMock, side_effect=RuntimeError("crashed")),
            patch("openseed_qa_gate.gate.synthesize", new_callable=AsyncMock, return_value=([], "0 findings", "pass")),
        ):
            cfg = QAGateConfig(active_agents=["flaky-agent"])
            result = await run_qa_gate("task", "/tmp/project", config=cfg)

        # Should not raise — exception is swallowed into SpecialistResult
        assert isinstance(result, QAResult)
        assert result.verdict == Verdict.PASS

    async def test_run_qa_gate_duration_ms_populated(self):
        """duration_ms in QAResult should be a positive integer."""
        from openseed_core.config import QAGateConfig
        from openseed_qa_gate.gate import run_qa_gate

        agent = _make_agent(name="reviewer")

        with (
            patch("openseed_qa_gate.gate.load_active_agents", return_value=[agent]),
            patch("openseed_qa_gate.gate.select_agents", new_callable=AsyncMock, return_value=[agent]),
            patch(
                "openseed_qa_gate.gate.run_specialist", new_callable=AsyncMock, return_value=_make_specialist_result()
            ),
            patch("openseed_qa_gate.gate.synthesize", new_callable=AsyncMock, return_value=([], "No issues", "pass")),
        ):
            cfg = QAGateConfig(active_agents=["reviewer"])
            result = await run_qa_gate("task", "/tmp/project", config=cfg)

        assert isinstance(result.duration_ms, int)
        assert result.duration_ms >= 0


# ─── 4. Types tests ───────────────────────────────────────────────────────────


class TestAgentDefinitionFields:
    def test_agent_definition_fields(self):
        """AgentDefinition stores all fields with correct defaults."""
        agent = AgentDefinition(name="my-agent", description="Does stuff")

        assert agent.name == "my-agent"
        assert agent.description == "Does stuff"
        assert agent.model == "gpt-5.4"
        assert agent.model_reasoning_effort == "high"
        assert agent.sandbox_mode == "read-only"
        assert agent.instructions == ""
        assert agent.mcp_servers == {}

    def test_agent_definition_custom_fields(self):
        """AgentDefinition stores custom field values."""
        agent = AgentDefinition(
            name="security-agent",
            description="Security focused",
            model="gpt-5.4",
            sandbox_mode="workspace-write",
            instructions="Look for XSS and SQLi",
            mcp_servers={"tools": {"command": "npx", "args": ["-y", "mcp-server"]}},
        )

        assert agent.model == "gpt-5.4"
        assert agent.sandbox_mode == "workspace-write"
        assert "XSS" in agent.instructions
        assert "tools" in agent.mcp_servers


class TestSpecialistResultFields:
    def test_specialist_result_defaults(self):
        """SpecialistResult has correct default values."""
        result = SpecialistResult(agent_name="my-agent")

        assert result.agent_name == "my-agent"
        assert result.agent_description == ""
        assert result.findings == []
        assert result.raw_output == ""
        assert result.success is True
        assert result.error == ""
        assert result.duration_ms == 0

    def test_specialist_result_failure_state(self):
        """SpecialistResult correctly represents a failed agent run."""
        result = SpecialistResult(
            agent_name="broken-agent",
            success=False,
            error="Connection refused",
            duration_ms=5000,
        )

        assert result.success is False
        assert result.error == "Connection refused"
        assert result.duration_ms == 5000
        assert result.findings == []

    def test_synthesis_stats_defaults(self):
        """SynthesisStats initialises all counters to zero / False."""
        stats = SynthesisStats()

        assert stats.total_raw_findings == 0
        assert stats.agents_succeeded == 0
        assert stats.agents_failed == 0
        assert stats.conflicts_resolved == 0
        assert stats.false_positives_removed == 0
        assert stats.llm_used is False
