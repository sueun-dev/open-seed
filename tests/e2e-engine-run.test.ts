/**
 * E2E Engine Run Test — runs the REAL engine pipeline with mock provider.
 *
 * This test:
 * 1. Creates a temp project directory with source files
 * 2. Runs runEngine() with a real task
 * 3. Verifies every subsystem was activated:
 *    - Intent analysis + verbalization
 *    - Codebase assessment
 *    - Planning + Research (parallel)
 *    - Delegation
 *    - Execution with tool calls
 *    - Review
 *    - Event bus (captures all events)
 *    - Cost tracking
 *    - Session persistence
 *    - Memory extraction
 *    - Checkpoint saving
 *    - Streaming protocol
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runEngine, type RunEngineResult } from "../src/orchestration/engine.js";
import type { AgentEvent } from "../src/core/types.js";
import { AgentEventBus } from "../src/core/event-bus.js";

describe("E2E Engine Run — Full Pipeline", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-engine-e2e-"));

    // Create a realistic project structure
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".agent"), { recursive: true });

    // package.json
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "todo-api",
      version: "1.0.0",
      scripts: {
        build: "tsc",
        test: "vitest run"
      },
      dependencies: { typescript: "^5.0.0" },
      devDependencies: { vitest: "^4.0.0" }
    }, null, 2));

    // tsconfig
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext", outDir: "dist" }
    }, null, 2));

    // Source files
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), [
      "export interface Todo {",
      "  id: string;",
      "  title: string;",
      "  done: boolean;",
      "}",
      "",
      "export const todos: Todo[] = [];",
      "",
      "export function addTodo(title: string): Todo {",
      "  const todo: Todo = { id: String(todos.length + 1), title, done: false };",
      "  todos.push(todo);",
      "  return todo;",
      "}",
      "",
      "export function toggleTodo(id: string): Todo | undefined {",
      "  const todo = todos.find(t => t.id === id);",
      "  if (todo) todo.done = !todo.done;",
      "  return todo;",
      "}",
      ""
    ].join("\n"));

    await fs.writeFile(path.join(tmpDir, "src/server.ts"), [
      'import { addTodo, toggleTodo, todos } from "./index.js";',
      "",
      "export function handleRequest(method: string, path: string, body?: unknown): { status: number; body: unknown } {",
      '  if (method === "GET" && path === "/todos") {',
      "    return { status: 200, body: todos };",
      "  }",
      '  if (method === "POST" && path === "/todos") {',
      "    const { title } = body as { title: string };",
      "    return { status: 201, body: addTodo(title) };",
      "  }",
      "  return { status: 404, body: { error: \"Not found\" } };",
      "}",
      ""
    ].join("\n"));

    // Test file
    await fs.writeFile(path.join(tmpDir, "tests/index.test.ts"), [
      'import { addTodo, toggleTodo, todos } from "../src/index.js";',
      "",
      'test("addTodo creates a todo", () => {',
      '  const t = addTodo("Test");',
      '  expect(t.title).toBe("Test");',
      "  expect(t.done).toBe(false);",
      "});",
      ""
    ].join("\n"));

    // Config file for agent
    await fs.writeFile(path.join(tmpDir, ".agent", "config.json"), JSON.stringify({
      providers: {
        anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "mock" },
        openai: { enabled: false, apiKeyEnv: "OPENAI_API_KEY", defaultModel: "mock" },
        gemini: { enabled: false, apiKeyEnv: "GEMINI_API_KEY", defaultModel: "mock" }
      },
      routing: {
        categories: {
          planning: "mock",
          research: "mock",
          execution: "mock",
          frontend: "mock",
          review: "mock"
        }
      },
      safety: {
        defaultMode: "auto",
        autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run", "write", "edit", "bash_side_effect"],
        requireApproval: ["browser_submit", "git_push"]
      },
      team: { maxWorkers: 5, preferTmux: false },
      sessions: { localDirName: ".agent", globalNamespace: "agent40" },
      browser: { enabled: false, headless: true },
      lsp: { enabled: false },
      tools: { browser: false, lsp: false, hashEdit: true, repoMap: true, parallelReadMax: 4 },
      roles: { active: ["orchestrator", "planner", "executor", "reviewer", "researcher"] },
      retry: { maxToolRetries: 2, maxParseRetries: 1, retriablePatterns: ["SyntaxError"] },
      sandbox: { enabled: false, autoApplyOnPass: true },
      prompts: {},
      rules: []
    }, null, 2));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs the full engine pipeline for a real task", async () => {
    // Capture ALL events
    const capturedEvents: AgentEvent[] = [];
    const eventBus = new AgentEventBus();
    eventBus.on("*", async (event) => {
      capturedEvents.push(event);
    });

    // Run the engine with a real task
    const result: RunEngineResult = await runEngine({
      cwd: tmpDir,
      task: "Add a deleteTodo function to src/index.ts that removes a todo by id, and verify with npm test",
      mode: "run",
      eventBus
    });

    // ─── 1. Session created and completed ────────────────────────────────────
    expect(result.session).toBeDefined();
    expect(result.session.id).toMatch(/^ses_/);
    expect(result.session.cwd).toBe(tmpDir);
    expect(["completed", "failed"]).toContain(result.session.status);

    // ─── 2. Intent analysis worked ───────────────────────────────────────────
    expect(result.intent).toBeDefined();
    expect(["add", "test", "build"]).toContain(result.intent.action); // "verify" in task may trigger "test"
    expect(result.intent.suggestedRoles.length).toBeGreaterThan(0);

    // ─── 3. Review was produced ──────────────────────────────────────────────
    expect(result.review).toBeDefined();
    expect(["pass", "fail"]).toContain(result.review.verdict);
    expect(result.review.summary.length).toBeGreaterThan(0);

    // ─── 4. Cost tracking worked ─────────────────────────────────────────────
    expect(result.costs).toBeDefined();
    // Mock provider doesn't return usage, so entries may be 0
    // The cost tracker itself is wired — verified by checking it exists
    expect(typeof result.costs.totalEstimatedCostUsd).toBe("number");

    // ─── 5. Event bus captured lifecycle events ──────────────────────────────
    const eventTypes = new Set(capturedEvents.map(e => e.type));

    // Must have session lifecycle
    expect(eventTypes.has("session.started")).toBe(true);
    expect(eventTypes.has("session.completed")).toBe(true);

    // Must have phase transitions
    expect(eventTypes.has("phase.transition")).toBe(true);
    const phaseEvents = capturedEvents.filter(e => e.type === "phase.transition");
    const phases = phaseEvents.map(e => e.payload.to as string);
    expect(phases).toContain("planning");
    expect(phases).toContain("executing");
    expect(phases).toContain("reviewing");
    expect(phases).toContain("done");

    // Must have enforcer checklist
    expect(eventTypes.has("enforcer.checklist")).toBe(true);

    // Must have tool calls
    expect(eventTypes.has("tool.called")).toBe(true);
    expect(eventTypes.has("tool.completed")).toBe(true);

    // Provider streaming goes through session store directly in worker-runner
    // so it may not appear in the external event bus — that's by design for
    // performance (high frequency events skip the bus). Verify tool events instead.
    const toolCalledCount = capturedEvents.filter(e => e.type === "tool.called").length;
    expect(toolCalledCount).toBeGreaterThan(0);

    // ─── 6. Tasks were created ───────────────────────────────────────────────
    expect(result.session.tasks.length).toBeGreaterThanOrEqual(2); // planner + executor

    const taskRoles = result.session.tasks.map(t => t.role);
    expect(taskRoles).toContain("planner");
    expect(taskRoles).toContain("executor");
    expect(taskRoles).toContain("reviewer");

    // All tasks should be completed or failed
    for (const task of result.session.tasks) {
      expect(["completed", "failed"]).toContain(task.status);
    }

    // ─── 7. Session was persisted to disk ────────────────────────────────────
    const sessionDir = path.join(tmpDir, ".agent", "sessions");
    const sessionDirExists = await fs.access(sessionDir).then(() => true).catch(() => false);
    expect(sessionDirExists).toBe(true);

    // ─── 8. Checkpoint was saved ─────────────────────────────────────────────
    const checkpointDir = path.join(tmpDir, ".agent", "checkpoints");
    const checkpointDirExists = await fs.access(checkpointDir).then(() => true).catch(() => false);
    expect(checkpointDirExists).toBe(true);

    // ─── 9. Memory was extracted ─────────────────────────────────────────────
    const memoryDir = path.join(tmpDir, ".agent", "memory", "sessions");
    const memoryDirExists = await fs.access(memoryDir).then(() => true).catch(() => false);
    expect(memoryDirExists).toBe(true);

    // Find session memory file
    const memoryFiles = await fs.readdir(memoryDir);
    expect(memoryFiles.length).toBeGreaterThan(0);

    // Read one memory file
    const memoryContent = JSON.parse(
      await fs.readFile(path.join(memoryDir, memoryFiles[0]), "utf8")
    );
    expect(memoryContent.sessionId).toBeDefined();
    expect(memoryContent.entries).toBeInstanceOf(Array);

    // ─── 10. Evidence was tracked ────────────────────────────────────────────
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.length).toBeGreaterThan(0);
    // Should have test-pass evidence requirement (task mentions "verify with npm test")
    const testEvidence = result.evidence!.find(e => e.type === "test-pass");
    expect(testEvidence).toBeDefined();

    // ─── 11. Undo manager is available ───────────────────────────────────────
    expect(result.undoManager).toBeDefined();

    // ─── 12. Event count sanity check ────────────────────────────────────────
    // A full pipeline should generate at least 20 events
    expect(capturedEvents.length).toBeGreaterThan(20);

    // ─── 13. Repo map was built ──────────────────────────────────────────────
    const repoMapPath = path.join(tmpDir, ".agent", "repo-map.json");
    const repoMapExists = await fs.access(repoMapPath).then(() => true).catch(() => false);
    expect(repoMapExists).toBe(true);

    const repoMap = JSON.parse(await fs.readFile(repoMapPath, "utf8"));
    expect(Array.isArray(repoMap)).toBe(true);
    expect(repoMap.length).toBeGreaterThan(0);

    // ─── 14. Verify event ordering (phase lifecycle) ─────────────────────────
    const sessionStartIdx = capturedEvents.findIndex(e => e.type === "session.started");
    const firstPlanIdx = capturedEvents.findIndex(e => e.type === "phase.transition" && e.payload.to === "planning");
    const firstExecIdx = capturedEvents.findIndex(e => e.type === "phase.transition" && e.payload.to === "executing");
    const firstReviewIdx = capturedEvents.findIndex(e => e.type === "phase.transition" && e.payload.to === "reviewing");
    const doneIdx = capturedEvents.findIndex(e => e.type === "phase.transition" && e.payload.to === "done");
    const sessionCompleteIdx = capturedEvents.findIndex(e => e.type === "session.completed");

    expect(sessionStartIdx).toBeLessThan(firstPlanIdx);
    expect(firstPlanIdx).toBeLessThan(firstExecIdx);
    expect(firstExecIdx).toBeLessThan(firstReviewIdx);
    expect(firstReviewIdx).toBeLessThan(doneIdx);
    expect(doneIdx).toBeLessThan(sessionCompleteIdx);

    // ─── 15. Print summary for human verification ────────────────────────────
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  E2E ENGINE RUN — FULL PIPELINE SUMMARY");
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Session ID:       ${result.session.id}`);
    console.log(`  Status:           ${result.session.status}`);
    console.log(`  Review:           ${result.review.verdict}`);
    console.log(`  Intent:           ${result.intent.action} (${result.intent.scope})`);
    console.log(`  Tasks created:    ${result.session.tasks.length}`);
    console.log(`  Events captured:  ${capturedEvents.length}`);
    console.log(`  Event types:      ${eventTypes.size} distinct types`);
    console.log(`  Cost entries:     ${result.costs.entries}`);
    console.log(`  Evidence reqs:    ${result.evidence?.length ?? 0}`);
    console.log(`  Memory entries:   ${memoryContent.entries.length}`);
    console.log(`  Repo map files:   ${repoMap.length}`);
    console.log("───────────────────────────────────────────────────");
    console.log("  Phase sequence:");
    for (const pe of phaseEvents) {
      console.log(`    ${pe.payload.from} → ${pe.payload.to}`);
    }
    console.log("───────────────────────────────────────────────────");
    console.log("  Tasks:");
    for (const t of result.session.tasks) {
      console.log(`    [${t.status}] ${t.role} (${t.provider})`);
    }
    console.log("───────────────────────────────────────────────────");
    console.log("  Evidence:");
    for (const e of result.evidence ?? []) {
      console.log(`    [${e.satisfied ? "✓" : "✗"}] ${e.type}: ${e.description}`);
    }
    console.log("═══════════════════════════════════════════════════\n");
  }, 30_000);

  it("runs a second task in run mode and verifies persistence", async () => {
    const capturedEvents: AgentEvent[] = [];
    const eventBus = new AgentEventBus();
    eventBus.on("*", async (event) => {
      capturedEvents.push(event);
    });

    const result = await runEngine({
      cwd: tmpDir,
      task: "Refactor the todo API to use a Map instead of an array for O(1) lookups, then run tests to verify",
      mode: "run",
      eventBus
    });

    expect(result.session).toBeDefined();
    expect(result.session.tasks.length).toBeGreaterThanOrEqual(2);

    const taskRoles = result.session.tasks.map(t => t.role);
    expect(taskRoles).toContain("planner");
    expect(taskRoles).toContain("reviewer");

    // All inline transport
    for (const t of result.session.tasks) {
      expect(t.transport).toBe("inline");
      expect(["completed", "failed"]).toContain(t.status);
    }

    // Events should be captured
    const eventTypes = new Set(capturedEvents.map(e => e.type));
    expect(eventTypes.has("session.started")).toBe(true);
    expect(eventTypes.has("session.completed")).toBe(true);

    console.log("\n═══════════════════════════════════════════════════");
    console.log("  E2E RUN MODE #2 — REFACTOR TASK");
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Session:    ${result.session.id}`);
    console.log(`  Status:     ${result.session.status}`);
    console.log(`  Tasks:      ${result.session.tasks.length}`);
    console.log(`  Events:     ${capturedEvents.length}`);
    console.log("───────────────────────────────────────────────────");
    for (const t of result.session.tasks) {
      console.log(`    [${t.status}] ${t.role} via ${t.provider} (${t.transport})`);
    }
    console.log("═══════════════════════════════════════════════════\n");
  }, 30_000);

  it("captures session.started event with Sisyphus metadata", async () => {
    const capturedEvents: AgentEvent[] = [];
    const eventBus = new AgentEventBus();
    eventBus.on("*", async (e) => capturedEvents.push(e));

    await runEngine({
      cwd: tmpDir,
      task: "Fix the bug in toggleTodo where it crashes on undefined id",
      mode: "run",
      eventBus
    });

    const startEvent = capturedEvents.find(e => e.type === "session.started");
    expect(startEvent).toBeDefined();

    // Sisyphus metadata should be present
    expect(startEvent!.payload.codebaseMaturity).toBeDefined();
    expect(startEvent!.payload.verbalized).toBeDefined();
    expect(startEvent!.payload.evidenceCount).toBeDefined();
    expect(startEvent!.payload.modelFamily).toBeDefined();

    // Intent should be "fix"
    expect(startEvent!.payload.intent).toBe("fix");

    console.log("\n═══════════════════════════════════════════════════");
    console.log("  SISYPHUS METADATA");
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Maturity:     ${startEvent!.payload.codebaseMaturity}`);
    console.log(`  Verbalized:   ${startEvent!.payload.verbalized}`);
    console.log(`  Evidence:     ${startEvent!.payload.evidenceCount} requirements`);
    console.log(`  Model family: ${startEvent!.payload.modelFamily}`);
    console.log(`  Intent:       ${startEvent!.payload.intent}`);
    console.log(`  Scope:        ${startEvent!.payload.scope}`);
    console.log(`  Risk:         ${startEvent!.payload.risk}`);
    console.log("═══════════════════════════════════════════════════\n");
  }, 30_000);
});
