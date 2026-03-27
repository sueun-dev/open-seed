"""
Tests for wisdom accumulation module.

Covers:
  1. Wisdom dataclass
  2. _parse_wisdom — JSON parsing
  3. _heuristic_wisdom — fallback extraction
  4. _parse_stored_wisdom — round-trip storage/recall
  5. format_wisdom_for_prompt — prompt formatting
  6. store_wisdom / recall_wisdom integration
"""

from __future__ import annotations

import pytest

from openseed_memory.wisdom import (
    Wisdom,
    _parse_wisdom,
    _heuristic_wisdom,
    _parse_stored_wisdom,
    format_wisdom_for_prompt,
)


# ─── Wisdom dataclass ───────────────────────────────────────────────────────


class TestWisdom:
    def test_empty_wisdom(self):
        w = Wisdom()
        assert w.conventions == []
        assert w.successes == []
        assert w.failures == []
        assert w.gotchas == []
        assert w.commands == []

    def test_wisdom_with_data(self):
        w = Wisdom(
            conventions=["Use camelCase"],
            successes=["Express + Prisma worked well"],
            failures=["SQLite locking under concurrency"],
            gotchas=["CORS needs localhost wildcard"],
            commands=["npm run build"],
        )
        assert len(w.conventions) == 1
        assert "Express" in w.successes[0]


# ─── _parse_wisdom ──────────────────────────────────────────────────────────


class TestParseWisdom:
    def test_valid_json(self):
        raw = '{"conventions": ["Use TypeScript strict"], "successes": ["First try"], "failures": [], "gotchas": [], "commands": ["npm test"]}'
        w = _parse_wisdom(raw)
        assert w.conventions == ["Use TypeScript strict"]
        assert w.successes == ["First try"]
        assert w.commands == ["npm test"]
        assert w.failures == []

    def test_json_with_surrounding_text(self):
        raw = 'Here is the wisdom:\n{"conventions": ["PEP8"], "successes": [], "failures": ["forgot migrations"], "gotchas": [], "commands": []}\nDone.'
        w = _parse_wisdom(raw)
        assert w.conventions == ["PEP8"]
        assert w.failures == ["forgot migrations"]

    def test_invalid_json(self):
        w = _parse_wisdom("not json at all")
        assert w.conventions == []
        assert w.successes == []

    def test_empty_string(self):
        w = _parse_wisdom("")
        assert w == Wisdom()

    def test_partial_fields(self):
        raw = '{"conventions": ["test"], "successes": ["yes"]}'
        w = _parse_wisdom(raw)
        assert w.conventions == ["test"]
        assert w.successes == ["yes"]
        assert w.failures == []
        assert w.gotchas == []
        assert w.commands == []

    def test_non_list_values_handled(self):
        raw = '{"conventions": "not a list", "successes": 42}'
        w = _parse_wisdom(raw)
        assert w.conventions == []
        assert w.successes == []


# ─── _heuristic_wisdom ──────────────────────────────────────────────────────


class TestHeuristicWisdom:
    def test_first_attempt_success(self):
        w = _heuristic_wisdom("Build API", retry_count=0, errors=[])
        assert len(w.successes) == 1
        assert "first attempt" in w.successes[0].lower()

    def test_many_retries(self):
        w = _heuristic_wisdom("Fix bug", retry_count=5, errors=[])
        assert len(w.failures) == 1
        assert "5 retries" in w.failures[0]

    def test_with_errors(self):
        w = _heuristic_wisdom("Deploy", retry_count=1, errors=["TypeError", "ImportError"])
        assert len(w.gotchas) == 2
        assert "TypeError" in w.gotchas[0]

    def test_errors_capped_at_3(self):
        w = _heuristic_wisdom("Task", retry_count=1, errors=["e1", "e2", "e3", "e4", "e5"])
        assert len(w.gotchas) == 3


# ─── _parse_stored_wisdom ───────────────────────────────────────────────────


class TestParseStoredWisdom:
    def test_round_trip(self):
        """Wisdom stored as text should be parseable back."""
        content = (
            "Wisdom from: Build API\n"
            "Conventions: Use TypeScript strict; Always add index.ts\n"
            "Successes: Express + Prisma combo worked\n"
            "Failures: SQLite locking; Forgot CORS\n"
            "Gotchas: Dev server port changes\n"
            "Commands: npm run build; npm test"
        )
        w = _parse_stored_wisdom(content)
        assert w.conventions == ["Use TypeScript strict", "Always add index.ts"]
        assert w.successes == ["Express + Prisma combo worked"]
        assert w.failures == ["SQLite locking", "Forgot CORS"]
        assert w.gotchas == ["Dev server port changes"]
        assert w.commands == ["npm run build", "npm test"]

    def test_partial_content(self):
        content = "Wisdom from: Fix\nSuccesses: It worked"
        w = _parse_stored_wisdom(content)
        assert w.successes == ["It worked"]
        assert w.conventions == []

    def test_empty_content(self):
        w = _parse_stored_wisdom("")
        assert w == Wisdom()


# ─── format_wisdom_for_prompt ───────────────────────────────────────────────


class TestFormatWisdomForPrompt:
    def test_empty_list(self):
        assert format_wisdom_for_prompt([]) == ""

    def test_empty_wisdom(self):
        assert format_wisdom_for_prompt([Wisdom()]) == ""

    def test_single_wisdom(self):
        w = Wisdom(
            conventions=["Use strict TypeScript"],
            failures=["Don't use SQLite for concurrent writes"],
        )
        result = format_wisdom_for_prompt([w])
        assert "Conventions from past runs:" in result
        assert "Use strict TypeScript" in result
        assert "What to AVOID" in result
        assert "SQLite" in result

    def test_multiple_wisdoms_deduplication(self):
        w1 = Wisdom(successes=["Express worked", "Prisma worked"])
        w2 = Wisdom(successes=["Express worked", "React worked"])
        result = format_wisdom_for_prompt([w1, w2])
        # "Express worked" should appear only once
        assert result.count("Express worked") == 1
        assert "Prisma worked" in result
        assert "React worked" in result

    def test_all_categories(self):
        w = Wisdom(
            conventions=["c1"],
            successes=["s1"],
            failures=["f1"],
            gotchas=["g1"],
            commands=["cmd1"],
        )
        result = format_wisdom_for_prompt([w])
        assert "Conventions" in result
        assert "What worked" in result
        assert "AVOID" in result
        assert "Watch out" in result
        assert "Useful commands" in result
