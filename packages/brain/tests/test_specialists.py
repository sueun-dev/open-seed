"""
Tests for the specialist system — domain-expert agents and LLM-based task routing.

Covers:
  1. Specialist prompts — existence, depth, no regex usage
  2. Task router — LLM-based routing, parsing, fallback behavior
  3. Implement node — specialist dispatch, fullstack fallback, integration check
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openseed_brain.specialists import (
    SPECIALIST_PROMPTS,
    VALID_DOMAINS,
    get_specialist_prompt,
    list_domains,
)
from openseed_brain.state import initial_state
from openseed_brain.task_router import (
    _parse_routing_response,
    route_tasks,
)
from openseed_core.types import (
    FileEntry,
    Plan,
    PlanTask,
)

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_plan(
    summary: str = "Test plan",
    tasks: list[PlanTask] | None = None,
    files: list[FileEntry] | None = None,
) -> Plan:
    """Create a Plan with sensible defaults."""
    return Plan(
        summary=summary,
        tasks=tasks or [],
        file_manifest=files or [],
    )


def _make_task(
    task_id: str = "T1",
    description: str = "Do something",
    files: list[str] | None = None,
) -> PlanTask:
    """Create a PlanTask with sensible defaults."""
    return PlanTask(
        id=task_id,
        description=description,
        files=files or [],
    )


def _mock_claude_response(text: str) -> MagicMock:
    """Create a mock ClaudeResponse."""
    resp = MagicMock()
    resp.text = text
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Specialist Prompts
# ═══════════════════════════════════════════════════════════════════════════════


class TestSpecialistPrompts:
    """Tests for specialist prompt definitions."""

    def test_all_domains_have_prompts(self) -> None:
        """Every valid domain must have a non-empty prompt."""
        for domain in VALID_DOMAINS:
            prompt = get_specialist_prompt(domain)
            assert isinstance(prompt, str)
            assert len(prompt) > 500, (
                f"Specialist prompt for {domain!r} is too short ({len(prompt)} chars). "
                f"Domain experts need detailed prompts."
            )

    def test_get_specialist_prompt_returns_detailed_prompt(self) -> None:
        """Prompts must contain domain-specific expertise, not generic instructions."""
        frontend = get_specialist_prompt("frontend")
        assert "component" in frontend.lower()
        assert "css" in frontend.lower() or "styling" in frontend.lower()
        assert "accessible" in frontend.lower() or "accessibility" in frontend.lower() or "a11y" in frontend.lower()

        backend = get_specialist_prompt("backend")
        assert "api" in backend.lower()
        assert "middleware" in backend.lower()
        assert "authentication" in backend.lower() or "auth" in backend.lower()

        database = get_specialist_prompt("database")
        assert "schema" in database.lower()
        assert "index" in database.lower()
        assert "migration" in database.lower()

        infra = get_specialist_prompt("infra")
        assert "docker" in infra.lower()
        assert "ci" in infra.lower() or "ci/cd" in infra.lower()

    def test_specialist_prompts_have_no_regex(self) -> None:
        """No specialist prompt should contain regex patterns or regex references."""
        import re

        # Patterns that indicate regex usage in prompts
        regex_indicators = [
            r"re\.match",
            r"re\.search",
            r"re\.compile",
            r"re\.findall",
            r"re\.sub",
            r"regex",
            r"regular expression",
            r"regexp",
        ]

        for domain, prompt in SPECIALIST_PROMPTS.items():
            prompt_lower = prompt.lower()
            for indicator in regex_indicators:
                assert not re.search(indicator, prompt_lower), (
                    f"Specialist prompt for {domain!r} contains regex indicator "
                    f"{indicator!r}. All decisions must be made by LLM, not regex."
                )

    def test_invalid_domain_raises_key_error(self) -> None:
        """Requesting an unknown domain must raise KeyError."""
        with pytest.raises(KeyError, match="Unknown specialist domain"):
            get_specialist_prompt("quantum_computing")

    def test_list_domains_returns_all(self) -> None:
        """list_domains() must return all valid domains sorted."""
        domains = list_domains()
        assert domains == sorted(VALID_DOMAINS)
        assert "frontend" in domains
        assert "backend" in domains
        assert "database" in domains
        assert "infra" in domains
        assert "fullstack" in domains

    def test_specialist_prompts_contain_pitfalls(self) -> None:
        """Each specialist prompt should include common pitfalls to avoid."""
        for domain, prompt in SPECIALIST_PROMPTS.items():
            assert "pitfall" in prompt.lower() or "avoid" in prompt.lower(), (
                f"Specialist prompt for {domain!r} should include pitfalls/things to avoid."
            )

    def test_valid_domains_is_frozen(self) -> None:
        """VALID_DOMAINS must be a frozenset (immutable)."""
        assert isinstance(VALID_DOMAINS, frozenset)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Task Router — Parsing
# ═══════════════════════════════════════════════════════════════════════════════


class TestRoutingParser:
    """Tests for _parse_routing_response (no LLM calls)."""

    def test_parse_valid_json(self) -> None:
        """Valid JSON routing should be parsed correctly."""
        tasks = [
            _make_task("T1", "Build login page", ["src/Login.tsx"]),
            _make_task("T2", "Create user API", ["src/api/users.py"]),
        ]
        text = json.dumps(
            [
                {"task_id": "T1", "domain": "frontend"},
                {"task_id": "T2", "domain": "backend"},
            ]
        )

        result = _parse_routing_response(text, tasks)

        assert "frontend" in result
        assert "backend" in result
        assert len(result["frontend"]) == 1
        assert result["frontend"][0].id == "T1"
        assert len(result["backend"]) == 1
        assert result["backend"][0].id == "T2"

    def test_parse_json_with_surrounding_text(self) -> None:
        """JSON embedded in LLM prose should still be parsed."""
        tasks = [_make_task("T1", "Setup Docker", ["Dockerfile"])]
        text = 'Here is the routing:\n[{"task_id": "T1", "domain": "infra"}]\nDone!'

        result = _parse_routing_response(text, tasks)

        assert "infra" in result
        assert result["infra"][0].id == "T1"

    def test_parse_invalid_json_falls_back_to_fullstack(self) -> None:
        """Unparseable LLM output should assign all tasks to fullstack."""
        tasks = [
            _make_task("T1", "Build something"),
            _make_task("T2", "Build another thing"),
        ]
        text = "I think T1 should be frontend and T2 should be backend."

        result = _parse_routing_response(text, tasks)

        assert "fullstack" in result
        assert len(result["fullstack"]) == 2

    def test_parse_invalid_domain_falls_back_to_fullstack(self) -> None:
        """Tasks with invalid domain names should be assigned to fullstack."""
        tasks = [_make_task("T1", "Do something")]
        text = json.dumps([{"task_id": "T1", "domain": "quantum"}])

        result = _parse_routing_response(text, tasks)

        assert "fullstack" in result
        assert result["fullstack"][0].id == "T1"

    def test_parse_missing_tasks_fall_to_fullstack(self) -> None:
        """Tasks not mentioned in LLM response should go to fullstack."""
        tasks = [
            _make_task("T1", "Mentioned task"),
            _make_task("T2", "Forgotten task"),
        ]
        text = json.dumps([{"task_id": "T1", "domain": "frontend"}])

        result = _parse_routing_response(text, tasks)

        assert "frontend" in result
        assert result["frontend"][0].id == "T1"
        assert "fullstack" in result
        assert result["fullstack"][0].id == "T2"

    def test_parse_empty_tasks_returns_empty(self) -> None:
        """Empty task list should return empty result."""
        result = _parse_routing_response("[]", [])
        assert result == {}


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Task Router — LLM Integration
# ═══════════════════════════════════════════════════════════════════════════════


class TestRouteTasksLLM:
    """Tests for route_tasks (LLM calls mocked)."""

    @pytest.mark.asyncio
    async def test_route_tasks_simple_frontend_only(self) -> None:
        """A plan with only UI tasks should route everything to frontend."""
        plan = _make_plan(
            summary="Build a landing page",
            tasks=[
                _make_task("T1", "Create hero section component", ["src/Hero.tsx"]),
                _make_task("T2", "Create navigation bar", ["src/Navbar.tsx"]),
            ],
        )

        mock_response = _mock_claude_response(
            json.dumps(
                [
                    {"task_id": "T1", "domain": "frontend"},
                    {"task_id": "T2", "domain": "frontend"},
                ]
            )
        )

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await route_tasks(plan, "Build a landing page")

        assert "frontend" in result
        assert len(result["frontend"]) == 2
        assert len(result) == 1  # Only frontend domain

    @pytest.mark.asyncio
    async def test_route_tasks_fullstack_app(self) -> None:
        """A full-stack app should route tasks across multiple domains."""
        plan = _make_plan(
            summary="Build a todo app",
            tasks=[
                _make_task("T1", "Create React components", ["src/App.tsx"]),
                _make_task("T2", "Build REST API", ["src/api/routes.py"]),
                _make_task("T3", "Design database schema", ["migrations/001.sql"]),
                _make_task("T4", "Configure Docker", ["Dockerfile"]),
            ],
        )

        mock_response = _mock_claude_response(
            json.dumps(
                [
                    {"task_id": "T1", "domain": "frontend"},
                    {"task_id": "T2", "domain": "backend"},
                    {"task_id": "T3", "domain": "database"},
                    {"task_id": "T4", "domain": "infra"},
                ]
            )
        )

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await route_tasks(plan, "Build a todo app")

        assert len(result) == 4
        assert "frontend" in result
        assert "backend" in result
        assert "database" in result
        assert "infra" in result

    @pytest.mark.asyncio
    async def test_route_tasks_backend_only(self) -> None:
        """A pure API project should route everything to backend."""
        plan = _make_plan(
            summary="Build a REST API",
            tasks=[
                _make_task("T1", "Create user endpoints", ["src/routes/users.py"]),
                _make_task("T2", "Add auth middleware", ["src/middleware/auth.py"]),
            ],
        )

        mock_response = _mock_claude_response(
            json.dumps(
                [
                    {"task_id": "T1", "domain": "backend"},
                    {"task_id": "T2", "domain": "backend"},
                ]
            )
        )

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await route_tasks(plan, "Build a REST API")

        assert "backend" in result
        assert len(result["backend"]) == 2
        assert len(result) == 1

    @pytest.mark.asyncio
    async def test_route_tasks_empty_plan(self) -> None:
        """Empty plan should return empty routing."""
        plan = _make_plan(tasks=[])
        result = await route_tasks(plan, "Do nothing")
        assert result == {}

    @pytest.mark.asyncio
    async def test_route_tasks_uses_haiku_model(self) -> None:
        """Routing should use Haiku for speed and cost efficiency."""
        plan = _make_plan(tasks=[_make_task("T1", "Build something")])

        mock_response = _mock_claude_response(json.dumps([{"task_id": "T1", "domain": "fullstack"}]))

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            mock_invoke = AsyncMock(return_value=mock_response)
            MockAgent.return_value.invoke = mock_invoke
            await route_tasks(plan, "Build something")

        # Verify standard model was used for routing
        call_kwargs = mock_invoke.call_args
        assert call_kwargs.kwargs.get("model") == "standard"


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Implement Node
# ═══════════════════════════════════════════════════════════════════════════════


class TestImplementNode:
    """Tests for the implement_node function."""

    @pytest.mark.asyncio
    async def test_no_plan_uses_fullstack(self) -> None:
        """When there is no plan, fullstack specialist should be used."""
        from openseed_brain.nodes.implement import implement_node

        state = initial_state("Build a calculator", "/tmp/test")

        mock_response = _mock_claude_response("Built a calculator app.")

        with patch("openseed_codex.agent.CodexAgent") as MockAgent:
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await implement_node(state)

        assert "implementation" in result
        assert "fullstack" in result["messages"][0].lower()

    @pytest.mark.asyncio
    async def test_codex_provider_no_plan_uses_fullstack(self) -> None:
        """Provider 'codex' without plan should use fullstack specialist."""
        from openseed_brain.nodes.implement import implement_node

        state = initial_state("Build something", "/tmp/test", provider="codex")

        mock_response = MagicMock()
        mock_response.text = "Built it."
        mock_response.files_created = ["app.py"]
        mock_response.files_modified = []

        with patch("openseed_codex.agent.CodexAgent") as MockCodex:
            MockCodex.return_value.invoke = AsyncMock(return_value=mock_response)
            result = await implement_node(state)

        assert "fullstack" in result["messages"][0].lower()

    @pytest.mark.asyncio
    async def test_specialist_dispatch_with_plan(self) -> None:
        """With a plan, tasks should be routed and specialists dispatched in parallel."""
        from openseed_brain.nodes.implement import implement_node

        plan = _make_plan(
            summary="Build a web app",
            tasks=[
                _make_task("T1", "Create UI", ["src/App.tsx"]),
                _make_task("T2", "Create API", ["src/api.py"]),
            ],
        )
        state = initial_state("Build a web app", "/tmp/test")
        state["plan"] = plan

        # Mock route_tasks to return split routing
        routing_result = {
            "frontend": [plan.tasks[0]],
            "backend": [plan.tasks[1]],
        }

        mock_specialist_response = _mock_claude_response("Implemented the code.")
        _mock_claude_response("Everything looks good.")

        with (
            patch("openseed_brain.task_router.route_tasks", new_callable=AsyncMock) as mock_router,
            patch("openseed_codex.agent.CodexAgent") as MockAgent,
        ):
            mock_router.return_value = routing_result
            MockAgent.return_value.invoke = AsyncMock(return_value=mock_specialist_response)

            # Override integration check to return our mock
            with patch(
                "openseed_brain.nodes.implement._integration_check",
                new_callable=AsyncMock,
            ) as mock_check:
                from openseed_brain.state import Implementation

                mock_check.return_value = Implementation(
                    summary="[integration-check] All good",
                    raw_output="All good",
                )
                result = await implement_node(state)

        assert "implementation" in result
        assert "specialists" in result["messages"][0].lower()
        # Integration check should have been called (2 specialists)
        mock_check.assert_called_once()
