"""Tests for diagram node — file scanning, cycle detection, URL generation."""

import os
import json
import tempfile

import pytest

from openseed_brain.nodes.diagram import (
    scan_project_files,
    fix_mermaid_cycles,
    create_mermaid_url,
    _extract_mermaid,
    _smart_truncate,
)


# ─── scan_project_files ─────────────────────────────────────────────────────


class TestScanProjectFiles:
    def test_empty_dir(self, tmp_path):
        result = scan_project_files(str(tmp_path))
        assert result == []

    def test_nonexistent_dir(self):
        result = scan_project_files("/nonexistent/path/xyz")
        assert result == []

    def test_basic_scan(self, tmp_path):
        (tmp_path / "main.py").write_text("print('hello')")
        (tmp_path / "utils.py").write_text("def add(a, b): return a + b")
        result = scan_project_files(str(tmp_path))
        assert len(result) == 2
        paths = {f["path"] for f in result}
        assert "main.py" in paths
        assert "utils.py" in paths

    def test_skips_lock_files(self, tmp_path):
        (tmp_path / "main.py").write_text("code")
        (tmp_path / "package-lock.json").write_text("{}")
        (tmp_path / "yarn.lock").write_text("")
        result = scan_project_files(str(tmp_path))
        paths = {f["path"] for f in result}
        assert "main.py" in paths
        assert "package-lock.json" not in paths
        assert "yarn.lock" not in paths

    def test_skips_hidden_and_node_modules(self, tmp_path):
        (tmp_path / "app.py").write_text("code")
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        (git_dir / "config").write_text("")
        nm_dir = tmp_path / "node_modules"
        nm_dir.mkdir()
        (nm_dir / "dep.js").write_text("")
        result = scan_project_files(str(tmp_path))
        paths = {f["path"] for f in result}
        assert "app.py" in paths
        assert len(result) == 1

    def test_config_files_prioritized(self, tmp_path):
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "deep" / "nested").mkdir(parents=True)
        (tmp_path / "deep" / "nested" / "util.ts").write_text("export const x = 1;")
        (tmp_path / "index.ts").write_text("import './deep/nested/util';")
        result = scan_project_files(str(tmp_path))
        # package.json should be first (highest priority)
        assert result[0]["path"] == "package.json"

    def test_entry_points_before_deep_files(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "deep.ts").write_text("// deep")
        (tmp_path / "main.py").write_text("# entry")
        result = scan_project_files(str(tmp_path))
        paths = [f["path"] for f in result]
        main_idx = paths.index("main.py")
        deep_idx = paths.index(os.path.join("src", "deep.ts"))
        assert main_idx < deep_idx

    def test_unsupported_extensions_skipped(self, tmp_path):
        (tmp_path / "app.py").write_text("code")
        (tmp_path / "image.png").write_bytes(b"\x89PNG")
        (tmp_path / "data.bin").write_bytes(b"\x00\x01")
        result = scan_project_files(str(tmp_path))
        assert len(result) == 1
        assert result[0]["path"] == "app.py"

    def test_reads_file_content(self, tmp_path):
        (tmp_path / "hello.py").write_text("print('hello world')")
        result = scan_project_files(str(tmp_path))
        assert result[0]["content"] == "print('hello world')"

    def test_truncates_large_files(self, tmp_path):
        large_content = "x = 1\n" * 5000  # ~30K chars
        (tmp_path / "big.py").write_text(large_content)
        result = scan_project_files(str(tmp_path))
        assert len(result[0]["content"]) <= 8500  # MAX_SINGLE_FILE + some margin

    def test_nested_directory_structure(self, tmp_path):
        (tmp_path / "src" / "components").mkdir(parents=True)
        (tmp_path / "src" / "components" / "App.tsx").write_text("export default function App() {}")
        (tmp_path / "src" / "index.ts").write_text("import App from './components/App'")
        (tmp_path / "server" / "api").mkdir(parents=True)
        (tmp_path / "server" / "api" / "routes.py").write_text("from flask import Flask")
        result = scan_project_files(str(tmp_path))
        assert len(result) == 3


# ─── fix_mermaid_cycles ──────────────────────────────────────────────────────


class TestFixMermaidCycles:
    def test_no_cycles(self):
        code = """graph TD
    subgraph Frontend
        React[React App]
    end
    subgraph Backend
        API[REST API]
    end
    React --> API"""
        result = fix_mermaid_cycles(code)
        assert result == code  # No changes

    def test_detects_and_fixes_simple_cycle(self):
        code = """graph TD
    subgraph Extension
        Extension[Extension Entry Point]
        Handler[Event Handler]
    end"""
        result = fix_mermaid_cycles(code)
        assert "subgraph Extension_" in result
        assert "Extension[Extension Entry Point]" in result

    def test_fixes_multiple_cycles(self):
        code = """graph TD
    subgraph API
        API[API Server]
    end
    subgraph Database
        Database[Database Client]
    end"""
        result = fix_mermaid_cycles(code)
        assert "subgraph API_" in result
        assert "subgraph Database_" in result

    def test_preserves_labels_with_brackets(self):
        code = """graph TD
    subgraph Auth [Authentication Layer]
        Auth[Auth Module]
    end"""
        result = fix_mermaid_cycles(code)
        assert "Authentication Layer" in result
        assert "Auth[Auth Module]" in result

    def test_no_false_positives(self):
        code = """graph TD
    subgraph Frontend
        App[App Component]
        Router[Router]
    end
    subgraph Backend
        Server[Express Server]
        DB[Database]
    end
    App --> Server"""
        result = fix_mermaid_cycles(code)
        assert result == code

    def test_empty_input(self):
        assert fix_mermaid_cycles("") == ""

    def test_nested_subgraphs(self):
        code = """graph TD
    subgraph Outer
        subgraph Inner
            Node1[Node 1]
        end
    end"""
        result = fix_mermaid_cycles(code)
        assert result == code  # No cycles here


# ─── create_mermaid_url ──────────────────────────────────────────────────────


class TestCreateMermaidUrl:
    def test_returns_valid_url(self):
        url = create_mermaid_url("graph TD\n    A --> B")
        assert url.startswith("https://mermaid.ink/svg/pako:")

    def test_img_variant(self):
        url = create_mermaid_url("graph TD\n    A --> B", variant="img")
        assert url.startswith("https://mermaid.ink/img/pako:")

    def test_different_themes(self):
        url_dark = create_mermaid_url("graph TD\n    A --> B", theme="dark")
        url_default = create_mermaid_url("graph TD\n    A --> B", theme="default")
        assert url_dark != url_default

    def test_url_is_deterministic(self):
        code = "graph TD\n    A --> B"
        url1 = create_mermaid_url(code)
        url2 = create_mermaid_url(code)
        assert url1 == url2

    def test_no_padding_chars(self):
        url = create_mermaid_url("graph TD\n    A --> B --> C --> D")
        # base64url should not have = padding
        encoded_part = url.split("pako:")[1]
        assert "=" not in encoded_part
        assert "+" not in encoded_part
        assert "/" not in encoded_part


# ─── _extract_mermaid ────────────────────────────────────────────────────────


class TestExtractMermaid:
    def test_extracts_from_code_block(self):
        text = """Here is the diagram:
```mermaid
graph TD
    A --> B
```
Some explanation."""
        result = _extract_mermaid(text)
        assert result == "graph TD\n    A --> B"

    def test_extracts_without_code_block(self):
        text = "graph TD\n    A --> B"
        result = _extract_mermaid(text)
        assert "graph TD" in result

    def test_returns_empty_for_no_diagram(self):
        result = _extract_mermaid("No diagram here, just text.")
        assert result == ""

    def test_handles_flowchart_prefix(self):
        text = "flowchart LR\n    A --> B"
        result = _extract_mermaid(text)
        assert "flowchart LR" in result

    def test_extracts_sequence_diagram(self):
        text = "```mermaid\nsequenceDiagram\n    A->>B: Hello\n```"
        result = _extract_mermaid(text)
        assert "sequenceDiagram" in result


# ─── _smart_truncate ─────────────────────────────────────────────────────────


class TestSmartTruncate:
    def test_short_content_unchanged(self):
        content = "line1\nline2\nline3"
        assert _smart_truncate(content, 1000) == content

    def test_truncates_long_content(self):
        content = "\n".join(f"line {i}" for i in range(200))
        result = _smart_truncate(content, 500)
        assert len(result) <= 500

    def test_preserves_head(self):
        lines = [f"import module{i}" for i in range(30)]
        lines += [f"x = {i}" for i in range(100)]
        content = "\n".join(lines)
        result = _smart_truncate(content, 1000)
        assert "import module0" in result

    def test_includes_signatures(self):
        lines = ["# header"] * 30
        lines += ["def important_function():", "    pass"]
        lines += ["class MyClass:", "    pass"]
        lines += ["random code"] * 50
        content = "\n".join(lines)
        result = _smart_truncate(content, 2000)
        assert "def important_function" in result
        assert "class MyClass" in result
