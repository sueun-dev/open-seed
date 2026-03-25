"""
Claude OAuth — verify Claude CLI is installed and authenticated.

We spawn `claude` as a subprocess. Just need to verify it exists
and has valid OAuth. The CLI handles all auth internally.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from openseed_core.errors import AuthError


@dataclass
class ClaudeAuthStatus:
    installed: bool
    cli_path: str
    authenticated: bool
    account: str
    error: str | None = None


def get_claude_cli_path() -> str | None:
    """
    Find the Claude CLI binary.
    Search order:
    1. PATH (shutil.which)
    2. Common npm global paths
    3. Common homebrew paths
    """
    # 1. PATH
    path = shutil.which("claude")
    if path:
        return path

    # 2. Common locations
    import os
    candidates = [
        os.path.expanduser("~/.npm/bin/claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    return None


def check_claude_auth(cli_path: str | None = None) -> ClaudeAuthStatus:
    """Check if Claude CLI is installed and authenticated."""
    path = cli_path or get_claude_cli_path()

    if not path:
        return ClaudeAuthStatus(
            installed=False,
            cli_path="",
            authenticated=False,
            account="",
            error="Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code",
        )

    try:
        result = subprocess.run(
            [path, "auth", "status"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = (result.stdout + result.stderr).strip()
        authenticated = result.returncode == 0
        return ClaudeAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=authenticated,
            account=output[:200] if authenticated else "",
            error=None if authenticated else f"Not authenticated: {output[:200]}",
        )
    except subprocess.TimeoutExpired:
        return ClaudeAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=False,
            account="",
            error="Claude auth check timed out",
        )
    except Exception as e:
        return ClaudeAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=False,
            account="",
            error=str(e),
        )


def require_claude_auth(cli_path: str | None = None) -> str:
    """Verify Claude auth or raise AuthError. Returns CLI path."""
    status = check_claude_auth(cli_path)
    if not status.installed:
        raise AuthError("Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code")
    if not status.authenticated:
        raise AuthError(f"Claude not authenticated. Run: {status.cli_path} auth login")
    return status.cli_path
