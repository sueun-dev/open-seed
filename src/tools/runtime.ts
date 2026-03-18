import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { getRepoMapPath } from "../core/paths.js";
import type {
  AgentConfig,
  ApprovalAction,
  ApprovalDecision,
  ToolCall,
  ToolDefinition,
  ToolName,
  ToolResult,
  RoleDefinition
} from "../core/types.js";
import { createId, ensureDir, fileExists } from "../core/utils.js";
import { ApprovalEngine } from "../safety/approval.js";
import { SessionApprovalResolver, type ApprovalResolver } from "../safety/resolver.js";
import { SessionStore } from "../sessions/store.js";
import { getBrowserSessionPaths, readLatestBrowserCheckpoint, writeBrowserCheckpoint } from "./browser-session.js";
import { applyHashEdits, renderFileWithHashes, type HashEdit } from "./hashline.js";
import { getBrowserHealth, assertAllowedBrowserAction, loadPlaywrightCore, type BrowserAction } from "./browser.js";
import { getTypeScriptDiagnostics, listTypeScriptSymbols } from "./lsp.js";
import { astGrepSearch } from "./ast-grep.js";
import { buildRepoMap } from "./repomap.js";
import { webSearch } from "./web-search.js";
import { DiffSandbox } from "./diff-sandbox.js";
import { RulesEngine, type RuleEvaluation } from "../safety/rules-engine.js";
import type { AgentEventBus } from "../core/event-bus.js";
import type { HookRegistry } from "../orchestration/hooks.js";

const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  read: {
    name: "read", description: "Read a file from the workspace.", approvalAction: "read", sideEffect: false,
    toolCategory: "file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative file path" }, withHashes: { type: "boolean", description: "Include hash anchors for editing" } }, required: ["path"] }
  },
  write: {
    name: "write", description: "Write a full file into the workspace.", approvalAction: "write", sideEffect: true,
    toolCategory: "file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative file path" }, content: { type: "string", description: "Full file content" } }, required: ["path", "content"] }
  },
  apply_patch: {
    name: "apply_patch", description: "Apply hash-anchored edits to a file.", approvalAction: "edit", sideEffect: true,
    toolCategory: "file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative file path" }, edits: { type: "array", items: { type: "object", properties: { hash: { type: "string" }, newContent: { type: "string" } }, required: ["hash", "newContent"] } } }, required: ["path", "edits"] }
  },
  grep: {
    name: "grep", description: "Search for a regex pattern across workspace files.", approvalAction: "search", sideEffect: false,
    toolCategory: "search",
    inputSchema: { type: "object", properties: { pattern: { type: "string", description: "Regex pattern" }, glob: { type: "string", description: "Optional file glob filter" }, ignoreCase: { type: "boolean" } }, required: ["pattern"] }
  },
  glob: {
    name: "glob", description: "List files matching a glob pattern.", approvalAction: "search", sideEffect: false,
    toolCategory: "search",
    inputSchema: { type: "object", properties: { pattern: { type: "string", description: "Glob pattern (e.g. src/**/*.ts)" } }, required: ["pattern"] }
  },
  bash: {
    name: "bash", description: "Run a shell command.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Shell command to execute" }, timeoutMs: { type: "number", description: "Timeout in milliseconds (default 30000)" }, dryRun: { type: "boolean", description: "If true, treated as safe read-only" } }, required: ["command"] }
  },
  git: {
    name: "git", description: "Run a git command in the workspace.", approvalAction: "read", sideEffect: false,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: { args: { type: "array", items: { type: "string" }, description: "Git arguments (e.g. [\"status\"])" } }, required: ["args"] }
  },
  browser: {
    name: "browser", description: "Drive a browser action within approved bounds.", approvalAction: "browser_submit", sideEffect: true,
    toolCategory: "browser",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["open", "click", "fill", "screenshot", "console", "network"] }, url: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, sessionName: { type: "string" } }, required: ["action"] }
  },
  lsp_diagnostics: {
    name: "lsp_diagnostics", description: "Collect TypeScript diagnostics.", approvalAction: "lsp_diagnostics", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative file path" } }, required: ["path"] }
  },
  lsp_symbols: {
    name: "lsp_symbols", description: "Collect TypeScript symbols.", approvalAction: "lsp_diagnostics", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative file path" } }, required: ["path"] }
  },
  repo_map: {
    name: "repo_map", description: "Read or rebuild the repo map.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: {} }
  },
  session_history: {
    name: "session_history", description: "Read session events.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max events to return (default 20)" } } }
  },
  ast_grep: {
    name: "ast_grep", description: "Structural code search using AST patterns.", approvalAction: "search", sideEffect: false,
    toolCategory: "search",
    inputSchema: { type: "object", properties: { pattern: { type: "string", description: "AST pattern (e.g. $FN($ARGS))" }, language: { type: "string", description: "Language filter" } }, required: ["pattern"] }
  },
  web_search: {
    name: "web_search", description: "Search the web for documentation and references.", approvalAction: "search", sideEffect: false,
    toolCategory: "network",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, maxResults: { type: "number", description: "Max results (default 5)" } }, required: ["query"] }
  }
};

const SAFE_BASH_PATTERN = /\b(npm\s+(test|run build)|pnpm\s+(test|build)|yarn\s+(test|build)|vitest\b|pytest\b|go test\b|cargo test\b|cargo check\b|tsc\b)\b/i;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".agent", "dist", "coverage"]);

class ProcessExitError extends Error {
  constructor(
    message: string,
    readonly output: {
      exitCode: number;
      signal: string | null;
      stdout: string;
      stderr: string;
    }
  ) {
    super(message);
  }
}

export interface ToolRuntimeOptions {
  cwd: string;
  config: AgentConfig;
  role: RoleDefinition;
  sessionId: string;
  sessionStore: SessionStore;
  approvalEngine: ApprovalEngine;
  latencyOverridesMs?: Partial<Record<ToolName, number>>;
  approvalResolver?: ApprovalResolver;
  /** Plandex-style diff sandbox — when set, writes go to staging */
  sandbox?: DiffSandbox;
  /** Cline-style rules engine for boundary enforcement */
  rulesEngine?: RulesEngine;
  /** OpenHands-style event bus for centralized event flow */
  eventBus?: AgentEventBus;
  /** Hook registry for tool.before/tool.after lifecycle events */
  hooks?: HookRegistry;
}

export class ToolRuntime {
  private readonly approvalResolver: ApprovalResolver;

  constructor(private readonly options: ToolRuntimeOptions) {
    this.approvalResolver = options.approvalResolver ?? new SessionApprovalResolver();
  }

  async executePlan(calls: ToolCall[] | undefined): Promise<ToolResult[]> {
    if (!calls || calls.length === 0) {
      return [];
    }
    const results: ToolResult[] = new Array(calls.length);
    let index = 0;
    while (index < calls.length) {
      if (!this.isReadOnlyCall(calls[index])) {
        results[index] = await this.execute(calls[index]);
        index += 1;
        continue;
      }

      let end = index + 1;
      while (end < calls.length && this.isReadOnlyCall(calls[end])) {
        end += 1;
      }

      const groupResults = await this.executeReadOnlyBatch(calls.slice(index, end));
      groupResults.forEach((result, offset) => {
        results[index + offset] = result;
      });
      index = end;
    }
    return results;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const startTime = Date.now();

    // Normalize: ensure input is always an object
    if (!call.input || typeof call.input !== "object") {
      call.input = {};
    }

    // Check rules engine first (Cline-style boundary enforcement)
    if (this.options.rulesEngine) {
      const filePath = typeof call.input.path === "string" ? call.input.path : undefined;
      const ruleResult = this.options.rulesEngine.evaluate(call, filePath);
      if (ruleResult.matched && ruleResult.action === "block") {
        await this.emitEvent("rule.blocked", { tool: call.name, ruleId: ruleResult.ruleId, reason: ruleResult.reason });
        return this.blockedResult(call, {
          action: this.getApprovalAction(call),
          mode: "ask",
          approved: false,
          reason: `Blocked by rule ${ruleResult.ruleId}: ${ruleResult.reason}`
        });
      }
    }

    // Bash command-level rule check
    if (this.options.rulesEngine && call.name === "bash" && typeof call.input.command === "string") {
      const cmdEval = this.options.rulesEngine.evaluateCommand(call.input.command);
      if (cmdEval.matched && cmdEval.action === "block") {
        await this.emitEvent("rule.blocked", { tool: call.name, ruleId: cmdEval.ruleId, reason: cmdEval.reason });
        return this.blockedResult(call, {
          action: "bash_side_effect",
          mode: "ask",
          approved: false,
          reason: `Command blocked by rule ${cmdEval.ruleId}: ${cmdEval.reason}`
        });
      }
    }

    // Bash syntax pre-check (SWE-agent pattern: run bash -n before execution)
    if (call.name === "bash" && typeof call.input.command === "string" && !call.input.dryRun) {
      const syntaxError = await this.bashSyntaxCheck(call.input.command);
      if (syntaxError) {
        return {
          name: call.name,
          ok: false,
          reason: call.reason,
          approval: { approved: false, action: "bash_side_effect", mode: "auto" as const, reason: "Syntax pre-check failed" },
          error: `Shell syntax error (pre-check): ${syntaxError}`
        };
      }
    }

    const approvalAction = this.getApprovalAction(call);
    const approval = await this.resolveApproval(call, this.options.approvalEngine.decide(approvalAction, call.reason));

    if (!this.options.role.toolPolicy.allowed.includes(call.name)) {
      return this.blockedResult(call, {
        ...approval,
        approved: false,
        mode: "ask",
        reason: `${call.name} is not allowed for role ${this.options.role.id}`
      });
    }

    if (!approval.approved) {
      return this.blockedResult(call, approval);
    }

    // Fire tool.before hook
    if (this.options.hooks) {
      await this.options.hooks.fire("tool.before", {
        sessionId: this.options.sessionId,
        task: call.reason ?? "",
        event: "tool.before",
        data: { tool: call.name, input: call.input }
      });
    }

    await this.emitEvent("tool.called", { tool: call.name, reason: call.reason, action: approval.action });

    try {
      const output = await this.dispatch(call);
      const durationMs = Date.now() - startTime;

      // Fire tool.after hook
      if (this.options.hooks) {
        await this.options.hooks.fire("tool.after", {
          sessionId: this.options.sessionId,
          task: call.reason ?? "",
          event: "tool.after",
          data: { tool: call.name, ok: true, output, durationMs }
        });
      }

      await this.emitEvent("tool.completed", { tool: call.name, ok: true, durationMs });
      return {
        name: call.name,
        ok: true,
        reason: call.reason,
        approval,
        output,
        durationMs
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = error instanceof ProcessExitError ? error.output : undefined;
      const durationMs = Date.now() - startTime;

      // Fire tool.after hook on failure
      if (this.options.hooks) {
        await this.options.hooks.fire("tool.after", {
          sessionId: this.options.sessionId,
          task: call.reason ?? "",
          event: "tool.after",
          data: { tool: call.name, ok: false, error: message, durationMs }
        });
      }

      await this.emitEvent("tool.completed", { tool: call.name, ok: false, error: message, durationMs });
      return {
        name: call.name,
        ok: false,
        reason: call.reason,
        approval,
        output,
        error: message,
        durationMs
      };
    }
  }

  private async resolveApproval(call: ToolCall, decision: ApprovalDecision): Promise<ApprovalDecision> {
    if (decision.approved || decision.mode !== "ask") {
      return decision;
    }
    return this.approvalResolver.resolve(decision, call);
  }

  private async blockedResult(call: ToolCall, approval: ApprovalDecision): Promise<ToolResult> {
    await this.emitEvent("approval.requested", {
      tool: call.name,
      reason: approval.reason,
      action: approval.action
    });
    return {
      name: call.name,
      ok: false,
      reason: call.reason,
      approval,
      error: approval.reason
    };
  }

  private getApprovalAction(call: ToolCall): ApprovalAction {
    if (call.name === "bash") {
      const command = this.getString(call.input.command);
      return SAFE_BASH_PATTERN.test(command) || call.input.dryRun === true ? "test_dry_run" : "bash_side_effect";
    }
    if (call.name === "git") {
      const args = this.getStringArray(call.input.args);
      return args.includes("push") ? "git_push" : "read";
    }
    if (call.name === "browser") {
      const action = this.getString(call.input.action) as BrowserAction;
      return action === "open" || action === "screenshot" || action === "console" || action === "network"
        ? "read"
        : "browser_submit";
    }
    const def = TOOL_DEFINITIONS[call.name];
    return def?.approvalAction ?? "bash_side_effect";
  }

  private isReadOnlyCall(call: ToolCall): boolean {
    const def = TOOL_DEFINITIONS[call.name];
    if (!def) return false; // Unknown tool — treat as side-effect (safe default)
    return !def.sideEffect;
  }

  private async executeReadOnlyBatch(calls: ToolCall[]): Promise<ToolResult[]> {
    const parallelLimit = Math.max(
      1,
      Math.min(this.options.config.tools.parallelReadMax, this.options.config.team.maxWorkers, calls.length)
    );
    const uniqueCalls = new Map<string, ToolCall>();
    const keys = calls.map((call) => {
      const key = `${call.name}:${stableJsonStringify(call.input)}`;
      if (!uniqueCalls.has(key)) {
        uniqueCalls.set(key, call);
      }
      return key;
    });

    const entries = Array.from(uniqueCalls.entries());
    const resultMap = new Map<string, ToolResult>();
    let cursor = 0;

    const worker = async () => {
      while (cursor < entries.length) {
        const current = cursor;
        cursor += 1;
        const [key, call] = entries[current];
        resultMap.set(key, await this.execute(call));
      }
    };

    await Promise.all(
      Array.from({ length: parallelLimit }, async () => worker())
    );

    return keys.map((key) => {
      const result = resultMap.get(key);
      if (!result) {
        throw new Error(`Missing tool result for ${key}`);
      }
      return result;
    });
  }

  private async dispatch(call: ToolCall): Promise<unknown> {
    await this.applyLatencyOverride(call.name);
    switch (call.name) {
      case "read":
        return this.readTool(call.input);
      case "write":
        return this.writeTool(call.input);
      case "apply_patch":
        return this.applyPatchTool(call.input);
      case "grep":
        return this.grepTool(call.input);
      case "glob":
        return this.globTool(call.input);
      case "bash":
        return this.bashTool(call.input);
      case "git":
        return this.gitTool(call.input);
      case "browser":
        return this.browserTool(call.input);
      case "lsp_diagnostics":
        return this.lspDiagnosticsTool(call.input);
      case "lsp_symbols":
        return this.lspSymbolsTool(call.input);
      case "repo_map":
        return this.repoMapTool();
      case "session_history":
        return this.sessionHistoryTool(call.input);
      case "ast_grep":
        return this.astGrepTool(call.input);
      case "web_search":
        return this.webSearchTool(call.input);
      default:
        throw new Error(`Unknown tool: ${call.name}. Available: read, write, apply_patch, grep, glob, bash, git, browser, lsp_diagnostics, lsp_symbols, repo_map, session_history, ast_grep, web_search`);
    }
  }

  private async readTool(input: Record<string, unknown>): Promise<unknown> {
    const filePath = this.resolveWorkspacePath(this.getString(input.path, () => extractPathFromInput(input)));
    const relativePath = path.relative(this.options.cwd, filePath);

    if (input.withHashes === true) {
      return {
        path: relativePath,
        content: await renderFileWithHashes(filePath)
      };
    }

    // Read from sandbox if available (sees staged changes)
    if (this.options.sandbox) {
      try {
        const content = await this.options.sandbox.readFile(relativePath);
        return { path: relativePath, content };
      } catch {
        // Fall through to filesystem
      }
    }

    return {
      path: relativePath,
      content: await fs.readFile(filePath, "utf8")
    };
  }

  private async writeTool(input: Record<string, unknown>): Promise<unknown> {
    const filePath = this.resolveWorkspacePath(this.getString(input.path));
    const content = this.getString(input.content);
    const relativePath = path.relative(this.options.cwd, filePath);

    // Route through sandbox if enabled
    if (this.options.sandbox) {
      const change = await this.options.sandbox.stageWrite(relativePath, content);
      await this.emitEvent("sandbox.staged", { path: relativePath, bytes: Buffer.byteLength(content, "utf8") });
      return {
        path: relativePath,
        bytes: Buffer.byteLength(content, "utf8"),
        staged: true,
        diff: change.diff.slice(0, 500)
      };
    }

    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf8");
    return {
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8")
    };
  }

  private async applyPatchTool(input: Record<string, unknown>): Promise<unknown> {
    const filePath = this.resolveWorkspacePath(this.getString(input.path));
    const edits = (input.edits as HashEdit[] | undefined) ?? [];
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error("apply_patch requires a non-empty edits array");
    }
    await applyHashEdits(filePath, edits);
    return {
      path: path.relative(this.options.cwd, filePath),
      editsApplied: edits.length
    };
  }

  private async globTool(input: Record<string, unknown>): Promise<unknown> {
    const pattern = this.getString(input.pattern);
    const files = await this.walkWorkspace();
    return {
      pattern,
      matches: files.filter((file) => matchesGlob(file, pattern)).slice(0, 200)
    };
  }

  private async grepTool(input: Record<string, unknown>): Promise<unknown> {
    const pattern = this.getString(input.pattern);
    const glob = typeof input.glob === "string" ? input.glob : undefined;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, input.ignoreCase === true ? "i" : "");
    } catch (e) {
      throw new Error(`Invalid regex pattern: "${pattern}" — ${e instanceof Error ? e.message : String(e)}`);
    }
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const relativePath of await this.walkWorkspace()) {
      if (glob && !matchesGlob(relativePath, glob)) {
        continue;
      }
      const absolutePath = path.join(this.options.cwd, relativePath);
      let content: string;
      try {
        content = await fs.readFile(absolutePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({ path: relativePath, line: index + 1, text: line.trim() });
        }
      });
      if (matches.length >= 200) {
        break;
      }
    }
    return { pattern, matches };
  }

  private async bashTool(input: Record<string, unknown>): Promise<unknown> {
    const command = this.getString(input.command);
    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
    const shell = process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    return new Promise((resolve, reject) => {
      const child = spawn(shell, shellArgs, {
        cwd: this.options.cwd,
        env: process.env
      });
      let stdout = "";
      let stderr = "";
      const pendingStreamEvents: Array<Promise<void>> = [];
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout = `${stdout}${text}`.slice(-12_000);
        pendingStreamEvents.push(this.appendToolStreamEvent("bash", "stdout", text));
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr = `${stderr}${text}`.slice(-12_000);
        pendingStreamEvents.push(this.appendToolStreamEvent("bash", "stderr", text));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", async (code, signal) => {
        clearTimeout(timer);
        await Promise.allSettled(pendingStreamEvents);
        const output = {
          command,
          exitCode: code ?? -1,
          signal: signal ?? null,
          stdout,
          stderr
        };
        if ((code ?? -1) !== 0) {
          reject(new ProcessExitError(buildExitMessage("bash", command, output.exitCode, stderr, stdout), output));
          return;
        }
        resolve(output);
      });
    });
  }

  private async gitTool(input: Record<string, unknown>): Promise<unknown> {
    const args = this.getStringArray(input.args);
    if (args.length === 0) {
      throw new Error("git requires a non-empty args array");
    }
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.options.cwd,
        env: process.env
      });
      let stdout = "";
      let stderr = "";
      const pendingStreamEvents: Array<Promise<void>> = [];
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout = `${stdout}${text}`.slice(-12_000);
        pendingStreamEvents.push(this.appendToolStreamEvent("git", "stdout", text));
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr = `${stderr}${text}`.slice(-12_000);
        pendingStreamEvents.push(this.appendToolStreamEvent("git", "stderr", text));
      });
      child.on("error", reject);
      child.on("exit", async (code) => {
        await Promise.allSettled(pendingStreamEvents);
        const output = {
          args,
          exitCode: code ?? -1,
          stdout,
          stderr
        };
        if ((code ?? -1) !== 0 && isNotGitRepository(stderr)) {
          resolve({
            ...output,
            available: false,
            repository: false
          });
          return;
        }
        if ((code ?? -1) !== 0) {
          reject(new ProcessExitError(buildExitMessage("git", `git ${args.join(" ")}`, output.exitCode, stderr, stdout), {
            ...output,
            signal: null
          }));
          return;
        }
        resolve(output);
      });
    });
  }

  private async browserTool(input: Record<string, unknown>): Promise<unknown> {
    const action = this.getString(input.action) as BrowserAction;
    assertAllowedBrowserAction(action);
    const health = await getBrowserHealth();
    if (!health.available) {
      throw new Error(health.reason ?? "Browser runtime unavailable");
    }

    const playwright = await loadPlaywrightCore();
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sessionName = typeof input.sessionName === "string" ? input.sessionName : "default";
    const sessionPaths = getBrowserSessionPaths(
      this.options.cwd,
      this.options.config.sessions.localDirName,
      this.options.sessionId,
      sessionName
    );
    await ensureDir(sessionPaths.browserDir);
    const latestCheckpoint = await readLatestBrowserCheckpoint(
      this.options.cwd,
      this.options.config.sessions.localDirName,
      this.options.sessionId,
      sessionName
    );
    const browser = await playwright.chromium.launch({
      headless: this.options.config.browser.headless,
      executablePath
    });
    const context = await browser.newContext({
      storageState: await fileExists(sessionPaths.statePath) ? sessionPaths.statePath : undefined
    });
    const page = await context.newPage();
    const url = typeof input.url === "string" ? input.url : latestCheckpoint?.url;
    if (!url) {
      throw new Error("Browser action requires a url or a previous checkpoint for the session");
    }
    const consoleMessages: string[] = [];
    const requests: string[] = [];
    page.on("console", (message) => {
      consoleMessages.push(message.text());
    });
    page.on("request", (request) => {
      requests.push(request.url());
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    try {
      let screenshotPath: string | undefined;
      if (action === "open") {
        const checkpoint = await writeBrowserCheckpoint({
          cwd: this.options.cwd,
          localDirName: this.options.config.sessions.localDirName,
          sessionId: this.options.sessionId,
          sessionName,
          action,
          url: page.url(),
          title: await page.title()
        });
        await context.storageState({ path: sessionPaths.statePath });
        return {
          action,
          sessionName,
          url: page.url(),
          title: await page.title(),
          checkpoint
        };
      }
      if (action === "console") {
        await page.waitForTimeout(500);
        const checkpoint = await writeBrowserCheckpoint({
          cwd: this.options.cwd,
          localDirName: this.options.config.sessions.localDirName,
          sessionId: this.options.sessionId,
          sessionName,
          action,
          url: page.url(),
          title: await page.title(),
          consoleMessages: consoleMessages.slice(0, 50)
        });
        await context.storageState({ path: sessionPaths.statePath });
        return { action, sessionName, messages: consoleMessages.slice(0, 50), checkpoint };
      }
      if (action === "network") {
        await page.waitForTimeout(500);
        const checkpoint = await writeBrowserCheckpoint({
          cwd: this.options.cwd,
          localDirName: this.options.config.sessions.localDirName,
          sessionId: this.options.sessionId,
          sessionName,
          action,
          url: page.url(),
          title: await page.title(),
          requests: requests.slice(0, 100)
        });
        await context.storageState({ path: sessionPaths.statePath });
        return { action, sessionName, requests: requests.slice(0, 100), checkpoint };
      }
      if (action === "screenshot") {
        const outputPath = this.resolveBrowserOutputPath(
          typeof input.outputPath === "string" ? input.outputPath : undefined
        );
        await ensureDir(path.dirname(outputPath));
        await page.screenshot({ path: outputPath, fullPage: input.fullPage === true });
        screenshotPath = path.relative(this.options.cwd, outputPath);
        const checkpoint = await writeBrowserCheckpoint({
          cwd: this.options.cwd,
          localDirName: this.options.config.sessions.localDirName,
          sessionId: this.options.sessionId,
          sessionName,
          action,
          url: page.url(),
          title: await page.title(),
          screenshotPath
        });
        await context.storageState({ path: sessionPaths.statePath });
        return {
          action,
          sessionName,
          path: screenshotPath,
          checkpoint
        };
      }
      const selector = this.getString(input.selector);
      if (action === "click") {
        await page.locator(selector).click();
        await page.waitForTimeout(500);
        if (input.captureScreenshot === true) {
          const outputPath = this.resolveBrowserOutputPath(undefined);
          await ensureDir(path.dirname(outputPath));
          await page.screenshot({ path: outputPath, fullPage: false });
          screenshotPath = path.relative(this.options.cwd, outputPath);
        }
        const checkpoint = await writeBrowserCheckpoint({
          cwd: this.options.cwd,
          localDirName: this.options.config.sessions.localDirName,
          sessionId: this.options.sessionId,
          sessionName,
          action,
          url: page.url(),
          title: await page.title(),
          screenshotPath
        });
        await context.storageState({ path: sessionPaths.statePath });
        return {
          action,
          sessionName,
          url: page.url(),
          title: await page.title(),
          checkpoint
        };
      }
      await page.locator(selector).fill(this.getString(input.text));
      if (input.submit === true) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
      }
      if (input.captureScreenshot === true) {
        const outputPath = this.resolveBrowserOutputPath(undefined);
        await ensureDir(path.dirname(outputPath));
        await page.screenshot({ path: outputPath, fullPage: false });
        screenshotPath = path.relative(this.options.cwd, outputPath);
      }
      const checkpoint = await writeBrowserCheckpoint({
        cwd: this.options.cwd,
        localDirName: this.options.config.sessions.localDirName,
        sessionId: this.options.sessionId,
        sessionName,
        action,
        url: page.url(),
        title: await page.title(),
        screenshotPath
      });
      await context.storageState({ path: sessionPaths.statePath });
      return {
        action,
        sessionName,
        url: page.url(),
        title: await page.title(),
        checkpoint
      };
    } finally {
      await browser.close();
    }
  }

  private async lspDiagnosticsTool(input: Record<string, unknown>): Promise<unknown> {
    const filePath = this.resolveWorkspacePath(this.getString(input.path, () => extractPathFromInput(input)));
    return {
      path: path.relative(this.options.cwd, filePath),
      diagnostics: await getTypeScriptDiagnostics(filePath)
    };
  }

  private async lspSymbolsTool(input: Record<string, unknown>): Promise<unknown> {
    const filePath = this.resolveWorkspacePath(this.getString(input.path, () => extractPathFromInput(input)));
    return {
      path: path.relative(this.options.cwd, filePath),
      symbols: await listTypeScriptSymbols(filePath)
    };
  }

  private async repoMapTool(): Promise<unknown> {
    const repoMapPath = getRepoMapPath(this.options.cwd, this.options.config.sessions.localDirName);
    if (await fileExists(repoMapPath)) {
      return JSON.parse(await fs.readFile(repoMapPath, "utf8")) as unknown;
    }
    return buildRepoMap(this.options.cwd);
  }

  private async sessionHistoryTool(input: Record<string, unknown>): Promise<unknown> {
    const limit = typeof input.limit === "number" ? input.limit : 20;
    const events = await this.options.sessionStore.readEvents(this.options.sessionId);
    return events.slice(-limit);
  }

  private async astGrepTool(input: Record<string, unknown>): Promise<unknown> {
    const pattern = this.getString(input.pattern);
    const language = typeof input.language === "string" ? input.language : undefined;
    return astGrepSearch({
      cwd: this.options.cwd,
      pattern,
      language
    });
  }

  private async webSearchTool(input: Record<string, unknown>): Promise<unknown> {
    const query = this.getString(input.query);
    const maxResults = typeof input.maxResults === "number" ? input.maxResults : 5;
    return webSearch({ query, maxResults });
  }

  private resolveWorkspacePath(inputPath: string): string {
    const resolved = path.resolve(this.options.cwd, inputPath);
    const relative = path.relative(this.options.cwd, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${inputPath}`);
    }
    return resolved;
  }

  private resolveBrowserOutputPath(inputPath?: string): string {
    if (inputPath) {
      return this.resolveWorkspacePath(inputPath);
    }
    return path.join(
      this.options.cwd,
      this.options.config.sessions.localDirName,
      "browser",
      `${createId("capture")}.png`
    );
  }

  private async walkWorkspace(): Promise<string[]> {
    const files: string[] = [];
    const MAX_FILES = 10_000;
    const MAX_DEPTH = 10;
    const visit = async (directory: string, depth: number) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      try {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (files.length >= MAX_FILES) break;
          if (entry.isSymbolicLink()) continue;
          const absolutePath = path.join(directory, entry.name);
          const relativePath = path.relative(this.options.cwd, absolutePath).split(path.sep).join("/");
          if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            await visit(absolutePath, depth + 1);
            continue;
          }
          files.push(relativePath);
        }
      } catch { /* permission denied etc */ }
    };
    await visit(this.options.cwd, 0);
    return files;
  }

  private getString(value: unknown, fallbackExtractor?: () => string | undefined): string {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (fallbackExtractor) {
      const fallback = fallbackExtractor();
      if (fallback && fallback.trim().length > 0) {
        return fallback;
      }
    }
    throw new Error("Expected a non-empty string input");
  }

  private getStringArray(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error("Expected a string array input");
    }
    return value as string[];
  }

  private async applyLatencyOverride(toolName: ToolName): Promise<void> {
    const delayMs = this.options.latencyOverridesMs?.[toolName];
    if (!delayMs || delayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async appendToolStreamEvent(tool: "bash" | "git", stream: "stdout" | "stderr", chunk: string): Promise<void> {
    await this.emitEvent("tool.stream", { tool, stream, chunk: chunk.slice(-1_000) });
  }

  /**
   * Bash syntax pre-check (SWE-agent pattern).
   * Runs `bash -n` on the command before actual execution.
   * Returns null if syntax is valid, or the error message if invalid.
   */
  private async bashSyntaxCheck(command: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-n"], {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", () => resolve(null)); // If bash isn't available, skip check
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(null);
        } else {
          resolve(stderr.trim().slice(0, 500) || "Invalid shell syntax");
        }
      });
      child.stdin.write(command);
      child.stdin.end();
      // Timeout: don't let syntax check hang
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve(null);
      }, 2000);
    });
  }

  /** Unified event emission — uses event bus if available, falls back to session store */
  private async emitEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    if (this.options.eventBus) {
      await this.options.eventBus.emit({
        type: type as any,
        source: "tool",
        at: new Date().toISOString(),
        sessionId: this.options.sessionId,
        payload
      });
    } else {
      await this.options.sessionStore.appendEvent(this.options.sessionId, {
        type: type as any,
        at: new Date().toISOString(),
        payload
      });
    }
  }
}

function isNotGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  const escaped = pattern
    .split("/")
    .map((segment) => {
      if (segment === "**") {
        return ".*";
      }
      return segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".");
    })
    .join("/");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(relativePath);
}

export function listToolDefinitions(): ToolDefinition[] {
  return Object.values(TOOL_DEFINITIONS);
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Extract a file path from tool input when the 'path' field is missing.
 * Providers sometimes put the path in 'file', 'filePath', or even in the 'reason' text.
 */
function extractPathFromInput(input: Record<string, unknown>): string | undefined {
  // Try common alternative field names
  for (const key of ["file", "filePath", "filepath", "filename"]) {
    if (typeof input[key] === "string" && input[key].trim().length > 0) {
      return input[key] as string;
    }
  }
  // Try to extract from reason
  if (typeof input.reason === "string") {
    const pathMatch = input.reason.match(/(?:^|\s)((?:src|tests|app|lib|config)\/[\w/.@-]+\.\w+)/i);
    if (pathMatch) return pathMatch[1];
  }
  return undefined;
}

function buildExitMessage(tool: "bash" | "git", command: string, exitCode: number, stderr: string, stdout: string): string {
  const preview = (stderr || stdout).replace(/\s+/g, " ").trim().slice(0, 200);
  return `${tool} command failed with exit code ${exitCode}: ${command}${preview ? ` :: ${preview}` : ""}`;
}
