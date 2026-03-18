import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import { getRoleRegistry, resolveRole, listActiveRoles } from "../src/roles/registry.js";

const ALL_ROLE_IDS = [
  "orchestrator", "planner", "executor", "reviewer", "researcher",
  "repo-mapper", "search-specialist", "lsp-analyst", "ast-rewriter",
  "dependency-analyst", "build-doctor", "test-engineer", "debugger",
  "frontend-engineer", "ux-designer", "accessibility-auditor",
  "api-designer", "docs-writer", "prompt-engineer", "backend-engineer",
  "db-engineer", "security-auditor", "performance-engineer",
  "devops-engineer", "cicd-engineer", "release-manager",
  "observability-engineer", "refactor-specialist", "code-simplifier",
  "migration-engineer", "risk-analyst", "compliance-reviewer",
  "benchmark-analyst", "cost-optimizer", "model-router", "toolsmith",
  "browser-operator", "git-strategist", "issue-triage-agent", "pr-author"
];

describe("role registry", () => {
  it("contains 40 roles with 5 active by default", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    expect(registry).toHaveLength(40);
    expect(registry.filter((role) => role.active)).toHaveLength(5);
  });

  it("maps inactive roles to active fallbacks by category", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    const resolved = resolveRole(registry, "frontend-engineer");
    expect(resolved.active).toBe(true);
    expect(resolved.category).toBe("frontend");
  });

  it("listActiveRoles returns only active roles", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    const active = listActiveRoles(registry);
    expect(active).toHaveLength(5);
    expect(active.every((r) => r.active)).toBe(true);
  });

  it("every role has a non-empty prompt", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    for (const role of registry) {
      expect(role.prompt.length).toBeGreaterThan(0);
      expect(role.prompt).toContain(role.displayName);
    }
  });

  it("every role has at least 'read' in its tool policy", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    for (const role of registry) {
      expect(role.toolPolicy.allowed).toContain("read");
    }
  });

  it("resolves all 40 role IDs without throwing", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    for (const id of ALL_ROLE_IDS) {
      const resolved = resolveRole(registry, id);
      expect(resolved.id).toBe(id);
      expect(resolved.active).toBe(true);
    }
  });

  it("falls back to executor for unknown role", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    const resolved = resolveRole(registry, "totally-unknown-xyz");
    expect(resolved.id).toBe("executor");
  });

  it("normalizes roleHint aliases", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    expect(resolveRole(registry, "ci/cd").id).toBe("cicd-engineer");
    expect(resolveRole(registry, "security").id).toBe("security-auditor");
    expect(resolveRole(registry, "api").id).toBe("api-designer");
    expect(resolveRole(registry, "db").id).toBe("db-engineer");
    expect(resolveRole(registry, "docs").id).toBe("docs-writer");
  });

  describe("category distribution", () => {
    it("has roles in all five categories", () => {
      const registry = getRoleRegistry(createDefaultConfig());
      const categories = new Set(registry.map((r) => r.category));
      expect(categories).toContain("planning");
      expect(categories).toContain("research");
      expect(categories).toContain("execution");
      expect(categories).toContain("frontend");
      expect(categories).toContain("review");
    });
  });

  describe("tool policy overrides", () => {
    const registry = getRoleRegistry(createDefaultConfig());

    it("test-engineer has ast_grep access", () => {
      const role = resolveRole(registry, "test-engineer");
      expect(role.toolPolicy.allowed).toContain("ast_grep");
    });

    it("security-auditor has web_search and ast_grep access", () => {
      const role = resolveRole(registry, "security-auditor");
      expect(role.toolPolicy.allowed).toContain("web_search");
      expect(role.toolPolicy.allowed).toContain("ast_grep");
    });

    it("researcher has web_search and ast_grep access", () => {
      const role = resolveRole(registry, "researcher");
      expect(role.toolPolicy.allowed).toContain("web_search");
      expect(role.toolPolicy.allowed).toContain("ast_grep");
    });

    it("refactor-specialist has ast_grep and lsp access", () => {
      const role = resolveRole(registry, "refactor-specialist");
      expect(role.toolPolicy.allowed).toContain("ast_grep");
      expect(role.toolPolicy.allowed).toContain("lsp_diagnostics");
    });

    it("toolsmith has the broadest tool access", () => {
      const role = resolveRole(registry, "toolsmith");
      expect(role.toolPolicy.allowed).toContain("ast_grep");
      expect(role.toolPolicy.allowed).toContain("web_search");
      expect(role.toolPolicy.allowed).toContain("bash");
      expect(role.toolPolicy.allowed).toContain("git");
    });

    it("browser-operator has browser access but not bash", () => {
      const role = resolveRole(registry, "browser-operator");
      expect(role.toolPolicy.allowed).toContain("browser");
      expect(role.toolPolicy.allowed).not.toContain("bash");
    });

    it("pr-author has git and read but not write", () => {
      const role = resolveRole(registry, "pr-author");
      expect(role.toolPolicy.allowed).toContain("git");
      expect(role.toolPolicy.allowed).toContain("read");
      expect(role.toolPolicy.allowed).not.toContain("write");
    });

    it("compliance-reviewer has read-only access", () => {
      const role = resolveRole(registry, "compliance-reviewer");
      expect(role.toolPolicy.allowed).toContain("read");
      expect(role.toolPolicy.allowed).not.toContain("write");
      expect(role.toolPolicy.allowed).not.toContain("bash");
    });
  });

  describe("execution-grade directives", () => {
    const registry = getRoleRegistry(createDefaultConfig());

    const EXECUTION_GRADE_ROLES = [
      "orchestrator", "planner", "executor", "reviewer", "researcher",
      "build-doctor", "test-engineer", "debugger", "frontend-engineer",
      "security-auditor", "performance-engineer", "devops-engineer",
      "backend-engineer", "db-engineer", "api-designer", "docs-writer",
      "observability-engineer", "refactor-specialist", "dependency-analyst",
      "risk-analyst", "toolsmith", "accessibility-auditor", "browser-operator",
      "pr-author"
    ];

    for (const roleId of EXECUTION_GRADE_ROLES) {
      it(`${roleId} has multi-line directives`, () => {
        const role = resolveRole(registry, roleId);
        // Execution-grade roles should have at least 3 lines in their prompt
        // (name line + description + at least 2 directives + JSON + concise)
        const lines = role.prompt.split("\n").filter((l) => l.trim().length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(5);
      });
    }
  });
});
