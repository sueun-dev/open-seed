import { describe, expect, it } from "vitest";

import type { PlannerTask, SecurityArtifact, TestArtifact } from "../src/core/types.js";
import { createDefaultConfig } from "../src/core/config.js";
import {
  augmentPlannerTasks,
  buildDelegationPrompt,
  createDelegationNote,
  selectDelegationAssignments,
  summarizeDelegationArtifacts
} from "../src/orchestration/delegation.js";
import { getRoleRegistry } from "../src/roles/registry.js";

describe("delegation scheduler", () => {
  it("maps planned tasks to specialist roles and deduplicates role usage", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    const tasks: PlannerTask[] = [
      { id: "build", title: "Unblock the build and typecheck path", category: "execution" },
      { id: "tests", title: "Add verification coverage and run the relevant tests", category: "execution" },
      { id: "docs", title: "Update the docs and summarize the user-facing behavior", category: "planning" },
      { id: "tests-2", title: "Add more tests for the regression", category: "execution" }
    ];

    const assignments = selectDelegationAssignments({
      tasks,
      registry,
      limit: 4
    });

    expect(assignments.map((assignment) => assignment.role.id)).toEqual([
      "build-doctor",
      "test-engineer",
      "docs-writer"
    ]);
  });

  it("augments planner tasks from the root task when specialist intent is obvious", () => {
    const tasks: PlannerTask[] = [
      { id: "implement", title: "Implement the required change safely", category: "execution" }
    ];

    const augmented = augmentPlannerTasks(
      "Harden auth security, improve performance and observability, update CI, and prepare a PR summary",
      tasks
    );

    expect(augmented.map((task) => task.roleHint)).toEqual(
      expect.arrayContaining([
        "security-auditor",
        "performance-engineer",
        "observability-engineer",
        "cicd-engineer",
        "pr-author"
      ])
    );
  });

  it("uses role-specific delegation contracts and merge summaries", () => {
    const registry = getRoleRegistry(createDefaultConfig());
    const securityAssignment = selectDelegationAssignments({
      tasks: [{ id: "security", title: "Audit auth, token, and security boundaries", category: "research", roleHint: "security-auditor" }],
      registry,
      limit: 1
    })[0];
    const testAssignment = selectDelegationAssignments({
      tasks: [{ id: "tests", title: "Add verification coverage and run the relevant tests", category: "execution", roleHint: "test-engineer" }],
      registry,
      limit: 1
    })[0];

    const prompt = buildDelegationPrompt({
      rootTask: "Harden auth security and add tests",
      assignment: securityAssignment,
      plannerSummary: "Split the work by specialist ownership.",
      researchSummary: "Auth changes need explicit regression coverage.",
      context: "Root AGENTS context",
      repoSummary: "src/index.ts [typescript] symbols=value"
    });

    const securityArtifact: SecurityArtifact = {
      kind: "security-review",
      summary: "Reviewed the auth boundary.",
      findings: ["Token flow crosses a privileged boundary"],
      risks: ["Secrets could leak through permissive logging"],
      controls: ["Mask secrets in logs", "Validate auth scope before mutation"],
      verification: ["Exercise the auth failure path"]
    };
    const testArtifact: TestArtifact = {
      kind: "test-plan",
      summary: "Defined the verification loop.",
      coverage: ["Add a regression test for invalid auth scope"],
      scenarios: ["Cover the success path", "Cover the denied path"],
      verification: ["Run npm test"],
      suggestedCommands: ["npm test"],
      toolCalls: []
    };

    const summary = summarizeDelegationArtifacts([
      {
        assignment: securityAssignment,
        artifact: securityArtifact,
        note: createDelegationNote({ assignment: securityAssignment, artifact: securityArtifact })
      },
      {
        assignment: testAssignment,
        artifact: testArtifact,
        note: createDelegationNote({ assignment: testAssignment, artifact: testArtifact })
      }
    ]);

    expect(prompt).toContain("\"kind\":\"security-review\"");
    expect(summary).toContain("[security-review]");
    expect(summary).toContain("Risk controls:");
    expect(summary).toContain("Verification guidance:");
    expect(summary).toContain("Mask secrets in logs");
    expect(summary).toContain("Run npm test");
  });
});
