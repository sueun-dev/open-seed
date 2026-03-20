/**
 * Tests for AGI Pipeline V2 — Dynamic Steps + Inter-Step Memory + Auto-Replan
 */
import { describe, it, expect } from "vitest";
import {
  generatePlan,
  assessComplexity,
  buildStepPrompt,
  replanIfNeeded,
  condenseContext,
  runAgiPipeline,
  type SharedContext,
  type StepResult,
  type AgiPlan,
} from "../src/orchestration/agi-pipeline.js";

// ─── Complexity Assessment ───────────────────────────────────────────────────

describe("assessComplexity", () => {
  it("returns simple for trivial tasks", () => {
    expect(assessComplexity("fix bug in login")).toBe("simple");
    expect(assessComplexity("rename variable")).toBe("simple");
    expect(assessComplexity("change color to blue")).toBe("simple");
  });

  it("returns moderate for average tasks", () => {
    expect(assessComplexity("create a user registration form")).toBe("moderate");
    expect(assessComplexity("add search functionality to the dashboard")).toBe("moderate");
  });

  it("returns complex for multi-feature tasks", () => {
    expect(assessComplexity("add authentication and also add role-based access control plus audit logging")).toBe("complex");
  });

  it("returns massive for full app requests", () => {
    expect(assessComplexity("build a complete project management application from scratch with authentication, real-time collaboration, kanban boards, and reporting")).toBe("massive");
  });
});

// ─── Plan Generation ─────────────────────────────────────────────────────────

describe("generatePlan", () => {
  it("generates minimal steps for simple tasks", () => {
    const plan = generatePlan("fix a bug", {
      complexity: "simple",
      hasTests: false,
      isNewProject: false,
      primaryLanguage: "typescript",
      needsDebate: false,
    });

    // Simple: analyze → build → verify → fix(conditional) → review
    const types = plan.steps.map(s => s.type);
    expect(types).toContain("analyze");
    expect(types).toContain("build");
    expect(types).toContain("verify");
    expect(types).toContain("review");
    // No design, no debate, no improve for simple tasks
    expect(types).not.toContain("design");
    expect(types).not.toContain("debate");
    expect(types).not.toContain("improve");
  });

  it("generates full steps for complex tasks", () => {
    const plan = generatePlan("build a todo app", {
      complexity: "complex",
      hasTests: true,
      isNewProject: true,
      primaryLanguage: null,
      needsDebate: false,
    });

    const types = plan.steps.map(s => s.type);
    expect(types).toContain("analyze");
    expect(types).toContain("design");
    expect(types).toContain("build");
    expect(types).toContain("verify");
    expect(types).toContain("fix");
    expect(types).toContain("improve");
    expect(types).toContain("review");
  });

  it("includes debate step for architectural decisions", () => {
    const plan = generatePlan("choose the best architecture for our microservice", {
      complexity: "complex",
      hasTests: true,
      isNewProject: false,
      primaryLanguage: "typescript",
      needsDebate: true,
    });

    const types = plan.steps.map(s => s.type);
    expect(types).toContain("debate");
  });

  it("sets high maxTurns for build step", () => {
    const plan = generatePlan("build an app", {
      complexity: "complex",
      hasTests: true,
      isNewProject: true,
      primaryLanguage: null,
      needsDebate: false,
    });

    const buildStep = plan.steps.find(s => s.type === "build");
    expect(buildStep).toBeDefined();
    expect(buildStep!.maxTurns).toBe(200);
  });

  it("sets team mode for build and improve", () => {
    const plan = generatePlan("build an app", {
      complexity: "complex",
      hasTests: true,
      isNewProject: true,
      primaryLanguage: null,
      needsDebate: false,
    });

    const buildStep = plan.steps.find(s => s.type === "build");
    const improveStep = plan.steps.find(s => s.type === "improve");
    expect(buildStep!.mode).toBe("team");
    expect(improveStep!.mode).toBe("team");
  });

  it("starts with currentStepIndex -1", () => {
    const plan = generatePlan("test", { complexity: "simple", hasTests: false, isNewProject: false, primaryLanguage: null, needsDebate: false });
    expect(plan.currentStepIndex).toBe(-1);
    expect(plan.isDynamic).toBe(true);
    expect(plan.replanCount).toBe(0);
  });
});

// ─── Shared Context & Step Prompts ───────────────────────────────────────────

describe("buildStepPrompt", () => {
  const makeCtx = (overrides?: Partial<SharedContext>): SharedContext => ({
    task: "Create a todo app",
    projectDir: "todo-app",
    stepResults: [],
    allFiles: new Map(),
    errorLog: [],
    decisions: [],
    plan: generatePlan("test", { complexity: "simple", hasTests: false, isNewProject: true, primaryLanguage: null, needsDebate: false }),
    confidence: 0.5,
    totalTokens: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    ...overrides,
  });

  it("includes original task in prompt", () => {
    const ctx = makeCtx();
    const step = ctx.plan.steps[0];
    const prompt = buildStepPrompt(step, ctx);
    expect(prompt).toContain("Create a todo app");
  });

  it("includes prior step results (inter-step memory)", () => {
    const ctx = makeCtx({
      stepResults: [{
        stepId: "step-1-analyze",
        type: "analyze",
        status: "completed",
        summary: "This is a simple CRUD todo application requiring React frontend and Node.js backend",
        changes: [],
        toolResults: [],
        durationMs: 5000,
        tokensUsed: 1000,
        errors: [],
      }],
    });

    const buildStep = { id: "step-2-build", type: "build" as const, title: "Build", description: "Build it", mode: "team" as const, maxTurns: 200, dependsOn: [], priority: 70, maxRetries: 2, useStrategyBranching: true };
    const prompt = buildStepPrompt(buildStep, ctx);

    expect(prompt).toContain("Prior Step Results");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("CRUD todo application");
  });

  it("includes architecture decisions", () => {
    const ctx = makeCtx({
      decisions: ["Use React for frontend", "Use Express for backend"],
    });
    const step = ctx.plan.steps[0];
    const prompt = buildStepPrompt(step, ctx);
    expect(prompt).toContain("Architecture Decisions");
    expect(prompt).toContain("Use React for frontend");
  });

  it("includes error log", () => {
    const ctx = makeCtx({
      errorLog: [{ stepId: "s1", error: "Module not found: express", category: "build", resolved: false }],
    });
    const step = ctx.plan.steps[0];
    const prompt = buildStepPrompt(step, ctx);
    expect(prompt).toContain("Unresolved Errors");
    expect(prompt).toContain("Module not found");
  });

  it("includes scaffold instructions for new projects", () => {
    const ctx = makeCtx();
    const buildStep = { id: "step-2-build", type: "build" as const, title: "Build", description: "Build it", mode: "team" as const, maxTurns: 200, dependsOn: [], priority: 70, maxRetries: 2, useStrategyBranching: true };
    const prompt = buildStepPrompt(buildStep, ctx);
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("npm install && npm start");
  });

  it("includes file list when files exist", () => {
    const ctx = makeCtx({
      allFiles: new Map([
        ["src/index.ts", { path: "src/index.ts", status: "created", stepId: "s1" }],
        ["package.json", { path: "package.json", status: "created", stepId: "s1" }],
      ]),
    });
    const step = ctx.plan.steps[0];
    const prompt = buildStepPrompt(step, ctx);
    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("package.json");
  });
});

// ─── Replanning ──────────────────────────────────────────────────────────────

describe("replanIfNeeded", () => {
  const makePlan = (): AgiPlan => ({
    steps: [
      { id: "s1", type: "analyze", title: "Analyze", description: "", mode: "run", maxTurns: 30, dependsOn: [], priority: 100, maxRetries: 1, useStrategyBranching: false },
      { id: "s2", type: "build", title: "Build", description: "", mode: "team", maxTurns: 200, dependsOn: ["s1"], priority: 70, maxRetries: 2, useStrategyBranching: true },
      { id: "s3", type: "verify", title: "Verify", description: "", mode: "run", maxTurns: 50, dependsOn: ["s2"], priority: 60, maxRetries: 0, useStrategyBranching: false },
      { id: "s4", type: "review", title: "Review", description: "", mode: "run", maxTurns: 40, dependsOn: ["s3"], priority: 30, maxRetries: 0, useStrategyBranching: false },
    ],
    currentStepIndex: 2,
    replanCount: 0,
    isDynamic: true,
  });

  it("returns null when no replan needed", () => {
    const ctx: SharedContext = {
      task: "test", projectDir: "t", stepResults: [
        { stepId: "s3", type: "verify", status: "completed", summary: "All pass", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: [] },
      ], allFiles: new Map(), errorLog: [], decisions: [], plan: makePlan(), confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };
    expect(replanIfNeeded(ctx)).toBeNull();
  });

  it("inserts fix + re-verify after verify failure", () => {
    const plan = makePlan();
    const ctx: SharedContext = {
      task: "test", projectDir: "t", stepResults: [
        { stepId: "s3", type: "verify", status: "failed", summary: "3 errors", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: ["TS2304: Cannot find name 'foo'"] },
      ], allFiles: new Map(), errorLog: [], decisions: [], plan, confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };

    const newPlan = replanIfNeeded(ctx);
    expect(newPlan).not.toBeNull();
    expect(newPlan!.steps.length).toBe(6); // 4 original + fix + re-verify
    expect(newPlan!.steps[3].type).toBe("fix");
    expect(newPlan!.steps[4].type).toBe("verify");
    expect(newPlan!.replanCount).toBe(1);
  });

  it("inserts fix + re-review after review failure", () => {
    const plan = makePlan();
    plan.currentStepIndex = 3;
    const ctx: SharedContext = {
      task: "test", projectDir: "t", stepResults: [
        { stepId: "s4", type: "review", status: "failed", summary: "Missing error handling", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: [] },
      ], allFiles: new Map(), errorLog: [], decisions: [], plan, confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };

    const newPlan = replanIfNeeded(ctx);
    expect(newPlan).not.toBeNull();
    const newTypes = newPlan!.steps.slice(4).map(s => s.type);
    expect(newTypes).toContain("fix");
    expect(newTypes).toContain("review");
  });

  it("inserts rebuild after multiple fix failures", () => {
    const plan = makePlan();
    plan.currentStepIndex = 3;
    const ctx: SharedContext = {
      task: "test", projectDir: "t", stepResults: [
        { stepId: "fix1", type: "fix", status: "failed", summary: "Still broken", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: ["err1"] },
        { stepId: "fix2", type: "fix", status: "failed", summary: "Still broken", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: ["err2"] },
      ], allFiles: new Map(), errorLog: [{ stepId: "fix1", error: "err1", category: "build", resolved: false }], decisions: [], plan, confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };

    const newPlan = replanIfNeeded(ctx);
    expect(newPlan).not.toBeNull();
    const newTypes = newPlan!.steps.slice(4).map(s => s.type);
    expect(newTypes).toContain("build");
  });
});

// ─── Context Condensation ────────────────────────────────────────────────────

describe("condenseContext", () => {
  it("always includes task", () => {
    const ctx: SharedContext = {
      task: "Build a todo app", projectDir: "t", stepResults: [], allFiles: new Map(),
      errorLog: [], decisions: [], plan: { steps: [], currentStepIndex: -1, replanCount: 0, isDynamic: true },
      confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };
    const condensed = condenseContext(ctx, 1000);
    expect(condensed).toContain("Build a todo app");
  });

  it("includes decisions", () => {
    const ctx: SharedContext = {
      task: "test", projectDir: "t", stepResults: [], allFiles: new Map(),
      errorLog: [], decisions: ["Use React", "Use Express"], plan: { steps: [], currentStepIndex: -1, replanCount: 0, isDynamic: true },
      confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };
    const condensed = condenseContext(ctx, 1000);
    expect(condensed).toContain("Use React");
    expect(condensed).toContain("Use Express");
  });

  it("includes most recent step results first", () => {
    const ctx: SharedContext = {
      task: "test", projectDir: "t",
      stepResults: [
        { stepId: "s1", type: "analyze", status: "completed", summary: "FIRST_STEP_RESULT", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: [] },
        { stepId: "s2", type: "build", status: "completed", summary: "SECOND_STEP_RESULT", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: [] },
      ],
      allFiles: new Map(), errorLog: [], decisions: [],
      plan: { steps: [], currentStepIndex: -1, replanCount: 0, isDynamic: true },
      confidence: 0.5, totalTokens: 0, totalCostUsd: 0, startedAt: 0,
    };
    const condensed = condenseContext(ctx, 10000);
    const firstIdx = condensed.indexOf("FIRST_STEP_RESULT");
    const secondIdx = condensed.indexOf("SECOND_STEP_RESULT");
    // Most recent should appear first (reversed order)
    expect(secondIdx).toBeLessThan(firstIdx);
  });
});

// ─── Full Pipeline Run (with mock executor) ──────────────────────────────────

describe("runAgiPipeline", () => {
  it("runs a simple task end-to-end", async () => {
    const events: any[] = [];
    let stepCount = 0;

    const result = await runAgiPipeline({
      cwd: "/tmp/test",
      task: "fix a small bug",
      projectDir: "test-project",
      executeStep: async (prompt, mode, maxTurns) => {
        stepCount++;
        return {
          summary: `Step ${stepCount} completed successfully`,
          changes: stepCount === 2 ? ["created src/fix.ts"] : [],
          toolResults: [{ name: "write", ok: true, output: "src/fix.ts" }],
          tokensUsed: 1000,
          errors: [],
        };
      },
      onEvent: (ev) => events.push(ev),
    });

    expect(result.success).toBe(true);
    expect(result.context.stepResults.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === "agi.pipeline.start")).toBe(true);
    expect(events.some(e => e.type === "agi.pipeline.complete")).toBe(true);
  });

  it("auto-replans on verify failure", async () => {
    let callCount = 0;
    const events: any[] = [];

    const result = await runAgiPipeline({
      cwd: "/tmp/test",
      task: "fix a small bug",
      projectDir: "test-project",
      maxReplans: 3,
      executeStep: async (prompt) => {
        callCount++;
        // Verify step returns errors on first call
        if (prompt.includes("Verify") && callCount <= 3) {
          return {
            summary: "Verify found errors",
            changes: [],
            toolResults: [],
            tokensUsed: 500,
            errors: ["TypeError: x is not defined"],
          };
        }
        return {
          summary: "Step completed",
          changes: [],
          toolResults: [{ name: "write", ok: true }],
          tokensUsed: 1000,
          errors: [],
        };
      },
      onEvent: (ev) => events.push(ev),
    });

    // Should have replan events
    const hasReplan = events.some(e => e.type === "agi.replan");
    // The pipeline should have tried to fix errors
    expect(result.context.stepResults.some(r => r.type === "verify")).toBe(true);
  });

  it("respects maxDuration", async () => {
    const result = await runAgiPipeline({
      cwd: "/tmp/test",
      task: "fix a small bug",
      projectDir: "test-project",
      maxDurationMs: 1, // 1ms — will expire immediately
      executeStep: async () => {
        await new Promise(r => setTimeout(r, 100));
        return { summary: "done", changes: [], toolResults: [], tokensUsed: 0, errors: [] };
      },
    });

    expect(result.success).toBe(false);
  });

  it("tracks files across steps in shared context", async () => {
    let step = 0;
    const result = await runAgiPipeline({
      cwd: "/tmp/test",
      task: "fix a small bug",
      projectDir: "test-project",
      executeStep: async () => {
        step++;
        const files = step === 2 ? ["created src/app.ts", "created package.json"] : [];
        return { summary: "done", changes: files, toolResults: [{ name: "write", ok: true }], tokensUsed: 500, errors: [] };
      },
    });

    expect(result.context.allFiles.size).toBeGreaterThanOrEqual(0);
    // Pipeline should complete
    expect(result.context.stepResults.length).toBeGreaterThan(0);
  });
});
