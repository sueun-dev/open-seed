from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING
from unittest.mock import patch

from openseed_core.auth.claude import get_claude_cli_path

if TYPE_CHECKING:
    from pathlib import Path


class TestGetClaudeCliPath:
    def test_returns_path_binary_when_available(self) -> None:
        with patch("openseed_core.auth.claude.shutil.which", return_value="/usr/local/bin/claude"):
            assert get_claude_cli_path() == "/usr/local/bin/claude"

    def test_finds_binary_in_custom_npm_global_prefix(self, tmp_path: Path) -> None:
        prefix = tmp_path / "npm-global"
        bin_dir = prefix / "bin"
        cli_path = bin_dir / "claude"
        bin_dir.mkdir(parents=True)
        cli_path.write_text("#!/bin/sh\n")
        cli_path.chmod(0o755)

        def fake_which(name: str) -> str | None:
            if name == "claude":
                return None
            if name == "npm":
                return "/usr/bin/npm"
            return None

        npm_result = subprocess.CompletedProcess(
            args=["npm", "config", "get", "prefix"],
            returncode=0,
            stdout=f"{prefix}\n",
            stderr="",
        )

        with (
            patch("openseed_core.auth.claude.shutil.which", side_effect=fake_which),
            patch("openseed_core.auth.claude.subprocess.run", return_value=npm_result),
            patch.dict(os.environ, {"NPM_CONFIG_PREFIX": "", "npm_config_prefix": ""}, clear=False),
        ):
            assert get_claude_cli_path() == str(cli_path)

    def test_finds_binary_from_npm_prefix_environment(self, tmp_path: Path) -> None:
        prefix = tmp_path / "npm-global"
        bin_dir = prefix / "bin"
        cli_path = bin_dir / "claude"
        bin_dir.mkdir(parents=True)
        cli_path.write_text("#!/bin/sh\n")
        cli_path.chmod(0o755)

        with (
            patch("openseed_core.auth.claude.shutil.which", return_value=None),
            patch.dict(os.environ, {"NPM_CONFIG_PREFIX": str(prefix)}, clear=False),
        ):
            assert get_claude_cli_path() == str(cli_path)
