import { describe, it, expect } from "vitest";
import {
  classifyTaskComplexity, classifyTaskType, selectModelTier,
  selectModelForRole, buildModelRoutingContext, getModelTiers
} from "../src/orchestration/model-router.js";

describe("Model Router", () => {
  it("classifies trivial tasks", () => {
    expect(classifyTaskComplexity("rename foo to bar")).toBe("trivial");
    expect(classifyTaskComplexity("delete the old file")).toBe("trivial");
  });

  it("classifies simple tasks", () => {
    expect(classifyTaskComplexity("fix the login bug")).toBe("simple");
    expect(classifyTaskComplexity("add a new endpoint")).toBe("simple");
  });

  it("classifies complex tasks", () => {
    expect(classifyTaskComplexity("refactor the entire authentication system")).toBe("complex");
    expect(classifyTaskComplexity("implement a notification system from scratch")).toBe("complex");
  });

  it("classifies architectural tasks", () => {
    expect(classifyTaskComplexity("redesign the database architecture")).toBe("architectural");
    expect(classifyTaskComplexity("migrate from REST to GraphQL")).toBe("architectural");
  });

  it("classifies task types", () => {
    expect(classifyTaskType("add unit test coverage for the calculator")).toBe("test");
    expect(classifyTaskType("add JSDoc comments")).toBe("docs");
    expect(classifyTaskType("debug the crash on login")).toBe("debug");
    expect(classifyTaskType("refactor the api module")).toBe("refactor");
  });

  it("selects model tier by task", () => {
    const trivial = selectModelTier("rename variable x");
    expect(trivial.tier).toBe("fast");

    const debug = selectModelTier("debug the authentication crash");
    expect(debug.tier).toBe("powerful");

    const moderate = selectModelTier("implement a comprehensive user profile feature for the dashboard with multiple screens");
    expect(moderate.tier).toBe("balanced");
  });

  it("selects model by role", () => {
    const planner = selectModelForRole("any task", "planner");
    expect(planner.tier).toBe("balanced");

    const reviewer = selectModelForRole("any task", "reviewer");
    expect(reviewer.tier).toBe("fast");
  });

  it("builds routing context", () => {
    const ctx = buildModelRoutingContext("refactor the auth module");
    expect(ctx).toContain("complexity");
    expect(ctx).toContain("type");
    expect(ctx).toContain("tier");
  });

  it("has all three tiers", () => {
    const tiers = getModelTiers();
    expect(Object.keys(tiers)).toContain("fast");
    expect(Object.keys(tiers)).toContain("balanced");
    expect(Object.keys(tiers)).toContain("powerful");
  });
});
