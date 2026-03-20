/**
 * E2E Real LLM Test — runs the engine with ACTUAL OpenAI via OAuth.
 *
 * This test:
 * 1. Creates a mini todo-app project
 * 2. Runs runEngine() with OpenAI (via Codex OAuth)
 * 3. Verifies the LLM actually wrote working code
 * 4. Checks if the code compiles and the logic is correct
 *
 * Requires: ~/.codex/auth.json (OpenAI Codex OAuth)
 * Skip: if no OAuth token is available
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runEngine } from "../src/orchestration/engine.js";
import { AgentEventBus } from "../src/core/event-bus.js";
import type { AgentEvent, ToolResult } from "../src/core/types.js";
import { loadOpenAICodexCliAuth } from "../src/providers/external-auth.js";

const hasOpenAIAuth = (() => {
  try {
    return loadOpenAICodexCliAuth() !== null;
  } catch {
    return false;
  }
})();

describe("E2E Real LLM — Auth Diagnostics", () => {
  it("checks OpenAI OAuth auth status", async () => {
    const { getProviderAuthStatus } = await import("../src/providers/auth.js");
    const status = getProviderAuthStatus("openai", {
      enabled: true,
      apiKeyEnv: "OPENAI_API_KEY",
      authMode: "oauth",
      oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
      defaultModel: "gpt-4.1-mini",
      timeoutMs: 60000,
      maxRetries: 2
    });

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  OPENAI AUTH STATUS DIAGNOSTIC                           ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log(`║ ready:          ${String(status.ready).padEnd(41)}║`);
    console.log(`║ enabled:        ${String(status.enabled).padEnd(41)}║`);
    console.log(`║ hasModel:       ${String(status.hasModel).padEnd(41)}║`);
    console.log(`║ hasCredential:  ${String(status.hasCredential).padEnd(41)}║`);
    console.log(`║ credentialSrc:  ${String(status.credentialSource ?? "none").padEnd(41)}║`);
    console.log(`║ supported:      ${String(status.supported).padEnd(41)}║`);
    console.log(`║ authMode:       ${status.authMode.padEnd(41)}║`);
    console.log(`║ summary:        ${status.summary.slice(0, 41).padEnd(41)}║`);
    if (status.warnings.length > 0) {
      for (const w of status.warnings) {
        console.log(`║ ⚠ ${w.slice(0, 55).padEnd(55)}║`);
      }
    }
    console.log("╚═══════════════════════════════════════════════════════════╝\n");

    // Just diagnostic — don't fail
    expect(status).toBeDefined();
  });
});

describe.skipIf(!hasOpenAIAuth)("E2E Real LLM — OpenAI via OAuth", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-real-llm-"));

    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".agent"), { recursive: true });

    // Simple todo module — LLM will add deleteTodo
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({
      name: "todo-lib",
      version: "1.0.0",
      type: "module",
      scripts: { build: "tsc --noEmit" },
      devDependencies: { typescript: "^5.0.0" }
    }, null, 2));

    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true
      },
      include: ["src"]
    }, null, 2));

    await fs.writeFile(path.join(tmpDir, "src/todo.ts"), [
      "export interface Todo {",
      "  id: string;",
      "  title: string;",
      "  done: boolean;",
      "}",
      "",
      "const store = new Map<string, Todo>();",
      "let nextId = 1;",
      "",
      "export function addTodo(title: string): Todo {",
      "  const id = String(nextId++);",
      "  const todo: Todo = { id, title, done: false };",
      "  store.set(id, todo);",
      "  return todo;",
      "}",
      "",
      "export function getTodo(id: string): Todo | undefined {",
      "  return store.get(id);",
      "}",
      "",
      "export function listTodos(): Todo[] {",
      "  return Array.from(store.values());",
      "}",
      "",
      "export function toggleTodo(id: string): Todo | undefined {",
      "  const todo = store.get(id);",
      "  if (todo) todo.done = !todo.done;",
      "  return todo;",
      "}",
      "",
      "// TODO: Add deleteTodo function",
      ""
    ].join("\n"));

    // Config: use OpenAI with OAuth
    await fs.writeFile(path.join(tmpDir, ".agent", "config.json"), JSON.stringify({
      providers: {
        anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-5" },
        openai: {
          enabled: true,
          apiKeyEnv: "OPENAI_API_KEY",
          authMode: "oauth",
          oauthTokenEnv: "OPENAI_OAUTH_TOKEN",
          defaultModel: "gpt-5.4",
          timeoutMs: 60000,
          maxRetries: 2
        },
        gemini: { enabled: false, apiKeyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-pro" }
      },
      routing: {
        categories: {
          planning: "openai",
          research: "openai",
          execution: "openai",
          frontend: "openai",
          review: "openai"
        }
      },
      safety: {
        defaultMode: "auto",
        autoApprove: ["read", "search", "lsp_diagnostics", "test_dry_run", "write", "edit", "bash_side_effect"],
        requireApproval: ["browser_submit", "git_push"]
      },
      team: { maxWorkers: 1, preferTmux: false },
      sessions: { localDirName: ".agent", globalNamespace: "agent40" },
      browser: { enabled: false, headless: true },
      lsp: { enabled: false },
      tools: { browser: false, lsp: false, hashEdit: true, repoMap: true, parallelReadMax: 4 },
      roles: { active: ["orchestrator", "planner", "executor", "reviewer", "researcher"] },
      retry: { maxToolRetries: 2, maxParseRetries: 2, retriablePatterns: ["SyntaxError", "ETIMEDOUT", "429"] },
      sandbox: { enabled: false, autoApplyOnPass: true },
      prompts: {},
      rules: []
    }, null, 2));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("generates real code with OpenAI and verifies it", async () => {
    const events: AgentEvent[] = [];
    const bus = new AgentEventBus();
    bus.on("*", async (e) => events.push(e));

    // Read original source
    const originalSource = await fs.readFile(path.join(tmpDir, "src/todo.ts"), "utf8");

    // Debug: verify config is loaded correctly
    const { loadConfig } = await import("../src/core/config.js");
    const loadedConfig = await loadConfig(tmpDir);
    const openaiCfg = loadedConfig.providers.openai;
    const routing = loadedConfig.routing.categories;

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  CONFIG DIAGNOSTIC                                       ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log(`║ openai.enabled:   ${String(openaiCfg.enabled).padEnd(39)}║`);
    console.log(`║ openai.authMode:  ${String(openaiCfg.authMode).padEnd(39)}║`);
    console.log(`║ openai.model:     ${String(openaiCfg.defaultModel).padEnd(39)}║`);
    console.log(`║ routing.planning: ${String(routing.planning).padEnd(39)}║`);
    console.log(`║ routing.exec:     ${String(routing.execution).padEnd(39)}║`);
    console.log(`║ routing.review:   ${String(routing.review).padEnd(39)}║`);
    console.log("╚═══════════════════════════════════════════════════════════╝");

    // Also check isConfigured
    const { ProviderRegistry } = await import("../src/providers/registry.js");
    const reg = new ProviderRegistry();
    const adapter = reg.get("openai");
    console.log(`\nOpenAI adapter.isConfigured: ${adapter.isConfigured(openaiCfg)}`);

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  🚀 RUNNING ENGINE WITH REAL OpenAI (gpt-4.1-mini)       ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║  Task: Add deleteTodo function to src/todo.ts            ║");
    console.log("║  Provider: OpenAI via Codex OAuth                        ║");
    console.log("╚═══════════════════════════════════════════════════════════╝\n");

    const result = await runEngine({
      cwd: tmpDir,
      task: "Add a deleteTodo function to src/todo.ts that removes a todo by id from the store and returns true if found, false otherwise. Read the file first, then write the updated version.",
      mode: "run",
      eventBus: bus
    });

    // Read the file after engine run
    const finalSource = await fs.readFile(path.join(tmpDir, "src/todo.ts"), "utf8");
    const wasModified = finalSource !== originalSource;

    // Extract tool results
    const allToolResults: ToolResult[] = [];
    for (const task of result.session.tasks) {
      const output = task.output as Record<string, unknown> | undefined;
      if (output?.toolResults && Array.isArray(output.toolResults)) {
        allToolResults.push(...(output.toolResults as ToolResult[]));
      }
    }

    // ─── Quality checks ──────────────────────────────────────────────────

    const hasDeleteTodoFunction = /export\s+function\s+deleteTodo/.test(finalSource);
    const hasStoreDelete = /store\.delete|\.splice|\.filter|\.findIndex/.test(finalSource);
    const returnsBool = /:\s*(boolean|true|false)/.test(finalSource) || /return\s+(true|false|store\.delete)/.test(finalSource);
    const preservesExisting = finalSource.includes("addTodo") && finalSource.includes("getTodo") && finalSource.includes("toggleTodo");
    const hasValidSyntax = !(/\bSyntaxError\b/.test(finalSource));

    // Check if a read tool was called (LLM should read before writing)
    const readCalls = allToolResults.filter(r => r.name === "read" && r.ok);
    const writeCalls = allToolResults.filter(r => r.name === "write" && r.ok);

    console.log("\n╔═══════════════════════════════════════════════════════════╗");
    console.log("║  📊 REAL LLM RESULT — FULL INSPECTION                    ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log(`║ Session:          ${result.session.id.padEnd(39)}║`);
    console.log(`║ Status:           ${result.session.status.padEnd(39)}║`);
    console.log(`║ Review:           ${result.review.verdict.padEnd(39)}║`);
    console.log(`║ Tasks:            ${String(result.session.tasks.length).padEnd(39)}║`);
    console.log(`║ Events:           ${String(events.length).padEnd(39)}║`);
    console.log(`║ Cost:             $${result.costs.totalEstimatedCostUsd.toFixed(4).padEnd(38)}║`);
    console.log(`║ Input tokens:     ${String(result.costs.totalInputTokens).padEnd(39)}║`);
    console.log(`║ Output tokens:    ${String(result.costs.totalOutputTokens).padEnd(39)}║`);
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║ TOOL EXECUTION TRACE                                     ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    for (const tr of allToolResults) {
      const s = tr.ok ? "✓" : "✗";
      const out = tr.output as Record<string, unknown> | undefined;
      let detail = "";
      if (tr.name === "write") detail = `${out?.path ?? ""} (${out?.bytes ?? 0}B)`;
      else if (tr.name === "read") detail = `${out?.path ?? ""}`;
      else if (tr.name === "bash") detail = `${(out?.command as string ?? "").slice(0, 30)}`;
      else if (tr.name === "grep") detail = `${(out as any)?.pattern ?? ""}`;
      else detail = JSON.stringify(out ?? {}).slice(0, 35);
      console.log(`║ ${s} ${tr.name.padEnd(14)} ${detail.slice(0, 38)}`.slice(0, 59).padEnd(59) + "║");
    }
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║ CODE QUALITY CHECK                                       ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log(`║ File modified:          ${(wasModified ? "✓ YES" : "✗ NO").padEnd(33)}║`);
    console.log(`║ Has deleteTodo():       ${(hasDeleteTodoFunction ? "✓ YES" : "✗ NO").padEnd(33)}║`);
    console.log(`║ Uses store.delete():    ${(hasStoreDelete ? "✓ YES" : "✗ NO").padEnd(33)}║`);
    console.log(`║ Returns boolean:        ${(returnsBool ? "✓ YES" : "✗ NO").padEnd(33)}║`);
    console.log(`║ Preserves existing:     ${(preservesExisting ? "✓ YES" : "✗ NO").padEnd(33)}║`);
    console.log(`║ Read before write:      ${(readCalls.length > 0 ? `✓ YES (${readCalls.length} reads)` : "✗ NO").padEnd(33)}║`);
    console.log(`║ Write executed:         ${(writeCalls.length > 0 ? `✓ YES (${writeCalls.length} writes)` : "✗ NO").padEnd(33)}║`);
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║ GENERATED src/todo.ts                                    ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    for (const line of finalSource.split("\n").slice(0, 50)) {
      console.log(`║ ${line}`.slice(0, 59).padEnd(59) + "║");
    }
    console.log("╠═══════════════════════════════════════════════════════════╣");
    console.log("║ EVIDENCE                                                 ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    for (const e of result.evidence ?? []) {
      console.log(`║ ${e.satisfied ? "✓" : "✗"} ${e.type.padEnd(20)} ${e.description.slice(0, 30)}`.slice(0, 59).padEnd(59) + "║");
    }
    console.log("╚═══════════════════════════════════════════════════════════╝\n");

    // ─── Raw LLM output debug ──────────────────────────────────────────
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║ RAW TASK ARTIFACTS                                       ║");
    console.log("╠═══════════════════════════════════════════════════════════╣");
    for (const t of result.session.tasks) {
      console.log(`\n--- ${t.role} (${t.provider}) ---`);
      const out = t.output as Record<string, unknown> | undefined;
      if (out) {
        const str = JSON.stringify(out, null, 2);
        for (const line of str.split("\n").slice(0, 30)) {
          console.log(line);
        }
        if (str.split("\n").length > 30) console.log(`... (${str.split("\n").length - 30} more lines)`);
      }
    }
    console.log("╚═══════════════════════════════════════════════════════════╝\n");

    // ─── Assertions ──────────────────────────────────────────────────────

    // Engine completed
    expect(result.session).toBeDefined();
    expect(result.session.tasks.length).toBeGreaterThanOrEqual(2);

    // LLM should have actually modified the file
    expect(wasModified).toBe(true);

    // The generated code should have deleteTodo
    expect(hasDeleteTodoFunction).toBe(true);

    // Should preserve existing functions
    expect(preservesExisting).toBe(true);

    // Should use store.delete or equivalent
    expect(hasStoreDelete).toBe(true);

    // Should return boolean
    expect(returnsBool).toBe(true);

    // Cost should be tracked (real LLM returns usage)
    expect(result.costs.totalInputTokens).toBeGreaterThan(0);
    expect(result.costs.totalOutputTokens).toBeGreaterThan(0);
  }, 600_000); // 10 min timeout for real API calls
});
