import { describe, it, expect } from "vitest";
import {
  createEnforcerState,
  updateEnforcerAfterExecution,
  updateEnforcerAfterReview,
  getEnforcerFollowUp,
  isEnforcerDone
} from "../src/orchestration/enforcer.js";
import { analyzeIntent } from "../src/orchestration/intent-gate.js";
import type { ExecutorArtifact, ReviewResult } from "../src/core/types.js";

function makeExecutionArtifact(overrides: Partial<ExecutorArtifact> = {}): ExecutorArtifact {
  return {
    kind: "execution",
    summary: "Implemented the changes",
    changes: ["Modified src/foo.ts"],
    suggestedCommands: ["npm test"],
    ...overrides
  };
}

function makeReview(verdict: "pass" | "fail", followUp: string[] = []): ReviewResult {
  return {
    verdict,
    summary: verdict === "pass" ? "All good" : "Issues found",
    followUp
  };
}

describe("Enforcer", () => {
  describe("createEnforcerState", () => {
    it("creates a state with execution and review checklist items", () => {
      const intent = analyzeIntent("Do some general work");
      const state = createEnforcerState(intent);
      expect(state.checklist.some((i) => i.id === "execution")).toBe(true);
      expect(state.checklist.some((i) => i.id === "review-pass")).toBe(true);
      expect(state.verdict).toBe("continue");
    });

    it("adds build and test items for fix tasks", () => {
      const intent = analyzeIntent("Fix the broken auth");
      const state = createEnforcerState(intent);
      expect(state.checklist.some((i) => i.id === "build-green")).toBe(true);
      expect(state.checklist.some((i) => i.id === "tests-green")).toBe(true);
    });

    it("adds verification item for high-risk tasks", () => {
      const intent = analyzeIntent("Deploy to production");
      const state = createEnforcerState(intent);
      expect(state.checklist.some((i) => i.id === "verification")).toBe(true);
    });

    it("does not add build item for investigate tasks", () => {
      const intent = analyzeIntent("Investigate why it fails");
      const state = createEnforcerState(intent);
      expect(state.checklist.some((i) => i.id === "build-green")).toBe(false);
    });
  });

  describe("updateEnforcerAfterExecution", () => {
    it("marks execution as satisfied", () => {
      const intent = analyzeIntent("Do some general work");
      const state = createEnforcerState(intent);
      const updated = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      expect(updated.checklist.find((i) => i.id === "execution")?.satisfied).toBe(true);
      expect(updated.executionRounds).toBe(1);
    });

    it("detects build success in output", () => {
      const intent = analyzeIntent("Fix the broken build");
      const state = createEnforcerState(intent);
      const updated = updateEnforcerAfterExecution(
        state,
        makeExecutionArtifact({ summary: "Build passes after the fix" })
      );
      expect(updated.checklist.find((i) => i.id === "build-green")?.satisfied).toBe(true);
    });

    it("detects test success in output", () => {
      const intent = analyzeIntent("Fix the broken test");
      const state = createEnforcerState(intent);
      const updated = updateEnforcerAfterExecution(
        state,
        makeExecutionArtifact({ summary: "Tests pass now, all 24 passing" })
      );
      expect(updated.checklist.find((i) => i.id === "tests-green")?.satisfied).toBe(true);
    });
  });

  describe("updateEnforcerAfterReview", () => {
    it("marks review as satisfied on pass", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      expect(state.checklist.find((i) => i.id === "review-pass")?.satisfied).toBe(true);
    });

    it("un-satisfies review on fail", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      state = updateEnforcerAfterReview(state, makeReview("fail", ["Fix the edge case"]));
      expect(state.checklist.find((i) => i.id === "review-pass")?.satisfied).toBe(false);
    });
  });

  describe("isEnforcerDone", () => {
    it("returns true when all items satisfied", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      expect(isEnforcerDone(state)).toBe(true);
      expect(state.verdict).toBe("done");
    });

    it("returns false when work remains", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("fail"));
      expect(isEnforcerDone(state)).toBe(false);
      expect(state.verdict).toBe("continue");
    });

    it("force-stops after max rounds", () => {
      const intent = analyzeIntent("Fix the bug");
      let state = createEnforcerState(intent, { maxRounds: 2 });
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("fail"));
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("fail"));
      expect(isEnforcerDone(state)).toBe(true);
      expect(state.verdict).toBe("force-stop");
    });
  });

  describe("mock provider compatibility", () => {
    it("satisfies build-green when review passes and execution suggests build", () => {
      const intent = analyzeIntent("Fix the broken build");
      let state = createEnforcerState(intent);

      // Mock execution with suggestedCommands that include build
      state = updateEnforcerAfterExecution(
        state,
        makeExecutionArtifact({ suggestedCommands: ["npm run build", "npm test"] })
      );

      // build-green not yet satisfied (no explicit "build passes" in summary)
      expect(state.checklist.find((i) => i.id === "build-green")?.satisfied).toBe(false);
      // but buildIntended should be true
      expect(state.buildIntended).toBe(true);
      expect(state.testIntended).toBe(true);

      // When review passes, build-green and tests-green auto-satisfy
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      expect(state.checklist.find((i) => i.id === "build-green")?.satisfied).toBe(true);
      expect(state.checklist.find((i) => i.id === "tests-green")?.satisfied).toBe(true);
      expect(isEnforcerDone(state)).toBe(true);
    });

    it("does not auto-satisfy build-green when review fails", () => {
      const intent = analyzeIntent("Fix the broken build");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(
        state,
        makeExecutionArtifact({ suggestedCommands: ["npm run build"] })
      );
      state = updateEnforcerAfterReview(state, makeReview("fail", ["Still broken"]));
      expect(state.checklist.find((i) => i.id === "build-green")?.satisfied).toBe(false);
      expect(isEnforcerDone(state)).toBe(false);
    });

    it("generic mock execution with review pass completes for general tasks", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      // Generic mock execution (no build/test suggested)
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      // General tasks don't require build-green or tests-green
      expect(isEnforcerDone(state)).toBe(true);
    });
  });

  describe("getEnforcerFollowUp", () => {
    it("returns outstanding items", () => {
      const intent = analyzeIntent("Fix the broken build");
      const state = createEnforcerState(intent);
      const followUp = getEnforcerFollowUp(state);
      expect(followUp.length).toBeGreaterThan(0);
      expect(followUp.some((f) => f.includes("execution"))).toBe(true);
    });

    it("returns empty when all satisfied", () => {
      const intent = analyzeIntent("Do some general work");
      let state = createEnforcerState(intent);
      state = updateEnforcerAfterExecution(state, makeExecutionArtifact());
      state = updateEnforcerAfterReview(state, makeReview("pass"));
      expect(getEnforcerFollowUp(state)).toHaveLength(0);
    });
  });
});
