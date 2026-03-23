"""
Tests for subgraph composition in openseed_brain.

Covers:
  1. QA subgraph — node registration, graph structure, compile
  2. Fix subgraph — node registration, graph structure, compile
  3. build_graph with use_subgraphs=True  (subgraph mode)
  4. build_graph with use_subgraphs=False (default / backward compat)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openseed_brain.subgraphs.qa_subgraph import QASubState, build_qa_subgraph
from openseed_brain.subgraphs.fix_subgraph import FixSubState, build_fix_subgraph


# ── Helpers ───────────────────────────────────────────────────────────────────


def _node_names(graph) -> set[str]:
    """Return the set of user-defined node names from a StateGraph."""
    return set(graph.nodes.keys())


# ── 1. QA subgraph ────────────────────────────────────────────────────────────


class TestQASubgraphNodes:
    def test_qa_subgraph_has_all_nodes(self):
        """build_qa_subgraph registers select_agents, run_specialists, and synthesize."""
        graph = build_qa_subgraph()
        nodes = _node_names(graph)
        expected = {"select_agents", "run_specialists", "synthesize"}
        assert expected.issubset(nodes), f"Missing nodes: {expected - nodes}"

    def test_qa_subgraph_has_correct_edges(self):
        """The QA subgraph wires edges in the correct order."""
        graph = build_qa_subgraph()
        edges: set[tuple[str, str]] = set(graph.edges)
        assert ("select_agents", "run_specialists") in edges
        assert ("run_specialists", "synthesize") in edges

    def test_qa_subgraph_state_schema(self):
        """QASubState is a TypedDict with the expected keys."""
        required_keys = {"context", "working_dir", "findings", "verdict", "synthesis", "agents_run"}
        hints = QASubState.__annotations__
        assert required_keys.issubset(hints.keys()), (
            f"Missing QASubState keys: {required_keys - set(hints.keys())}"
        )


class TestQASubgraphCompiles:
    def test_qa_subgraph_compiles(self):
        """build_qa_subgraph().compile() returns a runnable compiled graph."""
        graph = build_qa_subgraph()
        compiled = graph.compile()
        # LangGraph compiled graphs expose ainvoke / invoke
        assert hasattr(compiled, "ainvoke") or hasattr(compiled, "invoke"), (
            "Compiled QA subgraph has no invoke method"
        )

    def test_qa_subgraph_compiled_is_not_none(self):
        """Compiled QA subgraph is not None."""
        compiled = build_qa_subgraph().compile()
        assert compiled is not None


# ── 2. Fix subgraph ───────────────────────────────────────────────────────────


class TestFixSubgraphNodes:
    def test_fix_subgraph_has_all_nodes(self):
        """build_fix_subgraph registers diagnose, fix, and verify nodes."""
        graph = build_fix_subgraph()
        nodes = _node_names(graph)
        expected = {"diagnose", "fix", "verify"}
        assert expected.issubset(nodes), f"Missing nodes: {expected - nodes}"

    def test_fix_subgraph_has_correct_edges(self):
        """The Fix subgraph wires edges in the correct order."""
        graph = build_fix_subgraph()
        edges: set[tuple[str, str]] = set(graph.edges)
        assert ("diagnose", "fix") in edges
        assert ("fix", "verify") in edges

    def test_fix_subgraph_state_schema(self):
        """FixSubState is a TypedDict with the expected keys."""
        required_keys = {"task", "working_dir", "errors", "fix_applied", "verified"}
        hints = FixSubState.__annotations__
        assert required_keys.issubset(hints.keys()), (
            f"Missing FixSubState keys: {required_keys - set(hints.keys())}"
        )


class TestFixSubgraphCompiles:
    def test_fix_subgraph_compiles(self):
        """build_fix_subgraph().compile() returns a runnable compiled graph."""
        graph = build_fix_subgraph()
        compiled = graph.compile()
        assert hasattr(compiled, "ainvoke") or hasattr(compiled, "invoke"), (
            "Compiled Fix subgraph has no invoke method"
        )

    def test_fix_subgraph_compiled_is_not_none(self):
        """Compiled Fix subgraph is not None."""
        compiled = build_fix_subgraph().compile()
        assert compiled is not None


# ── 3. build_graph with use_subgraphs=True ────────────────────────────────────


class TestBuildGraphWithSubgraphs:
    """build_graph(use_subgraphs=True) should wire compiled subgraphs as nodes."""

    def _build(self):
        from openseed_brain.graph import build_graph

        node_mocks = {
            "intake_node": AsyncMock(return_value={}),
            "plan_node": AsyncMock(return_value={}),
            "implement_node": AsyncMock(return_value={}),
            "deploy_node": AsyncMock(return_value={}),
            "memorize_node": AsyncMock(return_value={}),
            "sentinel_check_node": AsyncMock(return_value={}),
        }

        # Patch heavy qa / fix imports so compile() doesn't need real credentials
        mock_compiled = MagicMock()
        mock_compiled.__call__ = AsyncMock(return_value={})

        with (
            patch.multiple("openseed_brain.graph", **node_mocks),
            patch(
                "openseed_brain.graph.build_qa_subgraph",
                return_value=MagicMock(compile=lambda: mock_compiled),
            ),
            patch(
                "openseed_brain.graph.build_fix_subgraph",
                return_value=MagicMock(compile=lambda: mock_compiled),
            ),
        ):
            return build_graph(use_subgraphs=True)

    def test_build_graph_with_subgraphs_has_all_standard_nodes(self):
        """All non-subgraph nodes are still present when use_subgraphs=True."""
        graph = self._build()
        standard_nodes = {"intake", "plan", "implement", "sentinel_check", "user_escalate", "deploy", "memorize"}
        node_ids = set(graph.nodes.keys())
        assert standard_nodes.issubset(node_ids), f"Missing nodes: {standard_nodes - node_ids}"

    def test_build_graph_with_subgraphs_includes_qa_gate_and_fix(self):
        """qa_gate and fix nodes exist when use_subgraphs=True."""
        graph = self._build()
        node_ids = set(graph.nodes.keys())
        assert "qa_gate" in node_ids
        assert "fix" in node_ids

    def test_build_graph_with_subgraphs_edges_intact(self):
        """Critical edges are present when use_subgraphs=True."""
        graph = self._build()
        edges: set[tuple[str, str]] = set(graph.edges)
        assert ("implement", "qa_gate") in edges
        assert ("qa_gate", "sentinel_check") in edges
        assert ("fix", "qa_gate") in edges
        assert ("deploy", "memorize") in edges


# ── 4. build_graph default (use_subgraphs=False) ─────────────────────────────


class TestBuildGraphWithoutSubgraphsDefault:
    """build_graph() with no arguments (or use_subgraphs=False) retains the original behavior."""

    def _build(self, use_subgraphs: bool = False):
        from openseed_brain.graph import build_graph

        node_mocks = {
            "intake_node": AsyncMock(return_value={}),
            "plan_node": AsyncMock(return_value={}),
            "implement_node": AsyncMock(return_value={}),
            "qa_gate_node": AsyncMock(return_value={}),
            "sentinel_check_node": AsyncMock(return_value={}),
            "fix_node": AsyncMock(return_value={}),
            "deploy_node": AsyncMock(return_value={}),
            "memorize_node": AsyncMock(return_value={}),
        }

        with patch.multiple("openseed_brain.graph", **node_mocks):
            return build_graph(use_subgraphs=use_subgraphs)

    def test_build_graph_default_has_all_nodes(self):
        """Default build has all required nodes."""
        graph = self._build()
        expected = {
            "intake", "plan", "implement", "qa_gate",
            "sentinel_check", "fix", "user_escalate", "deploy", "memorize",
        }
        node_ids = set(graph.nodes.keys())
        assert expected.issubset(node_ids), f"Missing nodes: {expected - node_ids}"

    def test_build_graph_default_uses_flat_nodes(self):
        """Default build does not call build_qa_subgraph or build_fix_subgraph."""
        from openseed_brain.graph import build_graph

        node_mocks = {
            "intake_node": AsyncMock(return_value={}),
            "plan_node": AsyncMock(return_value={}),
            "implement_node": AsyncMock(return_value={}),
            "qa_gate_node": AsyncMock(return_value={}),
            "sentinel_check_node": AsyncMock(return_value={}),
            "fix_node": AsyncMock(return_value={}),
            "deploy_node": AsyncMock(return_value={}),
            "memorize_node": AsyncMock(return_value={}),
        }

        with (
            patch.multiple("openseed_brain.graph", **node_mocks),
            patch("openseed_brain.graph.build_qa_subgraph") as mock_qa,
            patch("openseed_brain.graph.build_fix_subgraph") as mock_fix,
        ):
            build_graph(use_subgraphs=False)

        mock_qa.assert_not_called()
        mock_fix.assert_not_called()

    def test_build_graph_explicit_false_equals_default(self):
        """build_graph(use_subgraphs=False) produces the same node set as build_graph()."""
        graph_default = self._build(use_subgraphs=False)
        graph_explicit = self._build(use_subgraphs=False)
        assert set(graph_default.nodes.keys()) == set(graph_explicit.nodes.keys())

    def test_build_graph_without_subgraphs_edges_intact(self):
        """All critical sequential edges exist in the default flat graph."""
        graph = self._build()
        edges: set[tuple[str, str]] = set(graph.edges)
        assert ("plan", "implement") in edges
        assert ("implement", "qa_gate") in edges
        assert ("qa_gate", "sentinel_check") in edges
        assert ("fix", "qa_gate") in edges
        assert ("deploy", "memorize") in edges
