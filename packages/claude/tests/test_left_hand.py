"""
Open Seed v2 — Comprehensive tests for the Left Hand package.

Covers:
  1. Messages — pure unit tests for UsageStats, CostEstimate, estimate_cost
  2. Parser   — pure unit tests for parse_json_output, parse_text_output, parse_output
  3. Roles    — pure unit tests for role registry and get_role
  4. ClaudeAgent — mocked subprocess tests for invoke()
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_claude.messages import (
    StructuredResponse,
    UsageStats,
    estimate_cost,
)
from openseed_claude.parser import (
    _try_extract_usage_from_stderr,
    parse_json_output,
    parse_output,
    parse_text_output,
)
from openseed_claude.roles import ROLES, get_role

# ─── Shared fixtures ──────────────────────────────────────────────────────────

SAMPLE_NDJSON = (
    '{"type":"system","session_id":"sess-123"}\n'
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
    '[{"type":"text","text":"Hello world"}],'
    '"usage":{"input_tokens":100,"output_tokens":50}}}\n'
    '{"type":"result","session_id":"sess-123","duration_ms":1500,"num_turns":1,'
    '"usage":{"input_tokens":100,"output_tokens":50}}'
)

SAMPLE_NDJSON_WITH_THINKING = (
    '{"type":"system","session_id":"sess-think"}\n'
    '{"type":"assistant","message":{"model":"claude-opus-4-6","content":'
    '[{"type":"thinking","thinking":"Let me reason through this..."},'
    '{"type":"text","text":"The answer is 42"}],'
    '"usage":{"input_tokens":200,"output_tokens":80}}}\n'
    '{"type":"result","session_id":"sess-think","duration_ms":2000,"num_turns":1,'
    '"usage":{"input_tokens":200,"output_tokens":80}}'
)

SAMPLE_NDJSON_WITH_TOOL_USE = (
    '{"type":"system","session_id":"sess-tools"}\n'
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
    '[{"type":"tool_use","id":"tu-001","name":"Read","input":{"file_path":"/tmp/foo.py"}}],'
    '"usage":{"input_tokens":50,"output_tokens":20}}}\n'
    '{"type":"result","session_id":"sess-tools","duration_ms":800,"num_turns":1,'
    '"usage":{"input_tokens":50,"output_tokens":20}}'
)

SAMPLE_NDJSON_WITH_TOOL_RESULT = (
    '{"type":"system","session_id":"sess-tr"}\n'
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
    '[{"type":"tool_result","tool_use_id":"tu-001","content":"file contents here","is_error":false}],'
    '"usage":{"input_tokens":60,"output_tokens":10}}}\n'
    '{"type":"result","session_id":"sess-tr","duration_ms":400,"num_turns":1,'
    '"usage":{"input_tokens":60,"output_tokens":10}}'
)

SAMPLE_NDJSON_MULTI_ASSISTANT = (
    '{"type":"system","session_id":"sess-multi"}\n'
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
    '[{"type":"text","text":"Part one."}],'
    '"usage":{"input_tokens":30,"output_tokens":10}}}\n'
    '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
    '[{"type":"text","text":"Part two."}],'
    '"usage":{"input_tokens":30,"output_tokens":15}}}\n'
    '{"type":"result","session_id":"sess-multi","duration_ms":1200,"num_turns":2,'
    '"usage":{"input_tokens":60,"output_tokens":25}}'
)


# ═════════════════════════════════════════════════════════════════════════════
# 1. Messages — pure unit tests
# ═════════════════════════════════════════════════════════════════════════════


class TestUsageStats:
    def test_usage_stats_total_tokens(self):
        usage = UsageStats(input_tokens=300, output_tokens=150)
        assert usage.total_tokens == 450

    def test_usage_stats_total_tokens_zeros(self):
        usage = UsageStats()
        assert usage.total_tokens == 0

    def test_usage_stats_total_tokens_excludes_cache(self):
        # cache tokens are NOT counted in total_tokens
        usage = UsageStats(
            input_tokens=100,
            output_tokens=50,
            cache_read_tokens=1000,
            cache_write_tokens=500,
        )
        assert usage.total_tokens == 150

    def test_usage_stats_defaults(self):
        usage = UsageStats()
        assert usage.input_tokens == 0
        assert usage.output_tokens == 0
        assert usage.cache_read_tokens == 0
        assert usage.cache_write_tokens == 0


class TestEstimateCost:
    def test_estimate_cost_opus(self):
        usage = UsageStats(input_tokens=1_000_000, output_tokens=1_000_000)
        cost = estimate_cost(usage, "claude-opus-4-6")
        assert cost.input_cost == pytest.approx(15.0)
        assert cost.output_cost == pytest.approx(75.0)
        assert cost.total_cost == pytest.approx(90.0)
        assert cost.model == "claude-opus-4-6"

    def test_estimate_cost_sonnet(self):
        usage = UsageStats(input_tokens=1_000_000, output_tokens=1_000_000)
        cost = estimate_cost(usage, "claude-sonnet-4-6")
        assert cost.input_cost == pytest.approx(3.0)
        assert cost.output_cost == pytest.approx(15.0)
        assert cost.total_cost == pytest.approx(18.0)

    def test_estimate_cost_haiku(self):
        usage = UsageStats(input_tokens=1_000_000, output_tokens=1_000_000)
        cost = estimate_cost(usage, "claude-haiku-4-5")
        assert cost.input_cost == pytest.approx(0.80)
        assert cost.output_cost == pytest.approx(4.0)
        assert cost.total_cost == pytest.approx(4.80)

    def test_estimate_cost_unknown_model_defaults_to_sonnet(self):
        usage = UsageStats(input_tokens=1_000_000, output_tokens=1_000_000)
        cost = estimate_cost(usage, "some-unknown-model-xyz")
        # Defaults to sonnet pricing
        assert cost.input_cost == pytest.approx(3.0)
        assert cost.output_cost == pytest.approx(15.0)
        assert cost.model == "some-unknown-model-xyz"

    def test_estimate_cost_partial_model_match(self):
        usage = UsageStats(input_tokens=1_000_000, output_tokens=1_000_000)
        # "claude-sonnet-4-5" is not in the table but contains "sonnet"
        cost = estimate_cost(usage, "claude-sonnet-4-5")
        # Should match "sonnet" alias pricing
        assert cost.input_cost == pytest.approx(3.0)
        assert cost.output_cost == pytest.approx(15.0)

    def test_estimate_cost_alias_opus(self):
        usage = UsageStats(input_tokens=500_000, output_tokens=250_000)
        cost = estimate_cost(usage, "opus")
        assert cost.input_cost == pytest.approx(7.5)
        assert cost.output_cost == pytest.approx(18.75)

    def test_estimate_cost_zero_usage(self):
        usage = UsageStats()
        cost = estimate_cost(usage, "claude-sonnet-4-6")
        assert cost.total_cost == pytest.approx(0.0)
        assert cost.input_cost == pytest.approx(0.0)
        assert cost.output_cost == pytest.approx(0.0)


class TestStructuredResponseDefaults:
    def test_structured_response_defaults(self):
        r = StructuredResponse()
        assert r.text == ""
        assert r.thinking == ""
        assert r.tool_uses == []
        assert r.tool_results == []
        assert isinstance(r.usage, UsageStats)
        assert r.model == ""
        assert r.session_id == ""
        assert r.duration_ms == 0
        assert r.num_turns == 0
        assert r.is_error is False
        assert r.raw_json is None


# ═════════════════════════════════════════════════════════════════════════════
# 2. Parser — pure unit tests (most critical)
# ═════════════════════════════════════════════════════════════════════════════


class TestParseJsonOutput:
    def test_parse_json_output_assistant_message(self):
        result = parse_json_output(SAMPLE_NDJSON)
        assert result.text == "Hello world"
        assert result.model == "claude-sonnet-4-6"
        assert result.session_id == "sess-123"

    def test_parse_json_output_result_message(self):
        result = parse_json_output(SAMPLE_NDJSON)
        assert result.duration_ms == 1500
        assert result.num_turns == 1
        assert result.usage.input_tokens == 100
        assert result.usage.output_tokens == 50
        assert result.is_error is False
        assert result.raw_json is not None
        assert result.raw_json["type"] == "result"

    def test_parse_json_output_thinking_block(self):
        result = parse_json_output(SAMPLE_NDJSON_WITH_THINKING)
        assert result.thinking == "Let me reason through this..."
        assert result.text == "The answer is 42"
        assert result.model == "claude-opus-4-6"

    def test_parse_json_output_tool_use_block(self):
        result = parse_json_output(SAMPLE_NDJSON_WITH_TOOL_USE)
        assert len(result.tool_uses) == 1
        tu = result.tool_uses[0]
        assert tu.tool_id == "tu-001"
        assert tu.tool_name == "Read"
        assert tu.input == {"file_path": "/tmp/foo.py"}

    def test_parse_json_output_tool_result_block(self):
        result = parse_json_output(SAMPLE_NDJSON_WITH_TOOL_RESULT)
        assert len(result.tool_results) == 1
        tr = result.tool_results[0]
        assert tr.tool_use_id == "tu-001"
        assert tr.content == "file contents here"
        assert tr.is_error is False

    def test_parse_json_output_tool_result_list_content(self):
        ndjson = (
            '{"type":"system","session_id":"sess-trl"}\n'
            '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
            '[{"type":"tool_result","tool_use_id":"tu-002",'
            '"content":[{"type":"text","text":"line1"},{"type":"text","text":"line2"}],'
            '"is_error":false}],'
            '"usage":{"input_tokens":40,"output_tokens":5}}}\n'
            '{"type":"result","session_id":"sess-trl","duration_ms":200,"num_turns":1,'
            '"usage":{"input_tokens":40,"output_tokens":5}}'
        )
        result = parse_json_output(ndjson)
        assert len(result.tool_results) == 1
        assert result.tool_results[0].content == "line1\nline2"

    def test_parse_json_output_multiple_messages(self):
        result = parse_json_output(SAMPLE_NDJSON_MULTI_ASSISTANT)
        # Text from both assistant messages should be joined
        assert "Part one." in result.text
        assert "Part two." in result.text
        # Usage from result message overrides per-message usage
        assert result.usage.input_tokens == 60
        assert result.usage.output_tokens == 25
        assert result.num_turns == 2

    def test_parse_json_output_no_json_raises(self):
        with pytest.raises(ValueError, match="No JSON messages found"):
            parse_json_output("this is just plain text\nno JSON here")

    def test_parse_json_output_empty_string_raises(self):
        with pytest.raises(ValueError, match="No JSON messages found"):
            parse_json_output("")

    def test_parse_json_output_skips_invalid_lines(self):
        ndjson = (
            "not-json\n"
            '{"type":"system","session_id":"sess-skip"}\n'
            "{broken json}\n"
            '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
            '[{"type":"text","text":"Valid content"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n'
            '{"type":"result","session_id":"sess-skip","duration_ms":100,"num_turns":1,'
            '"usage":{"input_tokens":10,"output_tokens":5}}'
        )
        result = parse_json_output(ndjson)
        assert result.text == "Valid content"

    def test_parse_json_output_result_text_fallback(self):
        # result.result field is used when no assistant text blocks present
        ndjson = (
            '{"type":"system","session_id":"sess-res"}\n'
            '{"type":"result","session_id":"sess-res","duration_ms":500,"num_turns":1,'
            '"result":"Final answer text","usage":{"input_tokens":20,"output_tokens":10}}'
        )
        result = parse_json_output(ndjson)
        assert result.text == "Final answer text"

    def test_parse_json_output_system_message_sets_session_id(self):
        ndjson = (
            '{"type":"system","session_id":"initial-sess"}\n'
            '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
            '[{"type":"text","text":"Hi"}],"usage":{"input_tokens":5,"output_tokens":2}}}\n'
            '{"type":"result","duration_ms":100,"num_turns":1,"usage":{"input_tokens":5,"output_tokens":2}}'
        )
        result = parse_json_output(ndjson)
        # System message sets session_id when result doesn't have one
        assert result.session_id == "initial-sess"

    def test_parse_json_output_is_error_flag(self):
        ndjson = (
            '{"type":"system","session_id":"sess-err"}\n'
            '{"type":"result","session_id":"sess-err","duration_ms":100,"num_turns":0,'
            '"is_error":true,"usage":{"input_tokens":10,"output_tokens":0}}'
        )
        result = parse_json_output(ndjson)
        assert result.is_error is True

    def test_parse_json_output_cache_tokens(self):
        ndjson = (
            '{"type":"system","session_id":"sess-cache"}\n'
            '{"type":"result","session_id":"sess-cache","duration_ms":100,"num_turns":1,'
            '"usage":{"input_tokens":50,"output_tokens":20,'
            '"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}'
        )
        result = parse_json_output(ndjson)
        assert result.usage.cache_read_tokens == 1000
        assert result.usage.cache_write_tokens == 200

    def test_parse_json_output_unknown_content_block_ignored(self):
        ndjson = (
            '{"type":"system","session_id":"sess-unk"}\n'
            '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
            '[{"type":"unknown_future_block","data":"whatever"},'
            '{"type":"text","text":"Known text"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n'
            '{"type":"result","session_id":"sess-unk","duration_ms":100,"num_turns":1,'
            '"usage":{"input_tokens":10,"output_tokens":5}}'
        )
        result = parse_json_output(ndjson)
        # Unknown block is skipped; known text still parsed
        assert result.text == "Known text"


class TestParseTextOutput:
    def test_parse_text_output_wraps_text(self):
        result = parse_text_output("Hello from Claude")
        assert result.text == "Hello from Claude"
        assert result.usage.total_tokens == 0
        assert result.model == ""
        assert result.session_id == ""

    def test_parse_text_output_strips_whitespace(self):
        result = parse_text_output("   trimmed text   \n\n")
        assert result.text == "trimmed text"

    def test_parse_text_output_empty(self):
        result = parse_text_output("")
        assert result.text == ""


class TestParseOutput:
    def test_parse_output_tries_json_first(self):
        result = parse_output(SAMPLE_NDJSON)
        # Parsed structured JSON — has model and session info
        assert result.model == "claude-sonnet-4-6"
        assert result.session_id == "sess-123"
        assert result.text == "Hello world"

    def test_parse_output_falls_back_to_text(self):
        result = parse_output("plain text response with no JSON")
        assert result.text == "plain text response with no JSON"
        # No structured data — defaults
        assert result.model == ""
        assert result.usage.total_tokens == 0

    def test_parse_output_augments_with_stderr_usage(self):
        # JSON output with zero usage; stderr has usage data
        ndjson_no_usage = (
            '{"type":"system","session_id":"sess-se"}\n'
            '{"type":"assistant","message":{"model":"claude-sonnet-4-6","content":'
            '[{"type":"text","text":"Answer"}],"usage":{}}}\n'
            '{"type":"result","session_id":"sess-se","duration_ms":100,"num_turns":1,"usage":{}}'
        )
        stderr = '{"input_tokens":75,"output_tokens":30}'
        result = parse_output(ndjson_no_usage, stderr=stderr)
        assert result.usage.input_tokens == 75
        assert result.usage.output_tokens == 30

    def test_parse_output_plain_text_with_stderr_usage(self):
        stderr = '{"input_tokens":200,"output_tokens":100}'
        result = parse_output("Some plain text", stderr=stderr)
        assert result.text == "Some plain text"
        assert result.usage.input_tokens == 200
        assert result.usage.output_tokens == 100


class TestTryExtractUsageFromStderr:
    def test_try_extract_usage_from_stderr(self):
        stderr = '{"input_tokens":120,"output_tokens":60}'
        usage = _try_extract_usage_from_stderr(stderr)
        assert usage is not None
        assert usage.input_tokens == 120
        assert usage.output_tokens == 60

    def test_try_extract_usage_from_stderr_multiline(self):
        stderr = 'Some log line\n{"input_tokens":50,"output_tokens":25}\nAnother log'
        usage = _try_extract_usage_from_stderr(stderr)
        assert usage is not None
        assert usage.input_tokens == 50

    def test_try_extract_usage_from_stderr_no_usage_returns_none(self):
        stderr = "Error: something went wrong\nNo JSON here"
        usage = _try_extract_usage_from_stderr(stderr)
        assert usage is None

    def test_try_extract_usage_from_stderr_empty(self):
        usage = _try_extract_usage_from_stderr("")
        assert usage is None

    def test_try_extract_usage_from_stderr_json_without_input_tokens(self):
        # Valid JSON but missing input_tokens key — not a usage dict
        stderr = '{"model":"claude-sonnet-4-6","status":"ok"}'
        usage = _try_extract_usage_from_stderr(stderr)
        assert usage is None


# ═════════════════════════════════════════════════════════════════════════════
# 3. Roles — pure unit tests
# ═════════════════════════════════════════════════════════════════════════════


class TestRoles:
    def test_get_role_architect(self):
        role = get_role("architect")
        assert role.name == "architect"
        assert role.model == "opus"
        assert "Read" in role.tools
        assert role.thinking_budget == 10_000

    def test_get_role_implementer(self):
        role = get_role("implementer")
        assert role.name == "implementer"
        assert role.model == "sonnet"
        assert "Write" in role.tools
        assert "Edit" in role.tools
        assert role.thinking_budget == 0

    def test_get_role_sage(self):
        role = get_role("insight")
        assert role.name == "insight"
        assert role.model == "opus"
        assert role.thinking_budget == 20_000
        # Insight cannot execute — only read tools
        assert "Write" not in role.tools
        assert "Edit" not in role.tools

    def test_get_role_reviewer(self):
        role = get_role("reviewer")
        assert role.name == "reviewer"
        assert role.model == "opus"
        assert "Read" in role.tools
        assert role.thinking_budget == 5_000

    def test_get_role_debugger(self):
        role = get_role("debugger")
        assert role.name == "debugger"
        assert role.model == "sonnet"
        assert "Bash" in role.tools

    def test_get_role_invalid_raises_keyerror(self):
        with pytest.raises(KeyError):
            get_role("nonexistent_role")

    def test_role_has_max_turns(self):
        # All roles are Role dataclasses; max_turns defaults to None
        for name, role in ROLES.items():
            assert isinstance(role.max_turns, (int, type(None))), f"Role {name} has invalid max_turns type"

    def test_all_roles_have_system_prompt(self):
        for name, role in ROLES.items():
            assert role.system_prompt, f"Role {name} has empty system_prompt"

    def test_all_roles_have_description(self):
        for name, role in ROLES.items():
            assert role.description, f"Role {name} has empty description"

    def test_roles_registry_contains_expected_roles(self):
        expected = {"architect", "implementer", "reviewer", "debugger", "insight"}
        assert set(ROLES.keys()) == expected


# ═════════════════════════════════════════════════════════════════════════════
# 4. ClaudeAgent — mocked subprocess tests
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class _FakeStreamLine:
    source: str
    text: str
    parsed: dict[str, Any] | None = None


@dataclass
class _FakeRunResult:
    stdout: str
    stderr: str
    returncode: int = 0
    lines: list[_FakeStreamLine] = field(default_factory=list)


def _make_fake_result(text: str = "Mocked response", session_id: str = "sess-mock") -> _FakeRunResult:
    """Build a realistic fake subprocess result with NDJSON stdout."""
    ndjson = (
        f'{{"type":"system","session_id":"{session_id}"}}\n'
        f'{{"type":"assistant","message":{{"model":"claude-sonnet-4-6","content":'
        f'[{{"type":"text","text":"{text}"}}],'
        f'"usage":{{"input_tokens":100,"output_tokens":50}}}}}}\n'
        f'{{"type":"result","session_id":"{session_id}","duration_ms":1200,"num_turns":1,'
        f'"usage":{{"input_tokens":100,"output_tokens":50}}}}'
    )
    lines = [_FakeStreamLine(source="stdout", text=line) for line in ndjson.splitlines()]
    return _FakeRunResult(stdout=ndjson, stderr="", lines=lines)


@pytest.fixture
def fake_config():
    """Minimal ClaudeConfig-like object for testing."""
    cfg = MagicMock()
    cfg.cli_path = "/usr/local/bin/claude"
    cfg.opus_model = "claude-opus-4-6"
    cfg.sonnet_model = "claude-sonnet-4-6"
    cfg.haiku_model = "claude-haiku-4-5"
    cfg.default_model = "claude-sonnet-4-6"
    cfg.max_turns = 10
    return cfg


@pytest.fixture
def agent(fake_config):
    """ClaudeAgent with mocked CLI resolution and subprocess."""
    from openseed_claude.agent import ClaudeAgent

    with patch("openseed_claude.agent.require_claude_auth", return_value="/usr/local/bin/claude"):
        a = ClaudeAgent(config=fake_config)
        a._cli_path = "/usr/local/bin/claude"
    return a


class TestClaudeAgent:
    async def test_invoke_basic(self, agent):
        fake = _make_fake_result("Basic answer")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("What is 2+2?")
        assert response.text == "Basic answer"
        assert response.model == "claude-sonnet-4-6"

    async def test_invoke_with_role(self, agent):
        fake = _make_fake_result("Architecture plan")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Design this system", role="architect")
        # Architect role uses opus model; model in parsed response comes from NDJSON
        assert response.text == "Architecture plan"

    async def test_invoke_tracks_duration(self, agent):
        fake = _make_fake_result("Timed response")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Hello")
        # duration_ms should be a non-negative integer set by wall-clock timing
        assert isinstance(response.duration_ms, int)
        assert response.duration_ms >= 0

    async def test_invoke_parses_output(self, agent):
        fake = _make_fake_result("Parsed output text", session_id="sess-parsed")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Parse me")
        assert response.text == "Parsed output text"
        assert response.session_id == "sess-parsed"
        assert response.num_turns == 1

    async def test_invoke_calculates_cost(self, agent):
        fake = _make_fake_result("Cost test")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Compute cost")
        # Usage from NDJSON: 100 input, 50 output tokens on sonnet pricing
        assert response.usage.input_tokens == 100
        assert response.usage.output_tokens == 50
        assert response.cost.total_cost == pytest.approx((100 / 1_000_000) * 3.0 + (50 / 1_000_000) * 15.0)

    async def test_invoke_continue_session(self, agent):
        # First call — establishes session
        fake1 = _make_fake_result("First turn", session_id="sess-cont")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake1):
            await agent.invoke("First question")
        assert agent._last_session_id == "sess-cont"

        # Second call — continues session
        fake2 = _make_fake_result("Second turn", session_id="sess-cont")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake2) as mock_run:
            r2 = await agent.invoke("Follow-up", continue_session=True)

        # Verify --resume flag was included in the command
        call_args = mock_run.call_args
        cmd = call_args[0][0]
        assert "--resume" in cmd
        assert "sess-cont" in cmd
        assert r2.text == "Second turn"

    async def test_invoke_model_shorthand_opus(self, agent):
        fake = _make_fake_result("Opus response")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Deep question", model="opus")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "claude-opus-4-6" in cmd

    async def test_invoke_model_shorthand_haiku(self, agent):
        fake = _make_fake_result("Haiku response")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Quick question", model="haiku")
        cmd = mock_run.call_args[0][0]
        assert "--model" in cmd
        assert "claude-haiku-4-5" in cmd

    async def test_invoke_system_prompt_passed(self, agent):
        fake = _make_fake_result("System prompted")
        sys_prompt = "You are a pirate."
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Speak!", system_prompt=sys_prompt)
        cmd = mock_run.call_args[0][0]
        assert "--append-system-prompt" in cmd
        assert sys_prompt in cmd

    async def test_invoke_max_turns_passed(self, agent):
        fake = _make_fake_result("Max turns test")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Do it", max_turns=3)
        cmd = mock_run.call_args[0][0]
        assert "--max-turns" in cmd
        assert "3" in cmd

    async def test_invoke_invalid_role_falls_back_gracefully(self, agent):
        # Invalid role is caught internally (KeyError swallowed) — invoke continues
        fake = _make_fake_result("Fallback response")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Hello", role="nonexistent_role")
        assert response.text == "Fallback response"

    async def test_invoke_plain_text_fallback(self, agent):
        # When stdout is plain text (not NDJSON), parser falls back to text mode
        fake = _FakeRunResult(
            stdout="Plain text from claude",
            stderr="",
            lines=[_FakeStreamLine(source="stdout", text="Plain text from claude")],
        )
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            response = await agent.invoke("Simple prompt")
        # In plain text fallback, text comes from streaming on_line collector
        assert "Plain text from claude" in response.text
