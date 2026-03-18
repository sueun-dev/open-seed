import { describe, it, expect } from "vitest";
import { StuckDetector } from "../src/orchestration/stuck-detector.js";

describe("StuckDetector", () => {
  it("detects consecutive failures", () => {
    const detector = new StuckDetector({ maxConsecutiveFailures: 3 });
    detector.recordRound(1, "fail", "error in module A");
    detector.recordRound(2, "fail", "error in module B");
    expect(detector.isStuck()).toBe(false);
    detector.recordRound(3, "fail", "error in module C");
    expect(detector.isStuck()).toBe(true);
    expect(detector.getStuckReason()).toContain("consecutive review failures");
  });

  it("detects repeated identical summaries (monologue)", () => {
    const detector = new StuckDetector({ maxRepeatedSummaries: 3 });
    detector.recordRound(1, "pass", "same output");
    detector.recordRound(2, "fail", "same output");
    expect(detector.isStuck()).toBe(false);
    detector.recordRound(3, "pass", "same output");
    expect(detector.isStuck()).toBe(true);
    expect(detector.getStuckReason()).toContain("monologue loop");
  });

  it("detects alternating verdict pattern", () => {
    const detector = new StuckDetector({ windowSize: 6 });
    detector.recordRound(1, "pass", "output A");
    detector.recordRound(2, "fail", "output B");
    detector.recordRound(3, "pass", "output C");
    detector.recordRound(4, "fail", "output D");
    detector.recordRound(5, "pass", "output E");
    expect(detector.isStuck()).toBe(false);
    detector.recordRound(6, "fail", "output F");
    expect(detector.isStuck()).toBe(true);
    expect(detector.getStuckReason()).toContain("oscillating");
  });

  it("returns not stuck for normal execution", () => {
    const detector = new StuckDetector();
    detector.recordRound(1, "fail", "first attempt");
    detector.recordRound(2, "fail", "second attempt");
    detector.recordRound(3, "pass", "fixed it");
    expect(detector.isStuck()).toBe(false);
  });

  it("resets state correctly", () => {
    const detector = new StuckDetector({ maxConsecutiveFailures: 2 });
    detector.recordRound(1, "fail", "error");
    detector.recordRound(2, "fail", "error");
    expect(detector.isStuck()).toBe(true);
    detector.reset();
    expect(detector.isStuck()).toBe(false);
    expect(detector.getRounds()).toHaveLength(0);
  });
});
