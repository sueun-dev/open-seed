"""Open Seed v2 — Left Hand (Claude Agent)."""

from openseed_claude.agent import ClaudeAgent, ClaudeResponse
from openseed_claude.hooks import (
    HookCallback,
    HookContext,
    HookEvent,
    HookRegistry,
    HookResult,
)
from openseed_claude.mcp import MCPConfig, MCPServer, MCPTransport
from openseed_claude.messages import (
    CostEstimate,
    StructuredResponse,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UsageStats,
    estimate_cost,
)
from openseed_claude.roles import Role, ROLES, get_role
from openseed_claude.structured_output import OutputSchema, validate_output

__all__ = [
    # Agent
    "ClaudeAgent",
    "ClaudeResponse",
    # Hooks
    "HookCallback",
    "HookContext",
    "HookEvent",
    "HookRegistry",
    "HookResult",
    # MCP
    "MCPConfig",
    "MCPServer",
    "MCPTransport",
    # Roles
    "Role",
    "ROLES",
    "get_role",
    # Message / content block types
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
    "StructuredResponse",
    # Usage & cost
    "UsageStats",
    "CostEstimate",
    "estimate_cost",
    # Structured output
    "OutputSchema",
    "validate_output",
]
