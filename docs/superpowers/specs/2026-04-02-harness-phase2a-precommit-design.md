# Harness Phase 2A: Pre-commit Hooks Design Spec

## Goal

Pre-commit hooks로 lint/format을 commit 전에 자동 강제하여 Level 1 Basic Harness를 완성한다.

## Scope

가이드 7절 Level 1의 마지막 미완성 항목: "Pre-commit hooks로 lint/format 강제"

## Files

| # | File | Action |
|---|------|--------|
| 1 | `.pre-commit-config.yaml` | Create — hook definitions |
| 2 | `pyproject.toml` | Modify — add pre-commit to dev deps |

2개 파일. 이게 전부.

## .pre-commit-config.yaml

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.6
    hooks:
      - id: ruff
        args: [check, --fix]
      - id: ruff-format
  - repo: local
    hooks:
      - id: mypy
        name: mypy
        entry: mypy packages/
        language: system
        types: [python]
        pass_filenames: false
```

## pyproject.toml change

```toml
[dependency-groups]
dev = [
    "pytest>=9.0.2",
    "pytest-asyncio>=1.3.0",
    "pre-commit>=4.0",
]
```

## Validation

```bash
uv sync
pre-commit install
pre-commit run --all-files
```

## Guide compliance

- Level 1 요구: "Pre-commit hooks로 lint/format 강제" ✓
- 원칙 2 (Toolchain First): ruff/mypy가 기계적으로 강제 ✓
- 원칙 4 (기계적 강제): commit 전 자동 실행 ✓
