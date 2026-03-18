import { describe, it, expect } from "vitest";
import { CostTracker } from "../src/orchestration/cost-tracker.js";

describe("Cost Tracker", () => {
  it("records entries and computes summary", () => {
    const tracker = new CostTracker();
    tracker.record({
      taskId: "t1",
      roleId: "planner",
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 1000, outputTokens: 500 }
    });
    tracker.record({
      taskId: "t2",
      roleId: "executor",
      providerId: "openai",
      model: "gpt-5.4",
      usage: { inputTokens: 2000, outputTokens: 1000 }
    });

    const summary = tracker.getSummary();
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.entries).toBe(2);
    expect(summary.byProvider["anthropic"]).toBeDefined();
    expect(summary.byProvider["openai"]).toBeDefined();
    expect(summary.byRole["planner"]).toBeDefined();
    expect(summary.totalEstimatedCostUsd).toBeGreaterThan(0);
  });

  it("tracks budget and detects overspend", () => {
    const tracker = new CostTracker();
    tracker.setBudget(0.001); // very small budget
    expect(tracker.isOverBudget()).toBe(false);

    tracker.record({
      taskId: "t1",
      roleId: "executor",
      providerId: "openai",
      model: "gpt-5.4",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 }
    });

    expect(tracker.isOverBudget()).toBe(true);
    expect(tracker.getRemainingBudgetUsd()).toBe(0);
  });

  it("returns null remaining when no budget set", () => {
    const tracker = new CostTracker();
    expect(tracker.getRemainingBudgetUsd()).toBeNull();
    expect(tracker.isOverBudget()).toBe(false);
  });
});
