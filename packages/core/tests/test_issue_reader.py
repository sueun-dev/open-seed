"""
Tests for GitHub/GitLab issue reader — OpenHands pattern.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from openseed_core.issue_reader import IssueContext, read_github_issue


class TestIssueContext:
    def test_to_task_basic(self) -> None:
        ctx = IssueContext(
            number=42,
            title="Button doesn't work",
            body="The submit button is broken on the login page.",
            labels=["bug", "frontend"],
            repo="owner/repo",
        )
        task = ctx.to_task()
        assert "Fix GitHub issue #42" in task
        assert "Button doesn't work" in task
        assert "submit button is broken" in task
        assert "bug, frontend" in task

    def test_to_task_with_comments(self) -> None:
        ctx = IssueContext(
            number=1,
            title="Add dark mode",
            body="Please add dark mode support.",
            comments=["I tried CSS variables but it broke", "Use prefers-color-scheme"],
        )
        task = ctx.to_task()
        assert "comments" in task.lower()
        assert "CSS variables" in task

    def test_to_task_minimal(self) -> None:
        ctx = IssueContext(number=1, title="Fix bug", body="")
        task = ctx.to_task()
        assert "Fix GitHub issue #1: Fix bug" in task


class TestReadGithubIssue:
    @pytest.mark.asyncio
    async def test_successful_read(self) -> None:
        gh_response = json.dumps({
            "title": "Login page crashes",
            "body": "Steps to reproduce: click login button",
            "labels": [{"name": "bug"}, {"name": "critical"}],
            "comments": [{"body": "Same issue here"}],
            "author": {"login": "user123"},
            "url": "https://github.com/owner/repo/issues/42",
        })

        mock_version = AsyncMock()
        mock_version.return_value.exit_code = 0

        mock_issue = AsyncMock()
        mock_issue.return_value.exit_code = 0
        mock_issue.return_value.stdout = gh_response

        with patch("openseed_core.issue_reader.run_simple") as mock_run:
            mock_run.side_effect = [
                # gh --version
                type("R", (), {"exit_code": 0, "stdout": "gh version 2.0", "stderr": ""})(),
                # gh issue view
                type("R", (), {"exit_code": 0, "stdout": gh_response, "stderr": ""})(),
            ]
            result = await read_github_issue("owner/repo", 42)

        assert result.number == 42
        assert result.title == "Login page crashes"
        assert "bug" in result.labels
        assert "critical" in result.labels
        assert len(result.comments) == 1
        assert result.author == "user123"

    @pytest.mark.asyncio
    async def test_gh_not_installed(self) -> None:
        with patch("openseed_core.issue_reader.run_simple") as mock_run:
            mock_run.return_value = type("R", (), {"exit_code": 1, "stdout": "", "stderr": "not found"})()
            with pytest.raises(RuntimeError, match="gh CLI not installed"):
                await read_github_issue("owner/repo", 1)

    @pytest.mark.asyncio
    async def test_issue_not_found(self) -> None:
        with patch("openseed_core.issue_reader.run_simple") as mock_run:
            mock_run.side_effect = [
                type("R", (), {"exit_code": 0, "stdout": "gh version", "stderr": ""})(),
                type("R", (), {"exit_code": 1, "stdout": "", "stderr": "not found"})(),
            ]
            with pytest.raises(RuntimeError, match="Failed to read issue"):
                await read_github_issue("owner/repo", 999)
