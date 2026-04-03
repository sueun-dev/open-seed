"""
Tests for microagent system — OpenHands pattern integration.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from openseed_core.microagent import (
    Microagent,
    _parse_microagent_file,
    format_microagent_context,
    load_microagents,
)

if TYPE_CHECKING:
    from pathlib import Path


class TestLoadMicroagents:
    def test_load_from_empty_dir(self, tmp_path: Path) -> None:
        agents = load_microagents(str(tmp_path))
        assert agents == []

    def test_load_cursorrules(self, tmp_path: Path) -> None:
        (tmp_path / ".cursorrules").write_text("Use TypeScript strict mode")
        agents = load_microagents(str(tmp_path))
        assert len(agents) == 1
        assert agents[0].name == "cursor-rules"
        assert "TypeScript" in agents[0].content

    def test_load_agents_md(self, tmp_path: Path) -> None:
        (tmp_path / "AGENTS.md").write_text("# Agent Instructions\nUse pytest")
        agents = load_microagents(str(tmp_path))
        assert len(agents) == 1
        assert agents[0].name == "agents-md"

    def test_load_claude_md(self, tmp_path: Path) -> None:
        (tmp_path / "CLAUDE.md").write_text("# Rules\nNo regex")
        agents = load_microagents(str(tmp_path))
        assert len(agents) == 1
        assert agents[0].name == "claude-md"

    def test_load_openseed_agents_dir(self, tmp_path: Path) -> None:
        agents_dir = tmp_path / ".openseed" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "react-guide.md").write_text(
            "---\nname: react-guide\ntype: knowledge\ntriggers: [react, frontend]\n---\n\n"
            "Always use functional components with hooks."
        )
        agents = load_microagents(str(tmp_path))
        assert len(agents) == 1
        assert agents[0].name == "react-guide"
        assert agents[0].type == "knowledge"
        assert agents[0].triggers == ["react", "frontend"]

    def test_load_multiple_sources(self, tmp_path: Path) -> None:
        (tmp_path / ".cursorrules").write_text("rules")
        (tmp_path / "CLAUDE.md").write_text("claude rules")
        agents_dir = tmp_path / ".openseed" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "custom.md").write_text("---\nname: custom\ntype: repo\n---\nCustom rules")
        agents = load_microagents(str(tmp_path))
        assert len(agents) == 3


class TestParseMicroagentFile:
    def test_parse_with_frontmatter(self, tmp_path: Path) -> None:
        f = tmp_path / "test.md"
        f.write_text(
            "---\nname: my-agent\ntype: knowledge\ntriggers: [python, backend]\n---\n\nUse type hints everywhere."
        )
        agent = _parse_microagent_file(f)
        assert agent is not None
        assert agent.name == "my-agent"
        assert agent.type == "knowledge"
        assert agent.triggers == ["python", "backend"]
        assert "type hints" in agent.content

    def test_parse_without_frontmatter(self, tmp_path: Path) -> None:
        f = tmp_path / "simple.md"
        f.write_text("Just some instructions for the agent.")
        agent = _parse_microagent_file(f)
        assert agent is not None
        assert agent.name == "simple"
        assert agent.type == "repo"
        assert agent.triggers == []

    def test_parse_empty_file_returns_none(self, tmp_path: Path) -> None:
        f = tmp_path / "empty.md"
        f.write_text("")
        agent = _parse_microagent_file(f)
        assert agent is None


class TestFormatMicroagentContext:
    def test_empty_list(self) -> None:
        assert format_microagent_context([]) == ""

    def test_single_agent(self) -> None:
        agents = [Microagent(name="test", type="repo", content="Use pytest")]
        result = format_microagent_context(agents)
        assert "test" in result
        assert "Use pytest" in result
        assert "Project-Specific Context" in result

    def test_multiple_agents(self) -> None:
        agents = [
            Microagent(name="frontend", type="knowledge", content="Use React"),
            Microagent(name="backend", type="repo", content="Use FastAPI"),
        ]
        result = format_microagent_context(agents)
        assert "frontend" in result
        assert "backend" in result
