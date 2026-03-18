import { describe, it, expect } from "vitest";
import {
  createRalphState, transitionRalph, isRalphDone,
  createPRD, getNextStory, markStoryDone, markStoryFailed, markStoryInProgress, getPRDProgress,
  learnFromToolOutput, buildLearnedContext,
  buildVerifyPrompt, buildFixPrompt, buildPRDPrompt
} from "../src/orchestration/ralph.js";

describe("RALPH Loop", () => {
  it("creates initial state", () => {
    const state = createRalphState();
    expect(state.phase).toBe("idle");
    expect(state.iteration).toBe(0);
    expect(state.maxIterations).toBe(10);
  });

  it("transitions through valid phases", () => {
    let s = createRalphState();
    s = transitionRalph(s, "planning");
    expect(s.phase).toBe("planning");
    s = transitionRalph(s, "prd");
    expect(s.phase).toBe("prd");
    s = transitionRalph(s, "executing");
    expect(s.phase).toBe("executing");
    expect(s.iteration).toBe(1);
    s = transitionRalph(s, "verifying");
    expect(s.phase).toBe("verifying");
    s = transitionRalph(s, "complete");
    expect(s.phase).toBe("complete");
  });

  it("rejects invalid transitions", () => {
    const s = createRalphState();
    expect(() => transitionRalph(s, "executing")).toThrow("Invalid RALPH transition");
  });

  it("detects done when all stories complete", () => {
    const prd = createPRD("Test", "Obj", [{ title: "S1", description: "D1" }]);
    const state = createRalphState();
    state.prd = markStoryDone(prd, "story_1");
    expect(isRalphDone(state)).toBe(true);
  });

  it("detects done when max iterations reached", () => {
    const state = createRalphState({ maxIterations: 3 });
    state.iteration = 3;
    expect(isRalphDone(state)).toBe(true);
  });
});

describe("PRD Management", () => {
  it("creates PRD with stories", () => {
    const prd = createPRD("Calculator", "Build calc", [
      { title: "Add function", description: "Implement add(a,b)" },
      { title: "Tests", description: "Write unit tests" }
    ]);
    expect(prd.stories.length).toBe(2);
    expect(prd.stories[0].status).toBe("pending");
  });

  it("gets next pending story", () => {
    const prd = createPRD("Test", "Obj", [
      { title: "S1", description: "D1" },
      { title: "S2", description: "D2" }
    ]);
    const next = getNextStory(prd);
    expect(next?.id).toBe("story_1");
  });

  it("tracks progress correctly", () => {
    let prd = createPRD("Test", "Obj", [
      { title: "S1", description: "D1" },
      { title: "S2", description: "D2" },
      { title: "S3", description: "D3" }
    ]);
    prd = markStoryDone(prd, "story_1");
    prd = markStoryFailed(prd, "story_2", "Build failed");

    const progress = getPRDProgress(prd);
    expect(progress.done).toBe(1);
    expect(progress.blocked).toBe(1);
    expect(progress.total).toBe(3);
    expect(progress.percent).toBe(33);
  });

  it("marks stories in progress with attempt tracking", () => {
    let prd = createPRD("Test", "Obj", [{ title: "S1", description: "D1" }]);
    prd = markStoryInProgress(prd, "story_1");
    expect(prd.stories[0].status).toBe("in_progress");
    expect(prd.stories[0].attempts).toBe(1);
    prd = markStoryInProgress(prd, "story_1");
    expect(prd.stories[0].attempts).toBe(2);
  });
});

describe("Pattern Learning", () => {
  it("learns build commands from bash output", () => {
    const patterns = learnFromToolOutput([], "bash", "npm run build\nCompiled successfully");
    expect(patterns.some(p => p.type === "build_command")).toBe(true);
  });

  it("learns test commands", () => {
    const patterns = learnFromToolOutput([], "bash", "npm test\n5 tests passed");
    expect(patterns.some(p => p.type === "test_command")).toBe(true);
  });

  it("learns common errors", () => {
    const patterns = learnFromToolOutput([], "bash", "Cannot find module 'lodash'");
    expect(patterns.some(p => p.type === "common_error")).toBe(true);
  });

  it("accumulates occurrences", () => {
    let patterns = learnFromToolOutput([], "bash", "npm run build");
    patterns = learnFromToolOutput(patterns, "bash", "npm run build");
    const build = patterns.find(p => p.type === "build_command");
    expect(build?.occurrences).toBe(2);
    expect(build!.confidence).toBeGreaterThan(0.5);
  });

  it("builds context string", () => {
    let patterns = learnFromToolOutput([], "bash", "npm run build");
    patterns = learnFromToolOutput(patterns, "bash", "npm test");
    const ctx = buildLearnedContext(patterns);
    expect(ctx).toContain("Build:");
    expect(ctx).toContain("Test:");
  });
});

describe("Prompts", () => {
  it("builds verify prompt", () => {
    const story = { id: "s1", title: "Add calc", description: "Implement add", status: "in_progress" as const, attempts: 1 };
    const prompt = buildVerifyPrompt(story, "Created src/calc.ts with add function");
    expect(prompt).toContain("Add calc");
    expect(prompt).toContain("Architect Verifier");
  });

  it("builds fix prompt", () => {
    const story = { id: "s1", title: "Fix bug", description: "Fix", status: "in_progress" as const, attempts: 2 };
    const prompt = buildFixPrompt(story, ["Test failed", "Missing import"]);
    expect(prompt).toContain("Test failed");
    expect(prompt).toContain("Missing import");
  });

  it("builds PRD prompt", () => {
    const prompt = buildPRDPrompt("Build a calculator", "src/index.ts [typescript]");
    expect(prompt).toContain("Product Requirements Document");
    expect(prompt).toContain("calculator");
  });
});
