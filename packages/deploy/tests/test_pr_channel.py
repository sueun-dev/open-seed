"""
Tests for PR deploy channel — OpenHands pattern.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from openseed_deploy.channels.pr import PRChannel, _build_pr_body


class TestPRChannel:
    def test_name(self) -> None:
        ch = PRChannel()
        assert ch.name == "pr"

    @pytest.mark.asyncio
    async def test_check_gh_available(self) -> None:
        with patch("openseed_deploy.channels.pr.run_simple") as mock_run:
            mock_run.return_value = type("R", (), {"exit_code": 0, "stdout": "", "stderr": ""})()
            assert await PRChannel().check() is True

    @pytest.mark.asyncio
    async def test_check_gh_not_available(self) -> None:
        with patch("openseed_deploy.channels.pr.run_simple") as mock_run:
            mock_run.return_value = type("R", (), {"exit_code": 1, "stdout": "", "stderr": ""})()
            assert await PRChannel().check() is False

    @pytest.mark.asyncio
    async def test_deploy_not_git_repo(self, tmp_path) -> None:
        result = await PRChannel().deploy(str(tmp_path))
        assert not result.success
        assert "Not a git" in result.message


class TestBuildPRBody:
    def test_with_issue_number(self) -> None:
        body = _build_pr_body(42, "Fix the login bug")
        assert "Closes #42" in body
        assert "Fix the login bug" in body
        assert "Open Seed" in body

    def test_without_issue_number(self) -> None:
        body = _build_pr_body(None, "General fix")
        assert "Closes" not in body
        assert "General fix" in body
