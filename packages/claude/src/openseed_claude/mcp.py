"""
MCP (Model Context Protocol) integration for Claude Agent.
Pattern from: claude-code-sdk McpServerConfig types.

MCP lets you add custom tools to Claude via external servers.
Supported transport types:
- stdio: Run a local command that speaks MCP over stdin/stdout
- sse: Connect to an HTTP SSE endpoint
- http: Connect to an HTTP endpoint

Usage:
    mcp = MCPConfig()
    mcp.add_stdio_server("my-tools", command="python", args=["my_mcp_server.py"])
    mcp.add_sse_server("remote-tools", url="http://localhost:3000/mcp")

    agent = ClaudeAgent(mcp_config=mcp)
    response = await agent.invoke("Use my custom tool to...")
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class MCPTransport(StrEnum):
    STDIO = "stdio"
    SSE = "sse"
    HTTP = "http"


@dataclass
class MCPServer:
    """Configuration for a single MCP server."""

    name: str
    transport: MCPTransport
    # stdio
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    # sse/http
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    # common
    enabled: bool = True
    timeout_seconds: int = 30


@dataclass
class MCPConfig:
    """MCP configuration — manages multiple MCP servers."""

    servers: dict[str, MCPServer] = field(default_factory=dict)

    def add_stdio_server(
        self,
        name: str,
        command: str,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        """Register a stdio MCP server (local subprocess)."""
        self.servers[name] = MCPServer(
            name=name,
            transport=MCPTransport.STDIO,
            command=command,
            args=args or [],
            env=env or {},
        )

    def add_sse_server(
        self,
        name: str,
        url: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Register an SSE MCP server (HTTP Server-Sent Events)."""
        self.servers[name] = MCPServer(
            name=name,
            transport=MCPTransport.SSE,
            url=url,
            headers=headers or {},
        )

    def add_http_server(
        self,
        name: str,
        url: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Register an HTTP MCP server."""
        self.servers[name] = MCPServer(
            name=name,
            transport=MCPTransport.HTTP,
            url=url,
            headers=headers or {},
        )

    def remove_server(self, name: str) -> None:
        """Remove a server by name (no-op if not found)."""
        self.servers.pop(name, None)

    def enable_server(self, name: str) -> None:
        """Enable a previously disabled server."""
        if name in self.servers:
            self.servers[name].enabled = True

    def disable_server(self, name: str) -> None:
        """Disable a server without removing it."""
        if name in self.servers:
            self.servers[name].enabled = False

    def to_config_dict(self) -> dict[str, Any]:
        """Convert to the JSON format expected by Claude CLI --mcp-config."""
        config: dict[str, Any] = {"mcpServers": {}}
        for name, server in self.servers.items():
            if not server.enabled:
                continue
            if server.transport == MCPTransport.STDIO:
                config["mcpServers"][name] = {
                    "command": server.command,
                    "args": server.args,
                    "env": server.env,
                }
            elif server.transport in (MCPTransport.SSE, MCPTransport.HTTP):
                config["mcpServers"][name] = {
                    "type": server.transport.value,
                    "url": server.url,
                    "headers": server.headers,
                }
        return config

    def write_config_file(self, path: str | None = None) -> str:
        """Write MCP config to a JSON file. Returns the file path.

        If path is None, a temporary file is created. The caller is responsible
        for deleting the file when it is no longer needed.
        """
        if path is None:
            fd, path = tempfile.mkstemp(suffix=".json", prefix="openseed_mcp_")
            os.close(fd)
        with open(path, "w") as f:
            json.dump(self.to_config_dict(), f)
        return path

    def has_servers(self) -> bool:
        """Return True if at least one enabled server is registered."""
        return any(s.enabled for s in self.servers.values())
