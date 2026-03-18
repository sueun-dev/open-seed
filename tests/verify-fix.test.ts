import { describe, it, expect } from "vitest";
import {
  createVerifyFixState, shouldContinueVerifyFix,
  parseVerifyOutput, updateVerifyFixState,
  buildVerifyFixPrompt, getVerificationCommands
} from "../src/orchestration/verify-fix.js";

describe("Verify-Fix Loop", () => {
  it("creates initial state", () => {
    const state = createVerifyFixState();
    expect(state.iteration).toBe(0);
    expect(state.maxIterations).toBe(5);
    expect(shouldContinueVerifyFix(state)).toBe(true);
  });

  it("stops after max iterations", () => {
    const state = createVerifyFixState(2);
    state.iteration = 2;
    state.lastResult = { passed: false, issues: [], outputs: [] };
    expect(shouldContinueVerifyFix(state)).toBe(false);
  });

  it("stops when all pass", () => {
    const state = createVerifyFixState();
    state.lastResult = { passed: true, issues: [], outputs: [] };
    expect(shouldContinueVerifyFix(state)).toBe(false);
  });

  it("parses test failures", () => {
    const result = parseVerifyOutput([{
      command: "npm test",
      exitCode: 1,
      stdout: "FAIL src/calc.test.ts\n  ✕ add returns sum",
      stderr: ""
    }]);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.type === "test_failure")).toBe(true);
  });

  it("parses TypeScript errors", () => {
    const result = parseVerifyOutput([{
      command: "npx tsc --noEmit",
      exitCode: 1,
      stdout: "",
      stderr: "src/calc.ts(5,3): error TS2322: Type 'string' is not assignable to type 'number'."
    }]);
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.type === "type_error")).toBe(true);
    expect(result.issues[0].file).toBe("src/calc.ts");
  });

  it("detects persistent issues", () => {
    let state = createVerifyFixState();
    const issue = { id: "type_error:src/a.ts:Missing type", type: "type_error" as const, message: "Missing type", file: "src/a.ts", seenCount: 1 };

    for (let i = 0; i < 3; i++) {
      state = updateVerifyFixState(state, { passed: false, issues: [issue], outputs: [] });
    }

    expect(state.persistentIssues.length).toBe(1);
    expect(state.iteration).toBe(3);
  });

  it("escalates after too many persistent issues", () => {
    let state = createVerifyFixState();
    const issues = [
      { id: "a", type: "type_error" as const, message: "A", seenCount: 1 },
      { id: "b", type: "type_error" as const, message: "B", seenCount: 1 },
      { id: "c", type: "type_error" as const, message: "C", seenCount: 1 }
    ];

    for (let i = 0; i < 3; i++) {
      state = updateVerifyFixState(state, { passed: false, issues, outputs: [] });
    }

    expect(state.escalated).toBe(true);
    expect(shouldContinueVerifyFix(state)).toBe(false);
  });

  it("builds fix prompt with persistent warnings", () => {
    let state = createVerifyFixState();
    const issue = { id: "err:src/x.ts:fail", type: "build_error" as const, message: "fail", file: "src/x.ts", seenCount: 1 };
    state = updateVerifyFixState(state, { passed: false, issues: [issue], outputs: [] });
    state = updateVerifyFixState(state, { passed: false, issues: [issue], outputs: [] });
    state = updateVerifyFixState(state, { passed: false, issues: [issue], outputs: [] });

    const prompt = buildVerifyFixPrompt({ passed: false, issues: [issue], outputs: [] }, state);
    expect(prompt).toContain("PERSISTENT");
    expect(prompt).toContain("different approach");
  });

  it("returns verification commands", () => {
    const cmds = getVerificationCommands("npm run build", "npm test");
    expect(cmds).toContain("npm run build");
    expect(cmds).toContain("npm test");
  });

  it("uses defaults when no learned commands", () => {
    const cmds = getVerificationCommands();
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]).toContain("tsc");
  });
});
