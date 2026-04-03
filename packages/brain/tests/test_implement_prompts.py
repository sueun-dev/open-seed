"""
Tests for implement node prompt-building functions.

Covers:
  1. _build_action_instruction — intent/existing_project branching
  2. _build_intake_context — requirements/approach/lessons assembly
  3. _build_rules — context-aware rule filtering (core/web/fix)
  4. _resolve_max_turns — dynamic turn limits by complexity/intent
"""

from __future__ import annotations

from openseed_brain.nodes.implement import (
    _build_action_instruction,
    _build_intake_context,
    _build_rules,
    _resolve_max_turns,
)

# ─── _build_action_instruction ──────────────────────────────────────────────


class TestBuildActionInstruction:
    def test_fix_intent(self):
        result = _build_action_instruction({"intent": "fix"})
        assert "Fix this issue" in result
        assert "minimal" in result.lower()

    def test_research_intent(self):
        result = _build_action_instruction({"intent": "research"})
        assert "Investigate" in result

    def test_investigation_intent(self):
        result = _build_action_instruction({"intent": "investigation"})
        assert "Investigate" in result

    def test_evaluation_intent(self):
        result = _build_action_instruction({"intent": "evaluation"})
        assert "Evaluate" in result

    def test_existing_project_implementation(self):
        result = _build_action_instruction(
            {
                "intent": "implementation",
                "existing_project": "yes",
            }
        )
        assert "existing project" in result.lower()
        assert "Read" in result

    def test_new_project_implementation(self):
        result = _build_action_instruction(
            {
                "intent": "implementation",
                "existing_project": "no",
            }
        )
        assert "from scratch" in result.lower()
        assert "ALL files" in result

    def test_open_ended_new_project(self):
        result = _build_action_instruction({"intent": "open_ended"})
        assert "from scratch" in result.lower()

    def test_empty_intake_defaults_to_new_project(self):
        result = _build_action_instruction({})
        assert "from scratch" in result.lower()

    def test_fix_ignores_existing_project_flag(self):
        """Fix intent should always return fix instruction, regardless of existing_project."""
        result = _build_action_instruction(
            {
                "intent": "fix",
                "existing_project": "no",
            }
        )
        assert "Fix this issue" in result


# ─── _build_intake_context ──────────────────────────────────────────────────


class TestBuildIntakeContext:
    def test_requirements_only(self):
        result = _build_intake_context(
            {
                "requirements": ["Add login page", "Use OAuth"],
            }
        )
        assert "Requirements:" in result
        assert "- Add login page" in result
        assert "- Use OAuth" in result

    def test_approach_only(self):
        result = _build_intake_context(
            {
                "approach": "Modify auth.ts to add the endpoint",
            }
        )
        assert "Approach: Modify auth.ts" in result

    def test_lessons_only(self):
        result = _build_intake_context(
            {
                "lessons": "Similar bug last week — null guard missing",
            }
        )
        assert "Lessons from past" in result
        assert "null guard" in result

    def test_lessons_none_excluded(self):
        result = _build_intake_context({"lessons": "none"})
        assert result == ""

    def test_lessons_None_case_insensitive(self):
        result = _build_intake_context({"lessons": "None"})
        assert result == ""

    def test_all_fields(self):
        result = _build_intake_context(
            {
                "requirements": ["Fix bug"],
                "approach": "Check null guard",
                "lessons": "Happened before in auth module",
            }
        )
        assert "Requirements:" in result
        assert "Approach:" in result
        assert "Lessons from past" in result

    def test_empty_intake(self):
        result = _build_intake_context({})
        assert result == ""

    def test_empty_requirements_list(self):
        result = _build_intake_context({"requirements": []})
        assert "Requirements:" not in result

    def test_empty_approach_string(self):
        result = _build_intake_context({"approach": ""})
        assert "Approach:" not in result


# ─── _build_rules ───────────────────────────────────────────────────────────


class TestBuildRules:
    def test_always_includes_core_rules(self):
        result = _build_rules({})
        assert "Rules:" in result
        assert "COMPLETE and RUNNABLE" in result

    def test_fix_includes_fix_rules(self):
        result = _build_rules({"intent": "fix"})
        assert "MINIMAL, targeted" in result
        assert "Read the affected files" in result

    def test_non_fix_excludes_fix_rules(self):
        result = _build_rules({"intent": "implementation"})
        assert "MINIMAL, targeted" not in result

    def test_web_tech_includes_web_rules(self):
        result = _build_rules({"tech_stack": "React, Express, TypeScript"})
        assert "CORS" in result
        assert "package.json" in result

    def test_non_web_tech_excludes_web_rules(self):
        """CLI tools / data pipelines should NOT get web rules."""
        result = _build_rules({"tech_stack": "Python, Click, SQLAlchemy"})
        assert "CORS" not in result
        assert "REST updates" not in result

    def test_unknown_tech_includes_web_rules_as_default(self):
        """When tech stack is unknown, include web rules as safe default."""
        result = _build_rules({})
        assert "CORS" in result

    def test_fix_with_web_tech_includes_both(self):
        result = _build_rules({"intent": "fix", "tech_stack": "React, Vite"})
        assert "MINIMAL, targeted" in result
        assert "CORS" in result

    def test_fix_with_non_web_tech(self):
        result = _build_rules({"intent": "fix", "tech_stack": "Python, Click"})
        assert "MINIMAL, targeted" in result
        assert "CORS" not in result

    def test_case_insensitive_tech_matching(self):
        result = _build_rules({"tech_stack": "REACT, EXPRESS"})
        assert "CORS" in result

    def test_single_web_tech(self):
        result = _build_rules({"tech_stack": "Django"})
        assert "CORS" in result

    def test_mixed_web_and_non_web(self):
        result = _build_rules({"tech_stack": "Python, FastAPI, Redis"})
        assert "CORS" in result  # FastAPI is web


# ─── _resolve_max_turns ─────────────────────────────────────────────────────


class TestResolveMaxTurns:
    # skip_planning path (no plan)
    def test_simple_no_plan(self):
        assert _resolve_max_turns({"complexity": "simple"}, has_plan=False) == 10

    def test_moderate_no_plan(self):
        assert _resolve_max_turns({"complexity": "moderate"}, has_plan=False) == 20

    def test_complex_no_plan(self):
        assert _resolve_max_turns({"complexity": "complex"}, has_plan=False) == 30

    # with plan path
    def test_simple_with_plan(self):
        assert _resolve_max_turns({"complexity": "simple"}, has_plan=True) == 12

    def test_moderate_with_plan(self):
        assert _resolve_max_turns({"complexity": "moderate"}, has_plan=True) == 20

    def test_complex_with_plan(self):
        assert _resolve_max_turns({"complexity": "complex"}, has_plan=True) == 25

    # research/investigation/evaluation always 8
    def test_research_ignores_complexity(self):
        assert _resolve_max_turns({"intent": "research", "complexity": "complex"}, has_plan=False) == 8

    def test_investigation(self):
        assert _resolve_max_turns({"intent": "investigation"}, has_plan=False) == 8

    def test_evaluation(self):
        assert _resolve_max_turns({"intent": "evaluation"}, has_plan=True) == 8

    # defaults
    def test_empty_intake_defaults_moderate(self):
        assert _resolve_max_turns({}, has_plan=False) == 20

    def test_unknown_complexity_defaults(self):
        assert _resolve_max_turns({"complexity": "unknown"}, has_plan=False) == 20
