# Harness Generation Guide (AI Reference)

You are generating AGENTS.md harness files for a project. Follow these rules exactly.

## 5 Principles

1. **Minimal**: Only include what agents cannot infer from code. Unnecessary constraints hurt performance.
2. **Toolchain First**: If linter/formatter/type-checker already enforces it, do NOT write it in AGENTS.md.
3. **No Pink Elephants**: Avoid "don't do X" hints. Use NEVER section only for hard limits.
4. **Context Anchor**: AGENTS.md is persistent memory. Only include stable architectural judgments.
5. **Context is Code**: Every rule must be testable. Version control it. Optimize signal-to-noise.

## Root AGENTS.md Structure (under 150 lines)

```markdown
# AGENTS.md

> **Project:** [1-2 sentence description — domain context not inferable from code]
> **Core constraint:** [if any — e.g., offline-first, OAuth only]

## Key Commands
| Intent | Command | Notes |
|--------|---------|-------|
| Install | `[cmd]` | [package manager] |
| Test | `[cmd]` | [test runner] |
| Lint | `[cmd]` | see [config file] |
| Type check | `[cmd]` | see [config file] |
| Build | `[cmd]` | [build tool] |
| Dev | `[cmd]` | [port/details] |

## Architecture Constraints
- Dependency flow: [describe allowed import directions]
- [Other non-obvious architectural decisions]

## Code Style
- [Only rules NOT enforced by toolchain]
- [Language version, type hint policy, error handling pattern, logging strategy]

## Boundaries

### NEVER
- Commit secrets, tokens, or .env files
- [Project-specific hard limits]

### ASK
- Before adding new external dependencies
- [Project-specific human-in-the-loop triggers]

### ALWAYS
- Run `[lint && typecheck && test]` before marking task complete
- [Project-specific proactive requirements]

## Context Map
```yaml
[Only if monorepo or complex structure]
packages:
  path/: description
notable:
  path/: description — only non-obvious directories
```
```

## Sub-AGENTS.md (per package/directory, under 30 lines)

```markdown
# AGENTS.md ([path]/)

## Scope
[One line: what this package does]

## Rules
- [Package-specific architectural decisions only]
- [Not toolchain rules]

## Testing
- Run: `[test command for this package]`
- [Testing strategy notes]
```

## Multi-tool Compatibility

Create AGENTS.md as primary. Symlink for other tools:
- `ln -s AGENTS.md CLAUDE.md` (Claude Code)
- Cursor reads `.cursorrules` and AGENTS.md
- Codex reads AGENTS.md natively

## What NOT to Include

- Toolchain config (linter rules, formatter settings, tsconfig options)
- Directory structure maps (agents can explore)
- README content (agents can read README)
- Anything that changes frequently (belongs elsewhere)
- LLM-generated boilerplate (reduces performance)

## Detection → Generation Rules

When scanning a project folder:

**Python project** (pyproject.toml/requirements.txt):
- Key Commands: pip/uv/poetry install, pytest, ruff/flake8, mypy
- Code Style: Python version, type hints, async/await policy

**Node.js/TypeScript** (package.json):
- Key Commands: npm/pnpm/yarn install, vitest/jest, eslint/biome, tsc
- Code Style: strict mode, named exports, error pattern

**Go** (go.mod):
- Key Commands: go build, go test, golangci-lint
- Code Style: error handling pattern

**Monorepo** (workspaces/turbo/nx):
- Add dependency flow constraint
- Create sub-AGENTS.md per package
- Context Map required

**Always detect**: test runner, linter, formatter, build tool, CI/CD, database, ORM.
**Never guess**: If not detected, omit. Do not fabricate.
