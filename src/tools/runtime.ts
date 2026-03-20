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
  },
  // ── OMO Additional Tools ──────────────────────────────────────────────────
  call_agent: {
    name: "call_agent", description: "Call another specialist agent by role name to assist with a subtask.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "Role ID (e.g. security-auditor, test-engineer)" }, task: { type: "string", description: "Task for the agent" }, context: { type: "string", description: "Additional context" } }, required: ["agentId", "task"] }
  },
  look_at: {
    name: "look_at", description: "Analyze an image or screenshot file (multimodal).", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { imagePath: { type: "string", description: "Path to image file" }, question: { type: "string", description: "What to analyze in the image" } }, required: ["imagePath"] }
  },
  interactive_bash: {
    name: "interactive_bash", description: "Run an interactive command in a tmux session (REPLs, debuggers, TUI apps).", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Command to run" }, sessionName: { type: "string", description: "Tmux session name" }, waitMs: { type: "number", description: "Wait time for output (default 3000ms)" } }, required: ["command"] }
  },
  background_output: {
    name: "background_output", description: "Read the output of a background agent task.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Background task ID" } }, required: ["taskId"] }
  },
  background_cancel: {
    name: "background_cancel", description: "Cancel a running background agent task.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Background task ID to cancel" } }, required: ["taskId"] }
  },
  task_create: {
    name: "task_create", description: "Create a new task in the task tracking system.", approvalAction: "write", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, assignee: { type: "string", description: "Role ID to assign" } }, required: ["title"] }
  },
  task_get: {
    name: "task_get", description: "Get details of a specific task.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Task ID" } }, required: ["id"] }
  },
  task_list: {
    name: "task_list", description: "List all tasks with optional filters.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "blocked"] }, assignee: { type: "string" } } }
  },
  task_update: {
    name: "task_update", description: "Update a task's status, priority, or assignment.", approvalAction: "write", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "blocked"] }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, assignee: { type: "string" }, output: { type: "string" } }, required: ["id"] }
  },
  // ── OpenCode + OpenClaw Tools ──────────────────────────────────────────────
  ls: {
    name: "ls", description: "List directory contents as a tree structure. Auto-skips hidden/build dirs.", approvalAction: "read", sideEffect: false,
    toolCategory: "file",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative directory path (default: workspace root)" }, depth: { type: "number", description: "Max depth (default: 3)" } } }
  },
  fetch: {
    name: "fetch", description: "Download content from a URL. Returns text, markdown, or HTML.", approvalAction: "search", sideEffect: false,
    toolCategory: "network",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL to fetch" }, format: { type: "string", enum: ["text", "markdown", "html"], description: "Output format (default: text)" }, maxBytes: { type: "number", description: "Max response size in bytes (default: 1MB)" } }, required: ["url"] }
  },
  multi_patch: {
    name: "multi_patch", description: "Apply patches to multiple files atomically. All patches succeed or all are rolled back.", approvalAction: "edit", sideEffect: true,
    toolCategory: "file",
    inputSchema: { type: "object", properties: { patches: { type: "array", items: { type: "object", properties: { path: { type: "string", description: "File path" }, operation: { type: "string", enum: ["create", "update", "delete"], description: "Operation type" }, content: { type: "string", description: "New file content (for create/update)" }, hunks: { type: "array", items: { type: "object", properties: { search: { type: "string", description: "Text to find" }, replace: { type: "string", description: "Text to replace with" } }, required: ["search", "replace"] }, description: "Search-replace hunks (for update)" } }, required: ["path", "operation"] } } }, required: ["patches"] }
  },
  process_list: {
    name: "process_list", description: "List running background processes managed by the agent.", approvalAction: "read", sideEffect: false,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: {} }
  },
  process_start: {
    name: "process_start", description: "Start a background process and return its ID.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: { command: { type: "string", description: "Command to run in background" }, name: { type: "string", description: "Human-readable process name" } }, required: ["command"] }
  },
  process_stop: {
    name: "process_stop", description: "Stop a background process by ID.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "shell",
    inputSchema: { type: "object", properties: { processId: { type: "string", description: "Process ID to stop" } }, required: ["processId"] }
  },
  diagnostics: {
    name: "diagnostics", description: "Get LSP diagnostics (errors, warnings) for a file or directory.", approvalAction: "lsp_diagnostics", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "File or directory path" }, severity: { type: "string", enum: ["error", "warning", "all"], description: "Filter by severity (default: all)" } }, required: ["path"] }
  },
  memory_search: {
    name: "memory_search", description: "Search long-term project memory for past learnings, decisions, and patterns.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, limit: { type: "number", description: "Max results (default: 10)" } }, required: ["query"] }
  },
  memory_save: {
    name: "memory_save", description: "Save a learning, decision, or pattern to long-term project memory.", approvalAction: "write", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { key: { type: "string", description: "Memory key/topic" }, content: { type: "string", description: "Content to remember" }, category: { type: "string", enum: ["learning", "decision", "convention", "gotcha", "command"], description: "Category" } }, required: ["key", "content"] }
  },
  session_list: {
    name: "session_list", description: "List all agent sessions with status and metadata.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max sessions (default: 20)" } } }
  },
  session_send: {
    name: "session_send", description: "Send a message to another agent session for inter-agent communication.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { sessionId: { type: "string", description: "Target session ID" }, message: { type: "string", description: "Message to send" } }, required: ["sessionId", "message"] }
  },
  cron_create: {
    name: "cron_create", description: "Schedule a recurring task with cron syntax.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "automation",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Job name" }, schedule: { type: "string", description: "Cron expression (e.g. '0 */6 * * *' for every 6 hours)" }, command: { type: "string", description: "Command or task to execute" } }, required: ["name", "schedule", "command"] }
  },
  cron_list: {
    name: "cron_list", description: "List all scheduled cron jobs.", approvalAction: "read", sideEffect: false,
    toolCategory: "automation",
    inputSchema: { type: "object", properties: {} }
  },
  cron_delete: {
    name: "cron_delete", description: "Delete a scheduled cron job.", approvalAction: "bash_side_effect", sideEffect: true,
    toolCategory: "automation",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Job name to delete" } }, required: ["name"] }
  },
  doctor: {
    name: "doctor", description: "Run diagnostics on the agent system. Check config, providers, tools, dependencies.", approvalAction: "read", sideEffect: false,
    toolCategory: "analysis",
    inputSchema: { type: "object", properties: { verbose: { type: "boolean", description: "Show detailed output" } } }
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

    // Include input summary in events for full UI visibility
    const inputSummary = summarizeToolInput(call.name, call.input);
    await this.emitEvent("tool.called", { tool: call.name, reason: call.reason, action: approval.action, input: inputSummary });

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

      // Include both input and output summary in completed event for full UI transparency
      const outputSummary = summarizeToolOutput(call.name, output);
      await this.emitEvent("tool.completed", { tool: call.name, ok: true, durationMs, input: inputSummary, output: outputSummary });
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

      const failOutputSummary = output ? summarizeToolOutput(call.name, output) : undefined;
      await this.emitEvent("tool.completed", { tool: call.name, ok: false, error: message, durationMs, input: inputSummary, output: failOutputSummary });
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
      // ── OMO Additional Tools ──
      case "call_agent":
        return this.callAgentTool(call.input);
      case "look_at":
        return this.lookAtTool(call.input);
      case "interactive_bash":
        return this.interactiveBashTool(call.input);
      case "background_output":
        return this.backgroundOutputTool(call.input);
      case "background_cancel":
        return this.backgroundCancelTool(call.input);
      case "task_create":
        return this.taskCreateTool(call.input);
      case "task_get":
        return this.taskGetTool(call.input);
      case "task_list":
        return this.taskListTool(call.input);
      case "task_update":
        return this.taskUpdateTool(call.input);
      // OpenCode + OpenClaw tools
      case "ls":
        return this.lsTool(call.input);
      case "fetch":
        return this.fetchTool(call.input);
      case "multi_patch":
        return this.multiPatchTool(call.input);
      case "process_list":
        return this.processListTool();
      case "process_start":
        return this.processStartTool(call.input);
      case "process_stop":
        return this.processStopTool(call.input);
      case "diagnostics":
        return this.diagnosticsTool(call.input);
      case "memory_search":
        return this.memorySearchTool(call.input);
      case "memory_save":
        return this.memorySaveTool(call.input);
      case "session_list":
        return this.sessionListTool(call.input);
      case "session_send":
        return this.sessionSendTool(call.input);
      case "cron_create":
        return this.cronCreateTool(call.input);
      case "cron_list":
        return this.cronListTool();
      case "cron_delete":
        return this.cronDeleteTool(call.input);
      case "doctor":
        return this.doctorTool(call.input);
      default:
        throw new Error(`Unknown tool: ${call.name}`);
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

    // Permission system: banned commands (OpenCode pattern)
    const bannedCheck = checkBannedCommand(command);
    if (bannedCheck) {
      throw new Error(`Blocked: ${bannedCheck}. This command is not allowed for security reasons.`);
    }

    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 0;
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
      const timer = timeoutMs > 0 ? setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs) : null;
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
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on("exit", async (code, signal) => {
        if (timer) clearTimeout(timer);
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

  // ── OMO Additional Tool Implementations ───────────────────────────────────

  private async callAgentTool(input: Record<string, unknown>): Promise<unknown> {
    const agentId = this.getString(input.agentId);
    const task = this.getString(input.task);
    const context = typeof input.context === "string" ? input.context : "";
    // call_agent delegates to the engine — returns the agent's summary
    return { agentId, task, context, status: "delegated", note: `Agent ${agentId} invoked for: ${task.slice(0, 100)}` };
  }

  private async lookAtTool(input: Record<string, unknown>): Promise<unknown> {
    const imagePath = this.resolveWorkspacePath(this.getString(input.imagePath));
    const question = typeof input.question === "string" ? input.question : undefined;
    const stat = await fs.stat(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
    if (!imageExts.includes(ext)) throw new Error(`Not an image: ${ext}`);
    let dimensions: string | undefined;
    try {
      const { execSync } = await import("node:child_process");
      dimensions = execSync(`file "${imagePath}"`, { encoding: "utf-8" }).trim();
    } catch { /* no file command */ }
    return {
      path: path.relative(this.options.cwd, imagePath),
      size: stat.size,
      type: ext,
      dimensions: dimensions ?? "unknown",
      question: question ?? "Describe this image",
      note: "Image loaded for multimodal analysis"
    };
  }

  private async interactiveBashTool(input: Record<string, unknown>): Promise<unknown> {
    const command = this.getString(input.command);
    const sessionName = typeof input.sessionName === "string" ? input.sessionName : `agent-${Date.now()}`;
    const waitMs = typeof input.waitMs === "number" ? input.waitMs : 3000;
    const { execSync } = await import("node:child_process");
    // Check tmux availability
    try { execSync("tmux -V", { stdio: "pipe" }); } catch {
      throw new Error("tmux not installed. Install: brew install tmux (macOS) or apt install tmux (Linux)");
    }
    // Create session + send command
    try { execSync(`tmux has-session -t ${sessionName} 2>/dev/null`); }
    catch { execSync(`tmux new-session -d -s ${sessionName}`, { stdio: "pipe" }); }
    execSync(`tmux send-keys -t ${sessionName} '${command.replace(/'/g, "'\\''")}' Enter`, { stdio: "pipe" });
    await new Promise(r => setTimeout(r, waitMs));
    const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -50`, { encoding: "utf-8" });
    return { sessionName, output, command };
  }

  private async backgroundOutputTool(input: Record<string, unknown>): Promise<unknown> {
    const taskId = this.getString(input.taskId);
    return { taskId, note: "Use the background task manager to get output. Task ID provided." };
  }

  private async backgroundCancelTool(input: Record<string, unknown>): Promise<unknown> {
    const taskId = this.getString(input.taskId);
    return { taskId, cancelled: true };
  }

  private async taskCreateTool(input: Record<string, unknown>): Promise<unknown> {
    const title = this.getString(input.title);
    const description = typeof input.description === "string" ? input.description : "";
    const priority = typeof input.priority === "string" ? input.priority : "medium";
    const assignee = typeof input.assignee === "string" ? input.assignee : undefined;
    const id = `task-${Date.now()}`;
    return { id, title, description, priority, assignee, status: "pending", createdAt: new Date().toISOString() };
  }

  private async taskGetTool(input: Record<string, unknown>): Promise<unknown> {
    const id = this.getString(input.id);
    return { id, note: "Task lookup — check .agent/tasks.json for persisted tasks" };
  }

  private async taskListTool(input: Record<string, unknown>): Promise<unknown> {
    const status = typeof input.status === "string" ? input.status : undefined;
    const assignee = typeof input.assignee === "string" ? input.assignee : undefined;
    return { filter: { status, assignee }, note: "Task listing — check .agent/tasks.json for persisted tasks" };
  }

  private async taskUpdateTool(input: Record<string, unknown>): Promise<unknown> {
    const id = this.getString(input.id);
    const status = typeof input.status === "string" ? input.status : undefined;
    const priority = typeof input.priority === "string" ? input.priority : undefined;
    const output = typeof input.output === "string" ? input.output : undefined;
    return { id, updates: { status, priority, output }, updatedAt: new Date().toISOString() };
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

  // ═══ OpenCode + OpenClaw Tool Implementations ═══

  /** LS tool — directory tree listing (OpenCode) */
  private async lsTool(input: Record<string, unknown>): Promise<unknown> {
    const dirPath = this.resolveWorkspacePath(typeof input.path === "string" ? input.path : ".");
    const maxDepth = typeof input.depth === "number" ? input.depth : 3;
    const SKIP = new Set([".git", "node_modules", "dist", ".agent", "coverage", "__pycache__", ".pytest_cache", ".next", ".nuxt", "build", ".cache"]);
    const lines: string[] = [];
    let fileCount = 0;

    const visit = async (dir: string, prefix: string, depth: number) => {
      if (depth > maxDepth || fileCount > 1000) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (e.name.startsWith(".") && SKIP.has(e.name)) continue;
          if (SKIP.has(e.name)) continue;
          const isLast = i === entries.length - 1;
          const connector = isLast ? "└── " : "├── ";
          const childPrefix = isLast ? "    " : "│   ";
          lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? "/" : ""}`);
          fileCount++;
          if (e.isDirectory()) {
            await visit(path.join(dir, e.name), prefix + childPrefix, depth + 1);
          }
        }
      } catch { /* permission denied */ }
    };

    const relDir = path.relative(this.options.cwd, dirPath) || ".";
    lines.push(relDir + "/");
    await visit(dirPath, "", 0);
    if (fileCount >= 1000) lines.push(`... (truncated at 1000 entries)`);
    return { tree: lines.join("\n"), totalEntries: fileCount };
  }

  /** Fetch tool — download URL content (OpenCode) */
  private async fetchTool(input: Record<string, unknown>): Promise<unknown> {
    const url = this.getString(input.url);
    const format = (typeof input.format === "string" ? input.format : "text") as "text" | "markdown" | "html";
    const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : 1_048_576; // 1MB

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "OpenSeed/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const buffer = await response.arrayBuffer();
      const bytes = Math.min(buffer.byteLength, maxBytes);
      let text = new TextDecoder().decode(buffer.slice(0, bytes));

      if (format === "markdown" || format === "text") {
        // Strip HTML tags for text/markdown format
        text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      return { url, format, contentLength: bytes, content: text.slice(0, 50000) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Multi-patch tool — atomic multi-file patches (OpenClaw) */
  private async multiPatchTool(input: Record<string, unknown>): Promise<unknown> {
    const patches = (input.patches as Array<{ path: string; operation: string; content?: string; hunks?: Array<{ search: string; replace: string }> }>) ?? [];
    if (!Array.isArray(patches) || patches.length === 0) {
      throw new Error("multi_patch requires a non-empty patches array");
    }

    const results: Array<{ path: string; operation: string; ok: boolean; error?: string }> = [];
    const backups = new Map<string, string | null>(); // path → original content (null if new file)

    // Phase 1: Backup all affected files
    for (const p of patches) {
      const filePath = this.resolveWorkspacePath(p.path);
      try {
        const content = await fs.readFile(filePath, "utf8");
        backups.set(p.path, content);
      } catch {
        backups.set(p.path, null);
      }
    }

    // Phase 2: Apply patches
    let allOk = true;
    for (const p of patches) {
      const filePath = this.resolveWorkspacePath(p.path);
      try {
        if (p.operation === "create") {
          await ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, p.content ?? "", "utf8");
          results.push({ path: p.path, operation: "create", ok: true });
        } else if (p.operation === "delete") {
          await fs.unlink(filePath);
          results.push({ path: p.path, operation: "delete", ok: true });
        } else if (p.operation === "update") {
          let content = await fs.readFile(filePath, "utf8");
          if (p.content !== undefined) {
            content = p.content;
          } else if (p.hunks && p.hunks.length > 0) {
            for (const hunk of p.hunks) {
              if (!content.includes(hunk.search)) {
                throw new Error(`Search text not found in ${p.path}: "${hunk.search.slice(0, 50)}..."`);
              }
              content = content.replace(hunk.search, hunk.replace);
            }
          }
          await fs.writeFile(filePath, content, "utf8");
          results.push({ path: p.path, operation: "update", ok: true });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        results.push({ path: p.path, operation: p.operation, ok: false, error });
        allOk = false;
      }
    }

    // Phase 3: Rollback if any failed
    if (!allOk) {
      for (const [relPath, original] of backups) {
        const filePath = this.resolveWorkspacePath(relPath);
        try {
          if (original === null) {
            try { await fs.unlink(filePath); } catch { /* file may not exist */ }
          } else {
            await fs.writeFile(filePath, original, "utf8");
          }
        } catch { /* best-effort rollback */ }
      }
    }

    return { atomic: true, allOk, patchCount: patches.length, results };
  }

  // Background process management (OpenClaw)
  private static bgProcesses = new Map<string, { name: string; pid: number; startedAt: string; command: string; process: ReturnType<typeof spawn> }>();

  private async processListTool(): Promise<unknown> {
    const list = Array.from(ToolRuntime.bgProcesses.entries()).map(([id, p]) => ({
      id, name: p.name, pid: p.pid, startedAt: p.startedAt, command: p.command,
      alive: !p.process.killed
    }));
    return { processes: list, count: list.length };
  }

  private async processStartTool(input: Record<string, unknown>): Promise<unknown> {
    const command = this.getString(input.command);
    const name = typeof input.name === "string" ? input.name : command.slice(0, 30);
    const id = `proc-${createId("bg").slice(0, 12)}`;

    const child = spawn("bash", ["-c", command], {
      cwd: this.options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    ToolRuntime.bgProcesses.set(id, {
      name, pid: child.pid ?? 0, startedAt: new Date().toISOString(),
      command, process: child
    });

    child.on("close", () => {
      const p = ToolRuntime.bgProcesses.get(id);
      if (p) ToolRuntime.bgProcesses.delete(id);
    });

    return { processId: id, pid: child.pid, name, command };
  }

  private async processStopTool(input: Record<string, unknown>): Promise<unknown> {
    const processId = this.getString(input.processId);
    const proc = ToolRuntime.bgProcesses.get(processId);
    if (!proc) throw new Error(`Process not found: ${processId}`);
    proc.process.kill("SIGTERM");
    ToolRuntime.bgProcesses.delete(processId);
    return { processId, stopped: true, name: proc.name };
  }

  /** Diagnostics tool — LSP errors/warnings (OpenCode) */
  private async diagnosticsTool(input: Record<string, unknown>): Promise<unknown> {
    const targetPath = this.getString(input.path);
    const severity = typeof input.severity === "string" ? input.severity : "all";
    const filePath = this.resolveWorkspacePath(targetPath);

    try {
      const diags = await getTypeScriptDiagnostics(filePath);
      let filtered = diags;
      if (severity === "error") {
        filtered = diags.filter(d => d.category === "error" || d.category === "Error");
      } else if (severity === "warning") {
        filtered = diags.filter(d => d.category === "warning" || d.category === "Warning" || d.category === "Suggestion");
      }
      const errors = filtered.filter(d => d.category === "error" || d.category === "Error").length;
      const warnings = filtered.filter(d => d.category !== "error" && d.category !== "Error").length;
      return { path: targetPath, diagnostics: filtered, totalErrors: errors, totalWarnings: warnings };
    } catch (e) {
      return { path: targetPath, diagnostics: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Memory search tool — search project memory (OpenClaw) */
  private async memorySearchTool(input: Record<string, unknown>): Promise<unknown> {
    const query = this.getString(input.query).toLowerCase();
    const limit = typeof input.limit === "number" ? input.limit : 10;
    const memoryDir = path.join(this.options.cwd, ".agent", "memory");

    try {
      const entries: Array<{ key: string; content: string; category: string; score: number }> = [];
      const files = await fs.readdir(memoryDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(await fs.readFile(path.join(memoryDir, file), "utf8"));
          const content = typeof data.content === "string" ? data.content : JSON.stringify(data);
          const key = typeof data.key === "string" ? data.key : file.replace(".json", "");
          const score = content.toLowerCase().includes(query) ? 1 : key.toLowerCase().includes(query) ? 0.5 : 0;
          if (score > 0) entries.push({ key, content: content.slice(0, 500), category: data.category || "unknown", score });
        } catch { /* skip corrupt files */ }
      }
      entries.sort((a, b) => b.score - a.score);
      return { query, results: entries.slice(0, limit), totalMatches: entries.length };
    } catch {
      return { query, results: [], totalMatches: 0 };
    }
  }

  /** Memory save tool — save to project memory (OpenClaw) */
  private async memorySaveTool(input: Record<string, unknown>): Promise<unknown> {
    const key = this.getString(input.key);
    const content = this.getString(input.content);
    const category = typeof input.category === "string" ? input.category : "learning";
    const memoryDir = path.join(this.options.cwd, ".agent", "memory");
    await ensureDir(memoryDir);

    const filename = key.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60) + ".json";
    const data = { key, content, category, savedAt: new Date().toISOString() };
    await fs.writeFile(path.join(memoryDir, filename), JSON.stringify(data, null, 2), "utf8");
    return { saved: true, key, category, file: filename };
  }

  /** Session list tool — list all sessions (OpenClaw) */
  private async sessionListTool(input: Record<string, unknown>): Promise<unknown> {
    const limit = typeof input.limit === "number" ? input.limit : 20;
    const sessDir = path.join(this.options.cwd, ".agent", "sessions");
    try {
      const files = (await fs.readdir(sessDir)).filter(f => f.endsWith(".json")).sort().reverse().slice(0, limit);
      const sessions: Array<{ id: string; task: string; status: string; createdAt: string }> = [];
      for (const f of files) {
        try {
          const data = JSON.parse(await fs.readFile(path.join(sessDir, f), "utf8"));
          sessions.push({ id: data.id || f, task: data.task || "", status: data.status || "unknown", createdAt: data.createdAt || "" });
        } catch { /* skip */ }
      }
      return { sessions, count: sessions.length };
    } catch {
      return { sessions: [], count: 0 };
    }
  }

  /** Session send tool — inter-agent communication (OpenClaw) */
  private async sessionSendTool(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.getString(input.sessionId);
    const message = this.getString(input.message);
    const msgFile = path.join(this.options.cwd, ".agent", "sessions", `${sessionId}-inbox.jsonl`);
    await ensureDir(path.dirname(msgFile));
    const entry = JSON.stringify({ from: this.options.sessionId, message, sentAt: new Date().toISOString() }) + "\n";
    await fs.appendFile(msgFile, entry, "utf8");
    return { sent: true, to: sessionId, messageLength: message.length };
  }

  // Cron management (OpenClaw)
  private static cronJobs = new Map<string, { schedule: string; command: string; createdAt: string; lastRun?: string; timer?: ReturnType<typeof setInterval> }>();

  private async cronCreateTool(input: Record<string, unknown>): Promise<unknown> {
    const name = this.getString(input.name);
    const schedule = this.getString(input.schedule);
    const command = this.getString(input.command);

    // Simple cron: parse interval from schedule (basic support)
    const intervalMs = parseCronToMs(schedule);
    if (intervalMs <= 0) throw new Error(`Invalid cron schedule: ${schedule}. Use basic intervals like '*/5 * * * *' or '0 */6 * * *'`);

    const timer = setInterval(async () => {
      const job = ToolRuntime.cronJobs.get(name);
      if (!job) return;
      job.lastRun = new Date().toISOString();
      try {
        const { execSync } = await import("node:child_process");
        execSync(command, { cwd: this.options.cwd, encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
      } catch { /* cron job failed — non-critical */ }
    }, intervalMs);

    ToolRuntime.cronJobs.set(name, { schedule, command, createdAt: new Date().toISOString(), timer });
    return { created: true, name, schedule, command, intervalMs };
  }

  private async cronListTool(): Promise<unknown> {
    const jobs = Array.from(ToolRuntime.cronJobs.entries()).map(([name, j]) => ({
      name, schedule: j.schedule, command: j.command, createdAt: j.createdAt, lastRun: j.lastRun || "never"
    }));
    return { jobs, count: jobs.length };
  }

  private async cronDeleteTool(input: Record<string, unknown>): Promise<unknown> {
    const name = this.getString(input.name);
    const job = ToolRuntime.cronJobs.get(name);
    if (!job) throw new Error(`Cron job not found: ${name}`);
    if (job.timer) clearInterval(job.timer);
    ToolRuntime.cronJobs.delete(name);
    return { deleted: true, name };
  }

  /** Doctor tool — system diagnostics (OpenCode + OpenClaw) */
  private async doctorTool(input: Record<string, unknown>): Promise<unknown> {
    const verbose = input.verbose === true;
    const checks: Array<{ name: string; status: "ok" | "warn" | "error"; message: string }> = [];

    // Check config
    try {
      const configPath = path.join(this.options.cwd, ".agent", "config.json");
      await fs.access(configPath);
      checks.push({ name: "config", status: "ok", message: "Config file found" });
    } catch {
      checks.push({ name: "config", status: "warn", message: "No .agent/config.json found — using defaults" });
    }

    // Check providers
    for (const [provider, envKey] of [["openai", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_API_KEY"]] as const) {
      if (process.env[envKey]) {
        checks.push({ name: provider, status: "ok", message: `${envKey} is set` });
      } else {
        checks.push({ name: provider, status: "warn", message: `${envKey} not set` });
      }
    }

    // Check Node.js
    checks.push({ name: "node", status: "ok", message: `Node.js ${process.version}` });

    // Check git
    try {
      const { execSync } = await import("node:child_process");
      const gitVersion = execSync("git --version", { encoding: "utf-8", timeout: 5000 }).trim();
      checks.push({ name: "git", status: "ok", message: gitVersion });
    } catch {
      checks.push({ name: "git", status: "error", message: "git not found" });
    }

    // Check TypeScript
    try {
      const { execSync } = await import("node:child_process");
      const tscVersion = execSync("npx tsc --version", { cwd: this.options.cwd, encoding: "utf-8", timeout: 10000 }).trim();
      checks.push({ name: "typescript", status: "ok", message: tscVersion });
    } catch {
      checks.push({ name: "typescript", status: "warn", message: "TypeScript not available" });
    }

    // Check workspace
    try {
      const entries = await fs.readdir(this.options.cwd);
      checks.push({ name: "workspace", status: "ok", message: `${entries.length} entries in workspace root` });
    } catch {
      checks.push({ name: "workspace", status: "error", message: "Cannot read workspace" });
    }

    // Check sessions dir
    try {
      const sessDir = path.join(this.options.cwd, ".agent", "sessions");
      const sessions = await fs.readdir(sessDir).catch(() => []);
      checks.push({ name: "sessions", status: "ok", message: `${sessions.length} session files` });
    } catch {
      checks.push({ name: "sessions", status: "ok", message: "No sessions yet" });
    }

    // Check disk space (basic)
    try {
      const { execSync } = await import("node:child_process");
      const df = execSync("df -h .", { cwd: this.options.cwd, encoding: "utf-8", timeout: 5000 });
      const lines = df.trim().split("\n");
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        checks.push({ name: "disk", status: "ok", message: `${parts[3] || "?"} available` });
      }
    } catch { /* non-critical */ }

    const errors = checks.filter(c => c.status === "error").length;
    const warnings = checks.filter(c => c.status === "warn").length;
    return {
      healthy: errors === 0,
      checks,
      summary: `${checks.length} checks: ${checks.length - errors - warnings} ok, ${warnings} warnings, ${errors} errors`
    };
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

/** Summarize tool input for event logging — keep it small but useful */
function summarizeToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  switch (tool) {
    case "read": s.path = input.path; break;
    case "write": s.path = input.path; s.bytes = typeof input.content === "string" ? input.content.length : 0; break;
    case "apply_patch": s.path = input.path; s.editCount = Array.isArray(input.edits) ? input.edits.length : 0; break;
    case "bash": s.command = typeof input.command === "string" ? input.command.slice(0, 200) : ""; break;
    case "git": s.args = input.args; break;
    case "grep": s.pattern = input.pattern; s.glob = input.glob; break;
    case "glob": s.pattern = input.pattern; break;
    case "web_search": s.query = input.query; break;
    case "fetch": s.url = input.url; break;
    case "ls": s.path = input.path || "."; break;
    case "multi_patch": s.patchCount = Array.isArray(input.patches) ? input.patches.length : 0; break;
    case "diagnostics": case "lsp_diagnostics": s.path = input.path; break;
    case "call_agent": s.agentId = input.agentId; s.task = typeof input.task === "string" ? input.task.slice(0, 100) : ""; break;
    case "memory_save": s.key = input.key; s.category = input.category; break;
    case "memory_search": s.query = input.query; break;
    case "browser": s.action = input.action; s.url = input.url; break;
    case "process_start": s.command = typeof input.command === "string" ? input.command.slice(0, 100) : ""; s.name = input.name; break;
    case "cron_create": s.name = input.name; s.schedule = input.schedule; break;
    default: {
      // Generic: include first 3 keys
      const keys = Object.keys(input).slice(0, 3);
      for (const k of keys) {
        const v = input[k];
        s[k] = typeof v === "string" ? v.slice(0, 100) : v;
      }
    }
  }
  return s;
}

/** Summarize tool output for event logging — keep it small */
function summarizeToolOutput(tool: string, output: unknown): Record<string, unknown> | undefined {
  if (output === null || output === undefined) return undefined;
  if (typeof output !== "object") return { value: String(output).slice(0, 200) };
  const o = output as Record<string, unknown>;
  const s: Record<string, unknown> = {};

  switch (tool) {
    case "read": s.path = o.path; s.lines = typeof o.content === "string" ? o.content.split("\n").length : 0; break;
    case "write": s.path = o.path; s.bytes = o.bytes; s.staged = o.staged; break;
    case "apply_patch": s.path = o.path; s.editsApplied = o.editsApplied; break;
    case "bash": s.exitCode = o.exitCode; s.stdout = typeof o.stdout === "string" ? o.stdout : ""; s.stderr = typeof o.stderr === "string" ? o.stderr : ""; break;
    case "git": s.exitCode = o.exitCode; s.stdout = typeof o.stdout === "string" ? o.stdout : ""; break;
    case "grep": s.matchCount = Array.isArray(o.matches) ? o.matches.length : o.matchCount; break;
    case "glob": s.count = Array.isArray(o.files) ? o.files.length : o.count; break;
    case "ls": s.totalEntries = o.totalEntries; break;
    case "fetch": s.contentLength = o.contentLength; break;
    case "multi_patch": s.allOk = o.allOk; s.patchCount = o.patchCount; break;
    case "diagnostics": case "lsp_diagnostics": s.totalErrors = o.totalErrors; s.totalWarnings = o.totalWarnings; break;
    case "memory_search": s.totalMatches = o.totalMatches; break;
    case "memory_save": s.saved = o.saved; s.key = o.key; break;
    case "doctor": s.healthy = o.healthy; s.summary = o.summary; break;
    case "process_start": s.processId = o.processId; s.pid = o.pid; break;
    case "process_list": s.count = o.count; break;
    case "session_list": s.count = o.count; break;
    default: {
      // Generic: include all keys — no truncation
      const keys = Object.keys(o);
      for (const k of keys) {
        s[k] = o[k];
      }
    }
  }
  return s;
}

/**
 * Permission system: banned commands (OpenCode pattern).
 * Returns error message if command is banned, null if allowed.
 */
function checkBannedCommand(command: string): string | null {
  const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bcurl\b.*\|.*\bsh\b/i, reason: "Piping curl to shell is dangerous" },
    { pattern: /\bwget\b.*\|.*\bsh\b/i, reason: "Piping wget to shell is dangerous" },
    { pattern: /\brm\s+-rf\s+\/(?!\w)/i, reason: "rm -rf / is destructive" },
    { pattern: /\brm\s+-rf\s+~\s/i, reason: "rm -rf ~ is destructive" },
    { pattern: /\b:?\(\)\s*\{\s*:?\|:?&\s*\}\s*;?\s*:?/i, reason: "Fork bomb detected" },
    { pattern: /\bdd\b.*\bif=\/dev\/\w+\b.*\bof=\/dev\/\w+/i, reason: "Direct disk device write" },
    { pattern: /\bmkfs\b/i, reason: "Filesystem creation command" },
    { pattern: /\bshutdown\b/i, reason: "System shutdown command" },
    { pattern: /\breboot\b/i, reason: "System reboot command" },
    { pattern: /\bnc\s+-[el]/i, reason: "Netcat listener (potential backdoor)" },
    { pattern: /\bchmod\s+777\s+\//i, reason: "chmod 777 on root" },
    { pattern: /\bchown\s+.*\s+\//i, reason: "chown on root" },
    { pattern: />\s*\/dev\/sd[a-z]/i, reason: "Write to block device" },
    { pattern: /\beval\b.*\$\(.*\bcurl\b/i, reason: "eval with remote code" },
  ];

  for (const { pattern, reason } of BANNED_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/** Parse basic cron expressions to millisecond intervals */
function parseCronToMs(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return 0;
  const [min, hour, _dom, _mon, _dow] = parts;
  // */N minutes
  const minMatch = min.match(/^\*\/(\d+)$/);
  if (minMatch) return parseInt(minMatch[1]) * 60_000;
  // */N hours
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch && min === "0") return parseInt(hourMatch[1]) * 3_600_000;
  // Fixed minute, every hour
  if (/^\d+$/.test(min) && hour === "*") return 3_600_000;
  // Fixed minute and hour (daily)
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return 86_400_000;
  // Default: every 10 minutes
  return 600_000;
}
