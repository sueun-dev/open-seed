import type {
  ProjectAnalysis,
  HarnessOutput,
  DocsFile,
  SubAgentsMd,
  CurationItem,
} from "./types.js";

// ── Harness Generator (Phase 1 Output) ─────────────────────

export function generateHarness(
  analysis: ProjectAnalysis,
  curationAnswers: Map<string, string>
): HarnessOutput {
  const agentsMd = generateAgentsMd(analysis, curationAnswers);
  const globalAgentsMd = generateGlobalAgentsMd(analysis);
  const configToml = generateConfigToml();
  const docsStructure = generateDocsStructure(analysis, curationAnswers);
  const subAgentsMd = generateSubAgentsMd(analysis);

  return {
    agentsMd,
    globalAgentsMd,
    configToml,
    docsStructure,
    subAgentsMd,
    claudeMdSymlink: true,
  };
}

// ── AGENTS.md Generation ────────────────────────────────────

function generateAgentsMd(
  analysis: ProjectAnalysis,
  answers: Map<string, string>
): string {
  const sections: string[] = [];
  const { techStack: stack, commands, monorepo } = analysis;

  // ── Mission
  const mission = answers.get("mission") ?? `[TODO: Describe your project in 1-2 sentences]`;
  const coreConstraint = answers.get("core-constraint");

  sections.push(`# AGENTS.md\n`);
  sections.push(`> **Project:** ${mission}`);
  if (coreConstraint && coreConstraint !== "없음") {
    sections.push(`> **Core constraint:** ${coreConstraint}`);
  }
  sections.push("");

  // ── Key Commands
  sections.push(`## Key Commands`);
  sections.push(`| Intent | Command | Notes |`);
  sections.push(`|--------|---------|-------|`);

  const commandEntries: [string, string | null, string][] = [
    ["Install", commands.install, stack.packageManager ? `${stack.packageManager} only` : ""],
    ["Build", commands.build, stack.buildTool ? `${stack.buildTool}` : ""],
    ["Dev", commands.dev, ""],
    ["Test", commands.test, stack.testRunner ?? ""],
    ["Lint", commands.lint, stack.linter ? `${stack.linter.name} (see \`${stack.linter.configFile}\`)` : ""],
    ["Type check", commands.typecheck, stack.languages.includes("TypeScript") ? "tsc --noEmit" : ""],
    ["Format", commands.format, stack.formatter ?? ""],
    ["E2E", commands.e2e, ""],
    ["DB migrate", commands.migrate, stack.orm ?? ""],
  ];

  for (const [intent, cmd, notes] of commandEntries) {
    if (cmd) {
      sections.push(`| ${intent} | \`${cmd}\` | ${notes} |`);
    }
  }
  sections.push("");

  // ── Architecture Constraints
  if (monorepo && monorepo.packages.length > 1) {
    sections.push(`## Architecture Constraints`);
    const depFlow = answers.get("dependency-flow");
    if (depFlow) {
      sections.push(`- Dependency flow: ${depFlow}`);
    }
    const nonObvious = answers.get("non-obvious-patterns");
    if (nonObvious && nonObvious !== "없음") {
      sections.push(`- ${nonObvious}`);
    }
    sections.push("");
  }

  // ── Code Style
  sections.push(`## Code Style`);
  if (stack.languages.includes("TypeScript")) {
    sections.push(`- TypeScript strict mode. No \`any\`, no \`as\` assertions without justifying comment.`);
    sections.push(`- Named exports only. No default exports except framework page components.`);
  }

  const errorHandling = answers.get("error-handling");
  if (errorHandling && errorHandling !== "프로젝트에 맞게 AI가 추천") {
    sections.push(`- Error handling: ${errorHandling}`);
  }
  sections.push(`- Logging: structured JSON. No console.log in production code.`);
  sections.push("");

  // ── Non-Obvious Patterns
  const nonObvious = answers.get("non-obvious-patterns");
  if (nonObvious && nonObvious !== "없음") {
    sections.push(`## Non-Obvious Patterns`);
    sections.push(`- ${nonObvious}`);
    sections.push("");
  }

  // ── Testing Rules
  if (stack.testRunner) {
    sections.push(`## Testing Rules`);
    const coverage = answers.get("test-coverage");
    if (coverage && coverage !== "커버리지 요구 없음") {
      sections.push(`- Minimum coverage: ${coverage}`);
    }
    sections.push(`- All tests must be deterministic and isolated. Mock external dependencies.`);
    if (commands.test) {
      sections.push(`- Run \`${commands.test}\` before marking any task complete.`);
    }
    sections.push("");
  }

  // ── Boundaries
  sections.push(`## Boundaries\n`);

  // NEVER
  sections.push(`### NEVER`);
  sections.push(`- Commit secrets, tokens, or .env files`);
  sections.push(`- Force push to main or protected branches`);
  sections.push(`- Modify vendor/, dist/, or build/ directories`);
  const neverExtra = answers.get("never-boundaries");
  if (neverExtra && neverExtra !== "기본값만 사용") {
    sections.push(`- ${neverExtra}`);
  }
  sections.push("");

  // ASK
  sections.push(`### ASK`);
  sections.push(`- Before adding new external dependencies`);
  sections.push(`- Before deleting files`);
  const askExtra = answers.get("ask-boundaries");
  if (askExtra && askExtra !== "기본값만 사용") {
    sections.push(`- ${askExtra}`);
  }
  sections.push("");

  // ALWAYS
  sections.push(`### ALWAYS`);
  sections.push(`- Explain your plan before writing code`);
  sections.push(`- Handle all errors explicitly — never silently suppress exceptions`);

  const verifyCommands: string[] = [];
  if (commands.lint) verifyCommands.push(commands.lint);
  if (commands.typecheck) verifyCommands.push(commands.typecheck);
  if (commands.test) verifyCommands.push(commands.test);
  if (verifyCommands.length > 0) {
    sections.push(`- Run \`${verifyCommands.join(" && ")}\` before marking task complete`);
  }
  sections.push("");

  // ── Persona
  const persona = answers.get("persona");
  if (persona && persona !== "페르소나 없음") {
    if (persona.includes("멀티")) {
      sections.push(`## Personas`);
      sections.push(`Invoke via skill: @Lead, @Dev, @Critic`);
      sections.push(`Definitions: \`.claude/skills/\``);
    } else {
      sections.push(`## Identity`);
      sections.push(`${persona} — ${stack.languages.join(", ")}${stack.frameworks.length ? `, ${stack.frameworks.join(", ")}` : ""}.`);
      sections.push(`Favor explicit error handling and composition over inheritance.`);
    }
    sections.push("");
  }

  // ── Git Conventions
  const gitConv = answers.get("git-conventions");
  if (gitConv && gitConv !== "Free-form") {
    sections.push(`## Git Conventions`);
    if (gitConv.includes("Conventional")) {
      sections.push(`- Commit format: \`type(scope): description\``);
      sections.push(`  Types: feat, fix, refactor, test, docs, chore, perf`);
    } else if (gitConv.includes("Gitmoji")) {
      sections.push(`- Commit format: \`:emoji: description\` (Gitmoji convention)`);
    }
    sections.push(`- PR must pass CI before merge. Squash merge only.`);
    sections.push(`- Branch naming: \`type/short-description\``);
    sections.push("");
  }

  // ── Context Map
  if (monorepo || Object.keys(analysis.structure.notable).length > 3) {
    sections.push(`## Context Map`);
    sections.push("```yaml");
    if (monorepo) {
      sections.push(`monorepo: ${monorepo.tool}\n`);
      sections.push(`packages:`);
      for (const pkg of monorepo.packages) {
        sections.push(`  ${pkg.path}: ${pkg.description}`);
      }
    }
    if (Object.keys(analysis.structure.notable).length > 0) {
      sections.push(`\nnotable:`);
      for (const [dir, desc] of Object.entries(analysis.structure.notable)) {
        if (!["node_modules", "dist", "build", ".git"].includes(dir)) {
          sections.push(`  ${dir}/: ${desc}`);
        }
      }
    }
    sections.push("```");
    sections.push("");
  }

  return sections.join("\n");
}

// ── Global AGENTS.md ────────────────────────────────────────

function generateGlobalAgentsMd(analysis: ProjectAnalysis): string {
  const { techStack: stack } = analysis;
  const sections: string[] = [];

  sections.push(`# Global AGENTS.md\n`);
  sections.push(`## General Preferences`);

  if (stack.languages.includes("TypeScript")) {
    sections.push(`- Language: TypeScript (prefer over JavaScript in all cases)`);
  }
  if (stack.packageManager) {
    sections.push(`- Package manager: ${stack.packageManager} (always use ${stack.packageManager})`);
  }
  sections.push(`- Always run lint and typecheck before considering a task done`);
  sections.push(`- Commit messages in English, conventional commit format`);
  sections.push("");

  sections.push(`## Security (Global)`);
  sections.push(`- Never write secrets, API keys, or credentials into any file`);
  sections.push(`- Never disable linter rules with inline comments without justification`);
  sections.push("");

  sections.push(`## Quality`);
  sections.push(`- No TODO comments without a linked issue number`);
  sections.push(`- Remove unused imports and dead code before committing`);
  sections.push(`- Prefer composition over inheritance`);
  sections.push(`- Keep functions under 40 lines when possible`);

  return sections.join("\n");
}

// ── config.toml ─────────────────────────────────────────────

function generateConfigToml(): string {
  return `# ~/.codex/config.toml
project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]
project_doc_max_bytes = 65536
`;
}

// ── docs/ Structure ─────────────────────────────────────────

function generateDocsStructure(
  analysis: ProjectAnalysis,
  answers: Map<string, string>
): DocsFile[] {
  const files: DocsFile[] = [];

  // architecture/overview.md
  const mission = answers.get("mission") ?? "[TODO]";
  const constraint = answers.get("core-constraint");

  files.push({
    path: "docs/architecture/overview.md",
    content: `# Architecture Overview

## Project
${mission}
${constraint && constraint !== "없음" ? `\n## Core Constraint\n${constraint}` : ""}

## Tech Stack
${analysis.techStack.languages.map((l) => `- ${l}`).join("\n")}
${analysis.techStack.frameworks.map((f) => `- ${f}`).join("\n")}
${analysis.techStack.database ? `- Database: ${analysis.techStack.database}` : ""}
${analysis.techStack.orm ? `- ORM: ${analysis.techStack.orm}` : ""}

## Module Structure
${
  analysis.monorepo
    ? analysis.monorepo.packages.map((p) => `- \`${p.path}\`: ${p.description}`).join("\n")
    : Object.entries(analysis.structure.notable)
        .map(([dir, desc]) => `- \`${dir}/\`: ${desc}`)
        .join("\n")
}

## Dependency Rules
${answers.get("dependency-flow") ?? "[TODO: Define dependency flow between modules]"}
`,
  });

  // architecture/dependency-graph.md
  files.push({
    path: "docs/architecture/dependency-graph.md",
    content: `# Dependency Graph

## Rules
${answers.get("dependency-flow") ?? "[TODO: Define allowed import directions]"}

## Enforcement
- Structural tests validate compliance on every PR
- CI blocks merges that violate dependency rules
- Linter rules prevent cross-boundary imports

## Visualization
[TODO: Add mermaid diagram or ASCII art of dependency flow]
`,
  });

  // architecture/adr/000-template.md
  files.push({
    path: "docs/architecture/adr/000-template.md",
    content: `# ADR-000: [Title]

## Status
[Proposed | Accepted | Deprecated | Superseded]

## Context
[What is the issue that we're seeing that is motivating this decision?]

## Decision
[What is the change that we're proposing and/or doing?]

## Consequences
[What becomes easier or more difficult to do because of this change?]

## Alternatives Considered
[What other options did we evaluate?]
`,
  });

  // maps/module-map.md
  files.push({
    path: "docs/maps/module-map.md",
    content: `# Module Map

## Overview
This map helps agents navigate the codebase efficiently.

## Key Directories
${Object.entries(analysis.structure.notable)
  .map(([dir, desc]) => `### \`${dir}/\`\n${desc}\n`)
  .join("\n")}

## Entry Points
[TODO: List main entry points for the application]

## Key Files
[TODO: List critical files that agents should understand]
`,
  });

  // maps/execution-plan.md
  files.push({
    path: "docs/maps/execution-plan.md",
    content: `# Agent Execution Plan

## Workflow
1. Read AGENTS.md and relevant docs/
2. Analyze the task requirements
3. Check existing tests and patterns
4. Implement changes following architectural constraints
5. Run verification: lint → typecheck → test
6. Self-review changes before submitting

## Verification Checklist
${analysis.commands.lint ? `- [ ] Lint passes: \`${analysis.commands.lint}\`` : ""}
${analysis.commands.typecheck ? `- [ ] Type check passes: \`${analysis.commands.typecheck}\`` : ""}
${analysis.commands.test ? `- [ ] Tests pass: \`${analysis.commands.test}\`` : ""}
- [ ] No new linter warnings
- [ ] No unused imports or dead code
- [ ] Error handling is explicit

## Escalation
- If blocked for more than 3 attempts, pause and report the issue
- If architectural decision is needed, create an ADR draft in docs/adr/
`,
  });

  // conventions/ (language-specific)
  if (analysis.techStack.languages.includes("TypeScript")) {
    files.push({
      path: "docs/conventions/typescript-style.md",
      content: `# TypeScript Conventions

## General
- Strict mode enabled (see tsconfig.json)
- No \`any\` type. Use \`unknown\` and narrow.
- No \`as\` type assertions without justifying comment.
- Named exports only. No default exports except framework pages.

## Naming
- camelCase for variables, functions, methods
- PascalCase for types, interfaces, classes, components
- UPPER_SNAKE_CASE for constants
- Prefix interfaces with context, not \`I\` (e.g., \`UserRepository\` not \`IUserRepository\`)

## Error Handling
${answers.get("error-handling") ?? "- Use domain-specific error classes"}
- Never swallow errors silently
- Log all unhandled errors with structured logging

## Async
- Prefer async/await over .then() chains
- Always handle promise rejections
- Use AbortController for cancellable operations

## Imports
- Group: external → internal → relative
- No circular imports (enforced by linter)
`,
    });
  }

  // conventions/testing-strategy.md
  if (analysis.techStack.testRunner) {
    files.push({
      path: "docs/conventions/testing-strategy.md",
      content: `# Testing Strategy

## Test Runner
${analysis.techStack.testRunner}

## Principles
- Tests must be deterministic and isolated
- Mock external dependencies (network, DB, filesystem)
- Test behavior, not implementation
- Each test should have a single assertion focus

## Coverage
${answers.get("test-coverage") ?? "[TODO: Define coverage requirements]"}

## Structure
- Unit tests: colocated with source or in __tests__/
- Integration tests: tests/integration/
- E2E tests: ${analysis.commands.e2e ? `\`${analysis.commands.e2e}\`` : "tests/e2e/"}

## Naming
- Describe behavior: \`it("returns 404 when user not found")\`
- Group by module/function: \`describe("UserService")\`
`,
    });
  }

  return files;
}

// ── Sub-directory AGENTS.md ─────────────────────────────────

function generateSubAgentsMd(analysis: ProjectAnalysis): SubAgentsMd[] {
  const subs: SubAgentsMd[] = [];

  if (!analysis.monorepo) return subs;

  for (const pkg of analysis.monorepo.packages) {
    const isApi = /api|server|backend/.test(pkg.name);
    const isWeb = /web|app|frontend|client/.test(pkg.name);
    const isDb = /db|database|prisma/.test(pkg.name);
    const isCore = /core|shared|common|lib/.test(pkg.name);
    const isTypes = /types|schema/.test(pkg.name);

    let content = `# AGENTS.md (${pkg.path}/)\n\n## Scope\n${pkg.description}\n\n## Rules\n`;

    if (isApi) {
      content += `- Every route file exports a framework plugin/handler
- Request/response schemas validated at boundary
- No business logic here; delegate to core/services
- All responses follow consistent envelope format
- Test both success and error paths for every endpoint

## Testing
- Run: \`${analysis.techStack.packageManager ?? "npm"} --filter ${pkg.name} test\`
- Use integration tests with mock external services
`;
    } else if (isWeb) {
      content += `- Components must be pure/functional where possible
- No direct API calls from components; use hooks/services
- Colocate component tests with component files
- Use semantic HTML elements
- Accessibility: all interactive elements must be keyboard navigable

## Testing
- React Testing Library for component tests. No snapshot tests.
- Test user interactions, not implementation details
`;
    } else if (isDb) {
      content += `- All database queries live here as repository functions
- Use parameterized queries only; no string concatenation
- New tables require an ADR in docs/adr/ before creation
- Never edit existing migration files; create new ones

## Migrations
- Migration names: YYYYMMDD_description
- Always test migrations up and down
`;
    } else if (isCore) {
      content += `- Pure business logic only; no framework-specific imports
- No side effects in pure functions
- All public functions must have JSDoc documentation
- Maximum test coverage priority

## Testing
- Unit tests for all public API methods
- Aim for highest coverage in the monorepo
`;
    } else if (isTypes) {
      content += `- Types must be framework-agnostic
- Use branded types for domain identifiers (UserId, OrderId, etc.)
- Export all types via barrel file (index.ts)
- No runtime code in this package; types only
`;
    } else {
      content += `- [TODO: Add package-specific rules]\n`;
    }

    subs.push({ path: `${pkg.path}/AGENTS.md`, content });
  }

  return subs;
}

// ── Default Answers (for fully automated mode) ──────────────

export function getDefaultAnswers(): Map<string, string> {
  return new Map([
    ["mission", "[TODO: Describe your project]"],
    ["core-constraint", "없음"],
    ["non-obvious-patterns", "없음"],
    ["never-boundaries", "기본값만 사용"],
    ["ask-boundaries", "기본값만 사용"],
    ["error-handling", "프로젝트에 맞게 AI가 추천"],
    ["test-coverage", "80% line coverage"],
    ["persona", "페르소나 없음"],
    ["git-conventions", "Conventional Commits (feat/fix/refactor/test/docs/chore)"],
  ]);
}
