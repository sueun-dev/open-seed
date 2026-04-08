"""
Tests for browser-based UI verification — OpenHands pattern.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_guard.browser_verify import BrowserEvidence, _ai_analyze_ui


class TestBrowserEvidence:
    def test_defaults(self) -> None:
        e = BrowserEvidence(passed=True)
        assert e.passed
        assert e.url == ""
        assert e.screenshot_b64 == ""

    def test_failed_evidence(self) -> None:
        e = BrowserEvidence(passed=False, error="Page crashed")
        assert not e.passed
        assert "crashed" in e.error


class TestAIAnalyzeUI:
    @pytest.mark.asyncio
    async def test_ai_pass(self) -> None:
        mock_response = MagicMock()
        mock_response.text = "PASS: The page renders a functional todo app"

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await _ai_analyze_ui(
                screenshot_b64="base64data",
                page_text="Todo App - Add your tasks",
                title="Todo App",
                url="http://localhost:3000",
            )

        assert "PASS" in result

    @pytest.mark.asyncio
    async def test_ai_fail(self) -> None:
        mock_response = MagicMock()
        mock_response.text = "FAIL: The page shows a blank white screen with no content"

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await _ai_analyze_ui(
                screenshot_b64="base64data",
                page_text="",
                title="",
                url="http://localhost:3000",
            )

        assert "FAIL" in result

    @pytest.mark.asyncio
    async def test_ai_unavailable_returns_pass(self) -> None:
        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(side_effect=Exception("LLM down"))
            result = await _ai_analyze_ui(
                screenshot_b64="data",
                page_text="content",
                title="App",
                url="http://localhost:3000",
            )

        assert "PASS" in result  # Don't block pipeline
