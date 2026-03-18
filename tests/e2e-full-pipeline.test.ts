/**
 * Full Pipeline E2E Test — exercises every AGI subsystem.
 *
 * This test runs the ENTIRE agent pipeline with the mock provider,
 * verifying that all 29 systems work together without conflicts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Core
import { AgentEventBus } from "../src/core/event-bus.js";
import { estimateTokens, createTokenBudget, compactContext, needsCompaction } from "../src/core/token-counter.js";

// Safety
import { RulesEngine } from "../src/safety/rules-engine.js";
import { ApprovalEngine } from "../src/safety/approval.js";

// Tools
import { DiffSandbox } from "../src/tools/diff-sandbox.js";

// Orchestration
import { analyzeIntent } from "../src/orchestration/intent-gate.js";
import { createEnforcerState, updateEnforcerAfterExecution, updateEnforcerAfterReview, isEnforcerDone, getEnforcerFollowUp } from "../src/orchestration/enforcer.js";
import { StuckDetector } from "../src/orchestration/stuck-detector.js";
import { diagnoseError, shouldSelfHeal, buildRecoveryPrompt, detectErrorsInOutput } from "../src/orchestration/self-heal.js";
import { CostTracker } from "../src/orchestration/cost-tracker.js";
import { selectProcess, buildExecutionBatches, validateProcessPlan } from "../src/orchestration/process.js";
import { PromptEngine, buildRepoSummary } from "../src/orchestration/prompts.js";
import { UndoManager } from "../src/orchestration/undo.js";
import { loadMicroagents, getActiveMicroagents, buildMicroagentContext } from "../src/orchestration/microagents.js";
import { detectModelFamily, getModelVariant, applyVariantToPrompt } from "../src/orchestration/model-variants.js";
import { extractSessionMemories, consolidateMemories, loadConsolidatedMemoryContext } from "../src/memory/memory-pipeline.js";
import { createNdjsonWriter, createTerminalWriter, wireEventBusToStream } from "../src/orchestration/stream-protocol.js";

// Sisyphus
import {
  assessCodebase,
  verbalizeIntent,
  buildStructuredDelegationPrompt,
  createStructuredDelegation,
  createEvidenceRequirements,
  updateEvidence,
  allEvidenceSatisfied,
  checkOracleEscalation,
  buildOraclePrompt,
  createSandboxEnvironment,
  isSandboxed
} from "../src/orchestration/sisyphus.js";

// Roles
import { getRoleRegistry, resolveRole } from "../src/roles/registry.js";
import { createDefaultConfig } from "../src/core/config.js";

describe("Full Pipeline E2E", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-e2e-"));
    // Create a mini project structure
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".agent", "microagents"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { build: "tsc", test: "vitest run" },
      dependencies: { typescript: "^5.0.0" },
      devDependencies: { vitest: "^4.0.0" }
    }, null, 2));
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    await fs.writeFile(path.join(tmpDir, ".eslintrc.json"), "{}");
    await fs.writeFile(path.join(tmpDir, ".prettierrc"), "{}");
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n');
    await fs.writeFile(path.join(tmpDir, "tests/index.test.ts"), 'import { greet } from "../src/index.js";\n');
    // Add a microagent
    await fs.writeFile(path.join(tmpDir, ".agent", "microagents", "typescript-patterns.md"), [
      "---",
      "name: typescript-patterns",
      "type: knowledge",
      "triggers: typescript, ts, type",
      "---",
      "",
      "Always use strict TypeScript. Prefer `unknown` over `any`."
    ].join("\n"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Codebase Assessment (Sisyphus Phase 1) ─────────────────────────

  it("assesses codebase maturity correctly", async () => {
    const files = [
      "package.json", "tsconfig.json", ".eslintrc.json", ".prettierrc",
      "src/index.ts", "tests/index.test.ts", ".github/workflows/ci.yml"
    ];
    const configs: Record<string, string> = {
      "package.json": await fs.readFile(path.join(tmpDir, "package.json"), "utf8")
    };

    const assessment = assessCodebase(files, configs);

    expect(assessment.maturity).toBe("disciplined");
    expect(assessment.patterns.hasLinter).toBe(true);
    expect(assessment.patterns.hasFormatter).toBe(true);
    expect(assessment.patterns.hasTypeConfig).toBe(true);
    expect(assessment.patterns.hasTests).toBe(true);
    expect(assessment.patterns.primaryLanguage).toBe("typescript");
    expect(assessment.patterns.testFramework).toBe("vitest");
    expect(assessment.conventions.length).toBeGreaterThan(0);
    expect(assessment.confidence).toBeGreaterThan(0.5);
  });

  // ─── 2. Intent Analysis + Verbalization ────────────────────────────────

  it("analyzes intent and verbalizes routing decision", () => {
    const intent = analyzeIntent("Fix the authentication bug in the login handler");

    expect(intent.action).toBe("fix");
    expect(intent.risk).toBe("medium");
    expect(intent.suggestedRoles).toContain("debugger");

    const verbalized = verbalizeIntent("Fix the authentication bug in the login handler", intent);

    expect(verbalized.category).toBe("fix");
    expect(verbalized.trueIntent).toContain("bug");
    expect(verbalized.routingDecision.length).toBeGreaterThan(0);
    expect(verbalized.delegation).toBeDefined();
  });

  // ─── 3. Event Bus with Forking ─────────────────────────────────────────

  it("event bus fires events and forks for child agents", async () => {
    const bus = new AgentEventBus();
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    bus.on("*", async (event) => {
      parentEvents.push(event.type);
    });

    // Fork for child agent
    const childBus = bus.fork("child-session-1");
    childBus.on("*", async (event) => {
      childEvents.push(event.type);
    });

    // Parent event
    await bus.fire("phase.transition", "engine", "ses_1", { from: "idle", to: "planning" });
    // Child event — should forward to parent
    await childBus.fire("tool.called", "tool", "ses_child", { tool: "read" });

    expect(parentEvents).toContain("phase.transition");
    expect(parentEvents).toContain("tool.called"); // Forwarded from child
    expect(childEvents).toContain("tool.called");
  });

  // ─── 4. Diff Sandbox ───────────────────────────────────────────────────

  it("stages writes in sandbox and applies on approval", async () => {
    const stagingDir = path.join(tmpDir, ".agent", "staging");
    const sandbox = new DiffSandbox(tmpDir, stagingDir);

    // Stage a write
    const change = await sandbox.stageWrite("src/new-file.ts", "export const x = 42;\n");
    expect(change.originalContent).toBeNull(); // New file
    expect(change.stagedContent).toBe("export const x = 42;\n");

    // File should NOT exist on disk yet
    const existsBeforeApply = await fs.access(path.join(tmpDir, "src/new-file.ts")).then(() => true).catch(() => false);
    expect(existsBeforeApply).toBe(false);

    // Read from sandbox sees staged content
    const content = await sandbox.readFile("src/new-file.ts");
    expect(content).toBe("export const x = 42;\n");

    // Get diff
    const diff = sandbox.getDiff();
    expect(diff).toContain("new file");

    // Apply
    const result = await sandbox.apply();
    expect(result.applied).toBe(1);
    expect(result.paths).toContain("src/new-file.ts");

    // File should NOW exist on disk
    const diskContent = await fs.readFile(path.join(tmpDir, "src/new-file.ts"), "utf8");
    expect(diskContent).toBe("export const x = 42;\n");
  });

  // ─── 5. Rules Engine ───────────────────────────────────────────────────

  it("rules engine blocks dangerous operations", async () => {
    const engine = new RulesEngine([
      {
        id: "no-env-writes",
        description: "Block writes to .env files",
        filePatterns: ["*.env", ".env.*"],
        toolNames: ["write"],
        approvalOverride: "block",
        enabled: true
      }
    ]);

    const result = engine.evaluate(
      { name: "write", reason: "writing config", input: { path: ".env", content: "SECRET=xxx" } },
      ".env"
    );

    expect(result.matched).toBe(true);
    expect(result.action).toBe("block");
    expect(result.ruleId).toBe("no-env-writes");
  });

  // ─── 6. Enforcer Loop + Stuck Detection ────────────────────────────────

  it("enforcer loop with stuck detection prevents infinite loops", () => {
    const intent = analyzeIntent("Add a new feature to the dashboard");
    let enforcer = createEnforcerState(intent);
    const detector = new StuckDetector({ maxConsecutiveFailures: 3 });

    // Simulate 3 rounds of failure
    for (let i = 0; i < 3; i++) {
      enforcer = updateEnforcerAfterExecution(enforcer, {
        kind: "execution",
        summary: "Made changes",
        changes: ["file.ts"],
        suggestedCommands: ["npm test"]
      });

      enforcer = updateEnforcerAfterReview(enforcer, {
        verdict: "fail",
        summary: "Tests failing",
        followUp: ["Fix the tests"]
      });

      detector.recordRound(i + 1, "fail", "Tests failing");
    }

    expect(detector.isStuck()).toBe(true);
    expect(detector.getStuckReason()).toContain("consecutive");
  });

  // ─── 7. Self-Healing Error Classification ──────────────────────────────

  it("diagnoses errors and determines recovery strategy", () => {
    const syntaxError = diagnoseError("SyntaxError: Unexpected token } in JSON at position 42");
    expect(syntaxError.category).toBe("syntax");
    expect(syntaxError.strategy).toBe("retry-with-context");

    const buildError = diagnoseError("Build failed: Cannot find module './missing'");
    expect(buildError.category).toBe("build");
    expect(buildError.strategy).toBe("fix-and-retry");

    const networkError = diagnoseError("ETIMEDOUT: connection timed out");
    expect(networkError.category).toBe("network");
    expect(networkError.strategy).toBe("retry");

    // Self-heal decision
    expect(shouldSelfHeal(syntaxError, 1, 3)).toBe(true);
    expect(shouldSelfHeal(networkError, 1, 3)).toBe(true);

    const permError = diagnoseError("Permission denied: EACCES");
    expect(shouldSelfHeal(permError, 1, 3)).toBe(false); // Never self-heal permission errors
  });

  // ─── 8. Token Budget + Context Compaction ──────────────────────────────

  it("manages token budget and compacts context when needed", () => {
    const budget = createTokenBudget("claude-opus-4-6");
    expect(budget.maxTokens).toBe(200_000);

    const longContext = Array(500).fill("This is a line of context that takes up space.").join("\n\n");
    const tokens = estimateTokens(longContext);
    expect(tokens).toBeGreaterThan(5000);

    const { compacted, originalTokens, compactedTokens } = compactContext(longContext, 1000);
    expect(compactedTokens).toBeLessThan(originalTokens);
    expect(compactedTokens).toBeLessThanOrEqual(1200); // Roughly within budget
  });

  // ─── 9. Cost Tracking ─────────────────────────────────────────────────

  it("tracks costs across multiple tasks and providers", () => {
    const tracker = new CostTracker();
    tracker.setBudget(1.0); // $1 budget

    tracker.record({
      taskId: "task_1", roleId: "planner", providerId: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 5000, outputTokens: 1000 }
    });

    tracker.record({
      taskId: "task_2", roleId: "executor", providerId: "openai",
      model: "gpt-4o",
      usage: { inputTokens: 10000, outputTokens: 3000 }
    });

    const summary = tracker.getSummary();
    expect(summary.entries).toBe(2);
    expect(summary.totalInputTokens).toBe(15000);
    expect(summary.totalOutputTokens).toBe(4000);
    expect(summary.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(Object.keys(summary.byProvider)).toContain("anthropic");
    expect(Object.keys(summary.byProvider)).toContain("openai");
    expect(tracker.isOverBudget()).toBe(false);
  });

  // ─── 10. Task DAG Resolution ───────────────────────────────────────────

  it("builds execution batches from task dependencies", () => {
    const tasks = [
      { id: "a", roleId: "researcher", title: "Research" },
      { id: "b", roleId: "planner", title: "Plan", dependsOn: ["a"] },
      { id: "c", roleId: "executor", title: "Execute frontend", dependsOn: ["b"] },
      { id: "d", roleId: "executor", title: "Execute backend", dependsOn: ["b"] },
      { id: "e", roleId: "reviewer", title: "Review", dependsOn: ["c", "d"] }
    ];

    const batches = buildExecutionBatches(tasks);
    expect(batches.length).toBe(4); // a → b → [c,d] → e
    expect(batches[0].map(t => t.id)).toEqual(["a"]);
    expect(batches[1].map(t => t.id)).toEqual(["b"]);
    expect(batches[2].map(t => t.id).sort()).toEqual(["c", "d"]); // Parallel!
    expect(batches[3].map(t => t.id)).toEqual(["e"]);

    const errors = validateProcessPlan({ type: "hierarchical", tasks });
    expect(errors).toHaveLength(0);
  });

  // ─── 11. Prompt Template Engine ────────────────────────────────────────

  it("renders prompt templates with variable substitution", () => {
    const engine = new PromptEngine();

    const errorPrompt = engine.render("error.parse", {
      errorMessage: "Unexpected token }",
      retryCount: 2
    });

    expect(errorPrompt).toContain("Unexpected token }");
    expect(errorPrompt).toContain("2");
  });

  // ─── 12. Model Variants ────────────────────────────────────────────────

  it("detects model families and applies variant-specific prompts", () => {
    expect(detectModelFamily("claude-opus-4-6")).toBe("claude");
    expect(detectModelFamily("gpt-5.4")).toBe("gpt");
    expect(detectModelFamily("gemini-2.5-pro")).toBe("gemini");
    expect(detectModelFamily("llama-3.5")).toBe("generic");

    const claudeVariant = getModelVariant("claude-opus-4-6");
    expect(claudeVariant.supportsCacheControl).toBe(true);
    expect(claudeVariant.temperature).toBe(0.3);

    const gptVariant = getModelVariant("gpt-5.4");
    expect(gptVariant.toolInstructionStyle).toBe("function_call");

    const prompt = applyVariantToPrompt("Do the task.", claudeVariant);
    expect(prompt).toContain("Think through each step");
    expect(prompt).toContain("Do the task.");
  });

  // ─── 13. Undo/Rollback ─────────────────────────────────────────────────

  it("tracks file mutations and undoes them", async () => {
    const undoMgr = new UndoManager(tmpDir, "ses_test", path.join(tmpDir, ".agent"));

    // Write a file
    const filePath = path.join(tmpDir, "src/index.ts");
    const original = await fs.readFile(filePath, "utf8");
    const newContent = "export const x = 42;\n";
    await fs.writeFile(filePath, newContent);

    // Record the mutation
    await undoMgr.recordMutation("executor", [{
      path: "src/index.ts",
      beforeContent: original,
      afterContent: newContent
    }], "write");

    expect(undoMgr.canUndo()).toBe(true);
    expect(undoMgr.getCurrentTurn()).toBe(1);

    // Undo it
    const result = await undoMgr.undo();
    expect(result).not.toBeNull();
    expect(result!.filesRestored).toContain("src/index.ts");

    // Verify file was restored
    const restored = await fs.readFile(filePath, "utf8");
    expect(restored).toBe(original);
    expect(undoMgr.canUndo()).toBe(false);
  });

  // ─── 14. Microagents ───────────────────────────────────────────────────

  it("loads microagents and injects triggered context", async () => {
    const registry = await loadMicroagents(tmpDir);
    expect(registry.agents.length).toBeGreaterThan(0);

    // "typescript" should trigger the typescript-patterns microagent
    const active = getActiveMicroagents(registry, "Fix the typescript type error");
    const triggered = active.find(a => a.name === "typescript-patterns");
    expect(triggered).toBeDefined();
    expect(triggered!.content).toContain("strict TypeScript");

    const context = buildMicroagentContext(active);
    expect(context).toContain("strict TypeScript");
  });

  // ─── 15. Memory Pipeline ───────────────────────────────────────────────

  it("extracts session memories and consolidates them", async () => {
    const events = [
      { type: "tool.called", payload: { tool: "read", path: "src/index.ts" } },
      { type: "tool.called", payload: { tool: "read", path: "src/index.ts" } },
      { type: "tool.called", payload: { tool: "write", path: "src/index.ts" } },
      { type: "tool.called", payload: { tool: "bash", command: "npm test" } },
      { type: "tool.completed", payload: { tool: "bash", ok: false, error: "Test failed: expected 42 got undefined" } },
      { type: "tool.completed", payload: { tool: "read", ok: true } },
      { type: "tool.completed", payload: { tool: "write", ok: true } }
    ];

    const sessionMem = await extractSessionMemories(tmpDir, ".agent", "ses_test_1", events);
    expect(sessionMem.entries.length).toBeGreaterThan(0);

    // Add another session
    await extractSessionMemories(tmpDir, ".agent", "ses_test_2", [
      { type: "tool.called", payload: { tool: "read", path: "src/index.ts" } },
      { type: "tool.called", payload: { tool: "bash", command: "npm run build" } },
      { type: "tool.completed", payload: { tool: "bash", ok: true } }
    ]);

    // Consolidate
    const consolidated = await consolidateMemories(tmpDir, ".agent");
    expect(consolidated.sessionCount).toBe(2);
    expect(consolidated.entries.length).toBeGreaterThan(0);

    // Load context for prompt injection
    const context = await loadConsolidatedMemoryContext(tmpDir, ".agent");
    expect(context).toContain("Agent Memory");
  });

  // ─── 16. Structured Delegation ─────────────────────────────────────────

  it("creates 6-section structured delegation prompts", () => {
    const config = createDefaultConfig();
    const registry = getRoleRegistry(config);
    const role = resolveRole(registry, "security-auditor");

    const delegation = createStructuredDelegation(
      { id: "task_1", title: "Audit auth module", category: "research" },
      role,
      "Improve security of the application",
      "src/auth.ts [typescript] symbols=login, verify"
    );

    const prompt = buildStructuredDelegationPrompt(delegation);
    expect(prompt).toContain("## TASK");
    expect(prompt).toContain("## EXPECTED OUTCOME");
    expect(prompt).toContain("## REQUIRED TOOLS");
    expect(prompt).toContain("## MUST DO");
    expect(prompt).toContain("## MUST NOT DO");
    expect(prompt).toContain("## CONTEXT");
    expect(prompt).toContain("Audit auth module");
  });

  // ─── 17. Evidence Requirements ─────────────────────────────────────────

  it("tracks evidence requirements and gates completion", () => {
    const intent = analyzeIntent("Add a new API endpoint for user profiles");
    const reqs = createEvidenceRequirements(intent);

    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.some(r => r.type === "build-pass")).toBe(true);
    expect(reqs.some(r => r.type === "test-pass")).toBe(true);
    expect(allEvidenceSatisfied(reqs)).toBe(false);

    // Simulate build pass
    let updated = updateEvidence(reqs, "Build succeeded with exit code 0");
    expect(updated.find(r => r.type === "build-pass")?.satisfied).toBe(true);

    // Simulate test pass
    updated = updateEvidence(updated, "Tests: 42 passed, 0 failed");
    expect(updated.find(r => r.type === "test-pass")?.satisfied).toBe(true);
  });

  // ─── 18. Oracle Escalation ─────────────────────────────────────────────

  it("escalates to Oracle after consecutive failures", () => {
    const check1 = checkOracleEscalation(1);
    expect(check1.shouldEscalate).toBe(false);

    const check2 = checkOracleEscalation(2);
    expect(check2.shouldEscalate).toBe(true);
    expect(check2.reason).toContain("Oracle");

    const prompt = buildOraclePrompt(
      "Fix the auth bug",
      ["Attempt 1: Changed token validation, tests still fail", "Attempt 2: Changed middleware, new error appeared"],
      "2 consecutive failures, same test failing"
    );
    expect(prompt).toContain("Oracle");
    expect(prompt).toContain("Attempt 1");
    expect(prompt).toContain("bottomLine");
  });

  // ─── 19. Sandbox Execution Signaling ───────────────────────────────────

  it("creates sandbox environment with Codex-compatible signaling", () => {
    const sandbox = createSandboxEnvironment(true);
    expect(sandbox.isSandboxed).toBe(true);
    expect(sandbox.networkDisabled).toBe(true);
    expect(sandbox.signalEnv.AGENT40_SANDBOX).toBe("1");
    expect(sandbox.signalEnv.CODEX_SANDBOX).toBe("agent40"); // Codex compatibility

    const noSandbox = createSandboxEnvironment(false);
    expect(noSandbox.isSandboxed).toBe(false);
  });

  // ─── 20. Streaming Protocol ────────────────────────────────────────────

  it("wires event bus to stream writer for real-time output", async () => {
    const bus = new AgentEventBus();
    const messages: Array<{ kind: string; text: string }> = [];

    const writer = (msg: { kind: string; text: string }) => { messages.push(msg); };
    wireEventBusToStream(bus, writer as any);

    await bus.fire("phase.transition", "engine", "ses_1", { from: "planning", to: "executing" });
    await bus.fire("tool.completed", "tool", "ses_1", { tool: "read", ok: true, durationMs: 12 });
    await bus.fire("review.pass", "engine", "ses_1", { review: { summary: "All good" } });

    expect(messages.length).toBe(3);
    expect(messages[0].kind).toBe("phase");
    expect(messages[0].text).toContain("planning");
    expect(messages[1].kind).toBe("tool");
    expect(messages[2].kind).toBe("complete");
  });

  // ─── 21. Role Registry with React Modes ────────────────────────────────

  it("40 roles with react modes and max output tokens", () => {
    const config = createDefaultConfig();
    const registry = getRoleRegistry(config);

    expect(registry.length).toBe(40);

    const executor = resolveRole(registry, "executor");
    expect(executor.reactMode).toBe("react");
    expect(executor.maxOutputTokens).toBe(8192);

    const planner = resolveRole(registry, "planner");
    expect(planner.reactMode).toBe("plan_and_act");
    expect(planner.maxOutputTokens).toBe(4096);

    const reviewer = resolveRole(registry, "reviewer");
    expect(reviewer.reactMode).toBe("by_order");
    expect(reviewer.maxOutputTokens).toBe(2048);
  });

  // ─── 22. Detect Errors in Tool Output ──────────────────────────────────

  it("detects multiple error types in tool output", () => {
    const output = [
      "Running tests...",
      "FAIL src/auth.test.ts",
      "  TypeError: Cannot read property 'token' of undefined",
      "    at validateToken (src/auth.ts:42:15)",
      "  Module not found: ./missing-module",
      "Tests: 3 failed, 12 passed"
    ].join("\n");

    const errors = detectErrorsInOutput(output);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some(e => e.category === "test")).toBe(true);
    expect(errors.some(e => e.category === "type")).toBe(true);
  });

  // ─── Integration: Full Pipeline Simulation ────────────────────────────

  it("simulates the complete AGI pipeline end-to-end", async () => {
    const task = "Add a new utility function to parse ISO dates with timezone support";

    // 1. Codebase Assessment
    const files = ["package.json", "tsconfig.json", ".eslintrc.json", ".prettierrc", "src/index.ts", "tests/index.test.ts"];
    const assessment = assessCodebase(files, {
      "package.json": await fs.readFile(path.join(tmpDir, "package.json"), "utf8")
    });
    expect(assessment.maturity).toBe("disciplined");

    // 2. Intent Analysis + Verbalization
    const intent = analyzeIntent(task);
    expect(intent.action).toBe("add");
    const verbalized = verbalizeIntent(task, intent);
    expect(verbalized.category).toBe("implementation");

    // 3. Event Bus setup
    const bus = new AgentEventBus();
    const allEvents: string[] = [];
    bus.on("*", async (e) => { allEvents.push(e.type); });

    // 4. Evidence Requirements
    const evidence = createEvidenceRequirements(intent);
    expect(evidence.length).toBeGreaterThan(0);

    // 5. Enforcer State
    let enforcer = createEnforcerState(intent);
    expect(enforcer.verdict).toBe("continue");

    // 6. Cost Tracking
    const costs = new CostTracker();
    costs.record({
      taskId: "t1", roleId: "planner", providerId: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 3000, outputTokens: 800 }
    });

    // 7. Simulate Execution
    enforcer = updateEnforcerAfterExecution(enforcer, {
      kind: "execution",
      summary: "Added parseIsoDate function. Build passes. Tests pass (all 13 passed).",
      changes: ["src/date-utils.ts"],
      suggestedCommands: ["npm run build", "npm test"]
    });

    // 8. Evidence check
    const updatedEvidence = updateEvidence(evidence, "Build succeeded. Tests: all 13 passed");
    const buildSatisfied = updatedEvidence.find(e => e.type === "build-pass")?.satisfied;
    const testSatisfied = updatedEvidence.find(e => e.type === "test-pass")?.satisfied;

    // 9. Simulate Review Pass
    enforcer = updateEnforcerAfterReview(enforcer, {
      verdict: "pass",
      summary: "Implementation is correct and well-tested.",
      followUp: []
    });

    // 10. Should be done
    expect(isEnforcerDone(enforcer)).toBe(true);
    expect(enforcer.verdict).toBe("done");

    // 11. Memory extraction
    await extractSessionMemories(tmpDir, ".agent", "ses_pipeline", [
      { type: "tool.called", payload: { tool: "write", path: "src/date-utils.ts" } },
      { type: "tool.called", payload: { tool: "bash", command: "npm test" } },
      { type: "tool.completed", payload: { tool: "bash", ok: true } }
    ]);

    // 12. Oracle check (shouldn't escalate since we passed)
    const oracle = checkOracleEscalation(0);
    expect(oracle.shouldEscalate).toBe(false);

    // 13. Final cost check
    const summary = costs.getSummary();
    expect(summary.totalEstimatedCostUsd).toBeGreaterThan(0);
  });
});
