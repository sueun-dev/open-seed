"""
Tests for MCP integration and structured output in Left Hand.

Covers:
  1. MCPConfig / MCPServer — add/remove/enable/disable, config dict, file I/O
  2. OutputSchema — prompt suffix generation
  3. validate_output — valid JSON, invalid JSON, missing required fields,
     type-checking against various schema types
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_claude.mcp import MCPConfig, MCPTransport
from openseed_claude.structured_output import (
    OutputSchema,
    _validate_against_schema,
    validate_output,
)

# ═════════════════════════════════════════════════════════════════════════════
# 1. MCPConfig — add servers
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPAddStdioServer:
    def test_mcp_add_stdio_server_registered(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python", args=["server.py"])
        assert "tools" in mcp.servers

    def test_mcp_add_stdio_server_transport(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python", args=["server.py"])
        assert mcp.servers["tools"].transport == MCPTransport.STDIO

    def test_mcp_add_stdio_server_fields(self):
        mcp = MCPConfig()
        mcp.add_stdio_server(
            "my-tools",
            command="node",
            args=["index.js", "--port", "3000"],
            env={"DEBUG": "1"},
        )
        server = mcp.servers["my-tools"]
        assert server.command == "node"
        assert server.args == ["index.js", "--port", "3000"]
        assert server.env == {"DEBUG": "1"}

    def test_mcp_add_stdio_server_defaults_empty_args_env(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("bare", command="my-bin")
        server = mcp.servers["bare"]
        assert server.args == []
        assert server.env == {}

    def test_mcp_add_stdio_server_enabled_by_default(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        assert mcp.servers["tools"].enabled is True


class TestMCPAddSseServer:
    def test_mcp_add_sse_server_registered(self):
        mcp = MCPConfig()
        mcp.add_sse_server("remote", url="http://localhost:3000/mcp")
        assert "remote" in mcp.servers

    def test_mcp_add_sse_server_transport(self):
        mcp = MCPConfig()
        mcp.add_sse_server("remote", url="http://localhost:3000/mcp")
        assert mcp.servers["remote"].transport == MCPTransport.SSE

    def test_mcp_add_sse_server_fields(self):
        mcp = MCPConfig()
        mcp.add_sse_server(
            "svc",
            url="https://api.example.com/mcp",
            headers={"Authorization": "Bearer token"},
        )
        server = mcp.servers["svc"]
        assert server.url == "https://api.example.com/mcp"
        assert server.headers == {"Authorization": "Bearer token"}

    def test_mcp_add_sse_server_defaults_empty_headers(self):
        mcp = MCPConfig()
        mcp.add_sse_server("svc", url="http://localhost/mcp")
        assert mcp.servers["svc"].headers == {}

    def test_mcp_add_http_server_transport(self):
        mcp = MCPConfig()
        mcp.add_http_server("api", url="http://localhost:8080/mcp")
        assert mcp.servers["api"].transport == MCPTransport.HTTP


# ═════════════════════════════════════════════════════════════════════════════
# 2. MCPConfig — remove server
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPRemoveServer:
    def test_mcp_remove_server_removes_it(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        mcp.remove_server("tools")
        assert "tools" not in mcp.servers

    def test_mcp_remove_server_noop_if_missing(self):
        mcp = MCPConfig()
        # Should not raise
        mcp.remove_server("nonexistent")

    def test_mcp_remove_server_only_removes_named(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("a", command="python")
        mcp.add_stdio_server("b", command="node")
        mcp.remove_server("a")
        assert "b" in mcp.servers
        assert "a" not in mcp.servers


# ═════════════════════════════════════════════════════════════════════════════
# 3. MCPConfig — enable / disable
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPEnableDisable:
    def test_mcp_disable_server(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        mcp.disable_server("tools")
        assert mcp.servers["tools"].enabled is False

    def test_mcp_enable_server(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        mcp.disable_server("tools")
        mcp.enable_server("tools")
        assert mcp.servers["tools"].enabled is True

    def test_mcp_disable_noop_if_missing(self):
        mcp = MCPConfig()
        mcp.disable_server("nonexistent")  # should not raise

    def test_mcp_enable_noop_if_missing(self):
        mcp = MCPConfig()
        mcp.enable_server("nonexistent")  # should not raise


# ═════════════════════════════════════════════════════════════════════════════
# 4. MCPConfig.to_config_dict
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPToConfigDict:
    def test_mcp_to_config_dict_stdio(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python", args=["srv.py"], env={"X": "1"})
        cfg = mcp.to_config_dict()
        assert "mcpServers" in cfg
        assert "tools" in cfg["mcpServers"]
        entry = cfg["mcpServers"]["tools"]
        assert entry["command"] == "python"
        assert entry["args"] == ["srv.py"]
        assert entry["env"] == {"X": "1"}

    def test_mcp_to_config_dict_sse(self):
        mcp = MCPConfig()
        mcp.add_sse_server("remote", url="http://localhost/mcp", headers={"H": "v"})
        cfg = mcp.to_config_dict()
        entry = cfg["mcpServers"]["remote"]
        assert entry["type"] == "sse"
        assert entry["url"] == "http://localhost/mcp"
        assert entry["headers"] == {"H": "v"}

    def test_mcp_to_config_dict_http(self):
        mcp = MCPConfig()
        mcp.add_http_server("api", url="http://localhost/mcp")
        cfg = mcp.to_config_dict()
        entry = cfg["mcpServers"]["api"]
        assert entry["type"] == "http"

    def test_mcp_to_config_dict_excludes_disabled(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("enabled", command="python")
        mcp.add_stdio_server("disabled", command="node")
        mcp.disable_server("disabled")
        cfg = mcp.to_config_dict()
        assert "enabled" in cfg["mcpServers"]
        assert "disabled" not in cfg["mcpServers"]

    def test_mcp_to_config_dict_empty(self):
        mcp = MCPConfig()
        cfg = mcp.to_config_dict()
        assert cfg == {"mcpServers": {}}


# ═════════════════════════════════════════════════════════════════════════════
# 5. MCPConfig.write_config_file
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPWriteConfigFile:
    def test_mcp_write_config_file_creates_file(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        path = mcp.write_config_file()
        try:
            assert os.path.isfile(path)
        finally:
            os.unlink(path)

    def test_mcp_write_config_file_valid_json(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python", args=["srv.py"])
        path = mcp.write_config_file()
        try:
            with open(path) as f:
                data = json.load(f)
            assert "mcpServers" in data
            assert "tools" in data["mcpServers"]
        finally:
            os.unlink(path)

    def test_mcp_write_config_file_custom_path(self, tmp_path):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        custom = str(tmp_path / "custom_mcp.json")
        returned = mcp.write_config_file(path=custom)
        assert returned == custom
        assert os.path.isfile(custom)

    def test_mcp_write_config_file_returns_path(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        path = mcp.write_config_file()
        try:
            assert isinstance(path, str)
            assert path.endswith(".json")
        finally:
            os.unlink(path)


# ═════════════════════════════════════════════════════════════════════════════
# 6. MCPConfig.has_servers
# ═════════════════════════════════════════════════════════════════════════════


class TestMCPHasServers:
    def test_mcp_has_servers_empty(self):
        mcp = MCPConfig()
        assert mcp.has_servers() is False

    def test_mcp_has_servers_with_enabled_server(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        assert mcp.has_servers() is True

    def test_mcp_has_servers_all_disabled(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        mcp.disable_server("tools")
        assert mcp.has_servers() is False

    def test_mcp_has_servers_mixed_enabled_disabled(self):
        mcp = MCPConfig()
        mcp.add_stdio_server("a", command="python")
        mcp.add_stdio_server("b", command="node")
        mcp.disable_server("a")
        assert mcp.has_servers() is True


# ═════════════════════════════════════════════════════════════════════════════
# 7. OutputSchema.to_prompt_suffix
# ═════════════════════════════════════════════════════════════════════════════


class TestOutputSchemaToPromptSuffix:
    def test_output_schema_to_prompt_suffix_contains_schema(self):
        schema = OutputSchema(
            schema={
                "type": "object",
                "required": ["status"],
                "properties": {"status": {"type": "string"}},
            }
        )
        suffix = schema.to_prompt_suffix()
        assert '"type": "object"' in suffix
        assert '"status"' in suffix

    def test_output_schema_to_prompt_suffix_contains_instruction(self):
        schema = OutputSchema(schema={"type": "object"})
        suffix = schema.to_prompt_suffix()
        assert "ONLY valid JSON" in suffix
        assert "No text before or after" in suffix

    def test_output_schema_to_prompt_suffix_starts_with_newlines(self):
        schema = OutputSchema(schema={"type": "object"})
        suffix = schema.to_prompt_suffix()
        assert suffix.startswith("\n\n")

    def test_output_schema_description_field(self):
        schema = OutputSchema(
            schema={"type": "string"},
            description="My output schema",
        )
        assert schema.description == "My output schema"


# ═════════════════════════════════════════════════════════════════════════════
# 8. validate_output — valid cases
# ═════════════════════════════════════════════════════════════════════════════


class TestValidateOutputValid:
    def test_validate_output_valid_object(self):
        schema = OutputSchema(
            schema={
                "type": "object",
                "required": ["status", "result"],
                "properties": {
                    "status": {"type": "string"},
                    "result": {"type": "string"},
                },
            }
        )
        text = '{"status": "ok", "result": "done"}'
        valid, data = validate_output(text, schema)
        assert valid is True
        assert data == {"status": "ok", "result": "done"}

    def test_validate_output_valid_with_surrounding_text(self):
        schema = OutputSchema(schema={"type": "object", "properties": {"x": {"type": "number"}}})
        text = 'Here is the answer:\n{"x": 42}\nThat is all.'
        valid, data = validate_output(text, schema)
        assert valid is True
        assert data["x"] == 42

    def test_validate_output_valid_array(self):
        schema = OutputSchema(
            schema={
                "type": "array",
                "items": {"type": "string"},
            }
        )
        text = '["a", "b", "c"]'
        valid, data = validate_output(text, schema)
        assert valid is True
        assert data == ["a", "b", "c"]

    def test_validate_output_no_type_constraint_passes(self):
        schema = OutputSchema(schema={})
        text = '{"anything": true}'
        valid, data = validate_output(text, schema)
        assert valid is True


# ═════════════════════════════════════════════════════════════════════════════
# 9. validate_output — invalid JSON
# ═════════════════════════════════════════════════════════════════════════════


class TestValidateOutputInvalidJson:
    def test_validate_output_plain_text_no_json(self):
        schema = OutputSchema(schema={"type": "object"})
        valid, data = validate_output("This is just plain text.", schema)
        assert valid is False
        assert data is None

    def test_validate_output_broken_json(self):
        schema = OutputSchema(schema={"type": "object"})
        valid, data = validate_output("{broken json here}", schema)
        assert valid is False
        assert data is None

    def test_validate_output_empty_string(self):
        schema = OutputSchema(schema={"type": "object"})
        valid, data = validate_output("", schema)
        assert valid is False
        assert data is None

    def test_validate_output_no_braces_no_brackets(self):
        schema = OutputSchema(schema={"type": "object"})
        valid, data = validate_output("just text without any json markers", schema)
        assert valid is False
        assert data is None


# ═════════════════════════════════════════════════════════════════════════════
# 10. validate_output — missing required fields
# ═════════════════════════════════════════════════════════════════════════════


class TestValidateOutputMissingRequired:
    def test_validate_output_missing_required_field(self):
        schema = OutputSchema(
            schema={
                "type": "object",
                "required": ["name", "age"],
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "integer"},
                },
            }
        )
        text = '{"name": "Alice"}'  # missing "age"
        valid, data = validate_output(text, schema)
        assert valid is False
        assert data == {"name": "Alice"}  # parsed but invalid

    def test_validate_output_all_required_present(self):
        schema = OutputSchema(
            schema={
                "type": "object",
                "required": ["name", "age"],
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": "integer"},
                },
            }
        )
        text = '{"name": "Alice", "age": 30}'
        valid, data = validate_output(text, schema)
        assert valid is True

    def test_validate_output_wrong_type_for_required_field(self):
        schema = OutputSchema(
            schema={
                "type": "object",
                "required": ["count"],
                "properties": {"count": {"type": "integer"}},
            }
        )
        text = '{"count": "not-an-int"}'
        valid, data = validate_output(text, schema)
        assert valid is False


# ═════════════════════════════════════════════════════════════════════════════
# 11. _validate_against_schema — type checks
# ═════════════════════════════════════════════════════════════════════════════


class TestValidateAgainstSchemaTypes:
    def test_string_type_valid(self):
        assert _validate_against_schema("hello", {"type": "string"}) is True

    def test_string_type_invalid(self):
        assert _validate_against_schema(42, {"type": "string"}) is False

    def test_number_type_valid_int(self):
        assert _validate_against_schema(5, {"type": "number"}) is True

    def test_number_type_valid_float(self):
        assert _validate_against_schema(3.14, {"type": "number"}) is True

    def test_number_type_invalid(self):
        assert _validate_against_schema("3.14", {"type": "number"}) is False

    def test_integer_type_valid(self):
        assert _validate_against_schema(7, {"type": "integer"}) is True

    def test_integer_type_rejects_float(self):
        assert _validate_against_schema(7.5, {"type": "integer"}) is False

    def test_integer_type_rejects_bool(self):
        # bool is a subclass of int in Python — schema should reject it
        assert _validate_against_schema(True, {"type": "integer"}) is False

    def test_boolean_type_valid(self):
        assert _validate_against_schema(True, {"type": "boolean"}) is True
        assert _validate_against_schema(False, {"type": "boolean"}) is True

    def test_boolean_type_invalid(self):
        assert _validate_against_schema(1, {"type": "boolean"}) is False

    def test_object_type_valid(self):
        assert _validate_against_schema({"key": "value"}, {"type": "object"}) is True

    def test_object_type_invalid(self):
        assert _validate_against_schema([1, 2], {"type": "object"}) is False

    def test_array_type_valid(self):
        assert _validate_against_schema([1, 2, 3], {"type": "array"}) is True

    def test_array_type_invalid(self):
        assert _validate_against_schema({"key": "val"}, {"type": "array"}) is False

    def test_array_items_schema_valid(self):
        assert _validate_against_schema([1, 2, 3], {"type": "array", "items": {"type": "integer"}}) is True

    def test_array_items_schema_invalid(self):
        assert _validate_against_schema([1, "two", 3], {"type": "array", "items": {"type": "integer"}}) is False

    def test_no_type_constraint(self):
        assert _validate_against_schema("anything", {}) is True
        assert _validate_against_schema(42, {}) is True
        assert _validate_against_schema(None, {}) is True

    def test_nested_object_valid(self):
        schema = {
            "type": "object",
            "properties": {
                "user": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {"id": {"type": "integer"}},
                }
            },
        }
        assert _validate_against_schema({"user": {"id": 1}}, schema) is True

    def test_nested_object_invalid(self):
        schema = {
            "type": "object",
            "properties": {
                "user": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {"id": {"type": "integer"}},
                }
            },
        }
        assert _validate_against_schema({"user": {"id": "not-int"}}, schema) is False


# ═════════════════════════════════════════════════════════════════════════════
# 12. ClaudeAgent — mcp_config integration (subprocess mocked)
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
    cfg = MagicMock()
    cfg.cli_path = "/usr/local/bin/claude"
    cfg.opus_model = "claude-opus-4-6"
    cfg.sonnet_model = "claude-sonnet-4-6"
    cfg.haiku_model = "claude-haiku-4-5"
    cfg.default_model = "claude-sonnet-4-6"
    cfg.max_turns = 10
    return cfg


class TestClaudeAgentMCPConfig:
    async def test_invoke_passes_mcp_config_flag(self, fake_config):
        from openseed_claude.agent import ClaudeAgent

        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python", args=["srv.py"])

        with patch("openseed_claude.agent.require_claude_auth", return_value="/usr/local/bin/claude"):
            agent = ClaudeAgent(config=fake_config, mcp_config=mcp)
            agent._cli_path = "/usr/local/bin/claude"

        fake = _make_fake_result("MCP response")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Use custom tool")

        cmd = mock_run.call_args[0][0]
        assert "--mcp-config" in cmd

    async def test_invoke_mcp_config_file_cleaned_up(self, fake_config):
        from openseed_claude.agent import ClaudeAgent

        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")

        written_paths: list[str] = []
        original_write = mcp.write_config_file

        def tracking_write(path=None):
            p = original_write(path)
            written_paths.append(p)
            return p

        with patch("openseed_claude.agent.require_claude_auth", return_value="/usr/local/bin/claude"):
            agent = ClaudeAgent(config=fake_config, mcp_config=mcp)
            agent._cli_path = "/usr/local/bin/claude"

        agent.mcp_config.write_config_file = tracking_write  # type: ignore[method-assign]

        fake = _make_fake_result("cleaned up")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake):
            await agent.invoke("Hello")

        # File should be deleted after invocation
        for p in written_paths:
            assert not os.path.exists(p), f"Temp MCP config file was not cleaned up: {p}"

    async def test_invoke_no_mcp_config_no_flag(self, fake_config):
        from openseed_claude.agent import ClaudeAgent

        with patch("openseed_claude.agent.require_claude_auth", return_value="/usr/local/bin/claude"):
            agent = ClaudeAgent(config=fake_config)
            agent._cli_path = "/usr/local/bin/claude"

        fake = _make_fake_result("no mcp")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Hello")

        cmd = mock_run.call_args[0][0]
        assert "--mcp-config" not in cmd

    async def test_invoke_disabled_mcp_server_no_flag(self, fake_config):
        from openseed_claude.agent import ClaudeAgent

        mcp = MCPConfig()
        mcp.add_stdio_server("tools", command="python")
        mcp.disable_server("tools")  # all servers disabled

        with patch("openseed_claude.agent.require_claude_auth", return_value="/usr/local/bin/claude"):
            agent = ClaudeAgent(config=fake_config, mcp_config=mcp)
            agent._cli_path = "/usr/local/bin/claude"

        fake = _make_fake_result("disabled mcp")
        with patch("openseed_claude.agent.run_streaming", new_callable=AsyncMock, return_value=fake) as mock_run:
            await agent.invoke("Hello")

        cmd = mock_run.call_args[0][0]
        assert "--mcp-config" not in cmd
