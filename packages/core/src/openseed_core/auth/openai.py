"""
OpenAI OAuth — verify Codex CLI is installed and authenticated.

Pattern from: codex-rs/rmcp-client/src/oauth.rs
Codex stores OAuth tokens in OS keychain (service: "Codex MCP Credentials")
or fallback ~/.codex/auth.json. We verify via `codex auth status`.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

from openseed_core.errors import AuthError


@dataclass
class OpenAIAuthStatus:
    installed: bool
    cli_path: str
    authenticated: bool
    account: str
    error: str | None = None


def get_codex_cli_path() -> str | None:
    """Find the Codex CLI binary."""
    path = shutil.which("codex")
    if path:
        return path

    import os

    candidates = [
        os.path.expanduser("~/.npm/bin/codex"),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
    ]
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    return None


def check_openai_auth(cli_path: str | None = None) -> OpenAIAuthStatus:
    """Check if Codex CLI is installed and authenticated."""
    path = cli_path or get_codex_cli_path()

    if not path:
        return OpenAIAuthStatus(
            installed=False,
            cli_path="",
            authenticated=False,
            account="",
            error="Codex CLI not found. Install: npm install -g @openai/codex",
        )

    try:
        result = subprocess.run(
            [path, "login", "status"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = (result.stdout + result.stderr).strip()
        authenticated = result.returncode == 0
        return OpenAIAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=authenticated,
            account=output[:200] if authenticated else "",
            error=None if authenticated else f"Not authenticated: {output[:200]}",
        )
    except subprocess.TimeoutExpired:
        return OpenAIAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=False,
            account="",
            error="Codex auth check timed out",
        )
    except Exception as e:
        return OpenAIAuthStatus(
            installed=True,
            cli_path=path,
            authenticated=False,
            account="",
            error=str(e),
        )


def require_openai_auth(cli_path: str | None = None) -> str:
    """Verify OpenAI auth or raise AuthError. Returns CLI path."""
    status = check_openai_auth(cli_path)
    if not status.installed:
        raise AuthError("Codex CLI not installed. Run: npm install -g @openai/codex")
    if not status.authenticated:
        raise AuthError(f"Codex not authenticated. Run: {status.cli_path} login")
    return status.cli_path
