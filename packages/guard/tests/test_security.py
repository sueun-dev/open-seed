"""
Tests for security pre-validation — OpenHands pattern integration.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_guard.security import (
    SecurityRisk,
    _parse_security_response,
    assess_risk,
)


class TestParseSecurityResponse:
    def test_parse_valid_json_low(self) -> None:
        text = '{"risk": "low", "reason": "Only creates source files", "flagged_items": []}'
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.LOW
        assert not result.requires_approval

    def test_parse_valid_json_high(self) -> None:
        text = '{"risk": "high", "reason": "Modifies .env file", "flagged_items": [".env"]}'
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.HIGH
        assert result.requires_approval
        assert ".env" in result.flagged_items

    def test_parse_valid_json_medium(self) -> None:
        text = '{"risk": "medium", "reason": "Large refactor", "flagged_items": []}'
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.MEDIUM
        assert not result.requires_approval

    def test_parse_json_with_surrounding_text(self) -> None:
        text = 'Here is my assessment:\n{"risk": "high", "reason": "rm -rf detected"}\nDone!'
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.HIGH

    def test_parse_invalid_json_fallback_high(self) -> None:
        text = "This is HIGH risk because it deletes system files"
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.HIGH

    def test_parse_invalid_json_fallback_low(self) -> None:
        text = "Everything looks safe, just creating some files"
        result = _parse_security_response(text)
        assert result.risk == SecurityRisk.LOW


class TestAssessRisk:
    @pytest.mark.asyncio
    async def test_empty_plan_returns_low(self) -> None:
        result = await assess_risk("", [], "/tmp")
        assert result.risk == SecurityRisk.LOW

    @pytest.mark.asyncio
    async def test_assess_via_llm(self) -> None:
        mock_response = MagicMock()
        mock_response.text = '{"risk": "medium", "reason": "config changes", "flagged_items": ["config.yaml"]}'

        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await assess_risk(
                "Modify application config",
                ["config.yaml"],
                "/tmp/project",
                task="Update settings",
            )

        assert result.risk == SecurityRisk.MEDIUM

    @pytest.mark.asyncio
    async def test_llm_failure_returns_low(self) -> None:
        """If security check fails, default to LOW (don't block)."""
        with patch("openseed_claude.agent.ClaudeAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(side_effect=Exception("LLM down"))
            result = await assess_risk("Do something", ["file.py"], "/tmp")

        assert result.risk == SecurityRisk.LOW
