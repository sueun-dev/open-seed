/**
 * Guards & Recovery Hooks — OMO-inspired safety and recovery system.
 *
 * All guards run automatically. No setup needed.
 *
 * From oh-my-openagent:
 * - write-existing-file-guard: prevent accidental overwrites
 * - edit-error-recovery: auto-recover from failed edits
 * - context-window-limit-recovery: recover when context exceeds limit
 * - compaction-context-injector: preserve critical context during compaction
 * - compaction-todo-preserver: keep TODO state across compactions
 * - delegate-task-retry: auto-retry failed delegations
 * - todo-continuation-enforcer: force work until all TODOs complete
 * - unstable-agent-babysitter: detect and restart stuck agents
 */

import type { ToolCall, ToolResult } from "../core/types.js";

// ─── Write Existing File Guard ──────────────────────────────────────────────

export interface WriteGuardState {
  /** Files that were READ in this session (safe to write) */
  readFiles: Set<string>;
  /** Files that were CREATED in this session (safe to overwrite) */
  createdFiles: Set<string>;
}

export function createWriteGuard(): WriteGuardState {
  return { readFiles: new Set(), createdFiles: new Set() };
}

export function recordRead(guard: WriteGuardState, path: string): void {
  guard.readFiles.add(path);
}

export function recordCreate(guard: WriteGuardState, path: string): void {
  guard.createdFiles.add(path);
}

/**
 * Check if a write to an existing file is safe.
 * Safe if: file was read first, or file was created in this session.
 */
export function isWriteSafe(guard: WriteGuardState, path: string, fileExists: boolean): { safe: boolean; reason?: string } {
  if (!fileExists) return { safe: true }; // New file creation is always safe
  if (guard.readFiles.has(path)) return { safe: true }; // Read before write
  if (guard.createdFiles.has(path)) return { safe: true }; // Created in this session
  return {
    safe: false,
    reason: `File "${path}" exists but was not read first. Read the file before writing to preserve existing content.`
  };
}

// ─── Edit Error Recovery ─────────────────────────────────────────────────────

export interface EditRecoveryState {
  failedEdits: Array<{ path: string; error: string; attempt: number }>;
  maxRecoveryAttempts: number;
}

export function createEditRecovery(maxAttempts = 3): EditRecoveryState {
  return { failedEdits: [], maxRecoveryAttempts: maxAttempts };
}

export function recordEditFailure(state: EditRecoveryState, path: string, error: string): void {
  const existing = state.failedEdits.find(e => e.path === path);
  if (existing) {
    existing.attempt++;
    existing.error = error;
  } else {
    state.failedEdits.push({ path, error, attempt: 1 });
  }
}

export function getEditRecoveryStrategy(state: EditRecoveryState, path: string): "retry" | "read-and-rewrite" | "escalate" {
  const entry = state.failedEdits.find(e => e.path === path);
  if (!entry) return "retry";
  if (entry.attempt <= 1) return "retry";
  if (entry.attempt <= state.maxRecoveryAttempts) return "read-and-rewrite";
  return "escalate";
}

export function buildEditRecoveryPrompt(path: string, error: string, strategy: string): string {
  switch (strategy) {
    case "retry":
      return `Edit failed on ${path}: ${error}. Try again with the correct content.`;
    case "read-and-rewrite":
      return `Edit failed multiple times on ${path}. Read the ENTIRE file first, then write the complete new content using the write tool instead of edit.`;
    case "escalate":
      return `Edit failed ${error} on ${path} after multiple attempts. Stop trying to edit this file and report the issue.`;
    default:
      return `Edit error on ${path}: ${error}`;
  }
}

// ─── Context Window Recovery ─────────────────────────────────────────────────

export interface ContextState {
  estimatedTokens: number;
  maxTokens: number;
  compactionCount: number;
  /** Critical context that MUST survive compaction */
  preservedContext: string[];
  /** Current TODO state to preserve */
  todoState: Array<{ id: string; content: string; status: string }>;
}

export function createContextState(maxTokens: number): ContextState {
  return { estimatedTokens: 0, maxTokens, compactionCount: 0, preservedContext: [], todoState: [] };
}

export function needsCompaction(state: ContextState): boolean {
  return state.estimatedTokens > state.maxTokens * 0.75;
}

export function addPreservedContext(state: ContextState, context: string): void {
  // Keep only last 10 critical contexts
  state.preservedContext.push(context);
  if (state.preservedContext.length > 10) state.preservedContext.shift();
}

export function buildCompactionInjection(state: ContextState): string {
  const parts: string[] = [];

  if (state.preservedContext.length > 0) {
    parts.push("# Preserved Context (from before compaction)");
    parts.push(...state.preservedContext);
  }

  if (state.todoState.length > 0) {
    parts.push("# TODO State (preserved across compaction)");
    for (const todo of state.todoState) {
      const mark = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "►" : "○";
      parts.push(`${mark} ${todo.content}`);
    }
  }

  if (state.compactionCount > 0) {
    parts.push(`(Context was compacted ${state.compactionCount} time(s). Above is the preserved critical state.)`);
  }

  return parts.join("\n");
}

// ─── Delegation Retry ────────────────────────────────────────────────────────

export interface DelegationRetryState {
  failures: Map<string, { attempts: number; lastError: string }>;
  maxRetries: number;
}

export function createDelegationRetry(maxRetries = 2): DelegationRetryState {
  return { failures: new Map(), maxRetries };
}

export function shouldRetryDelegation(state: DelegationRetryState, taskId: string, error: string): boolean {
  const entry = state.failures.get(taskId);
  if (!entry) {
    state.failures.set(taskId, { attempts: 1, lastError: error });
    return true;
  }
  entry.attempts++;
  entry.lastError = error;
  return entry.attempts <= state.maxRetries;
}

// ─── TODO Continuation Enforcer ──────────────────────────────────────────────

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export function getIncompleteTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter(t => t.status !== "completed" && t.status !== "blocked");
}

export function shouldContinueWork(todos: TodoItem[]): { continue: boolean; reason: string } {
  const incomplete = getIncompleteTodos(todos);
  if (incomplete.length === 0) return { continue: false, reason: "All tasks completed" };

  const inProgress = todos.filter(t => t.status === "in_progress");
  if (inProgress.length > 0) {
    return { continue: true, reason: `${inProgress.length} task(s) still in progress: ${inProgress.map(t => t.content).join(", ")}` };
  }

  return { continue: true, reason: `${incomplete.length} task(s) remaining: ${incomplete.map(t => t.content).join(", ")}` };
}

export function buildContinuationPrompt(todos: TodoItem[]): string {
  const incomplete = getIncompleteTodos(todos);
  if (incomplete.length === 0) return "";

  return [
    "## Incomplete Tasks — MUST complete before finishing",
    "",
    ...incomplete.map(t => `- [${t.status === "in_progress" ? "►" : " "}] ${t.content}`),
    "",
    "Continue working on the next incomplete task. Mark each completed as you finish."
  ].join("\n");
}

// ─── Unstable Agent Babysitter ───────────────────────────────────────────────

export interface AgentHealthState {
  consecutiveEmptyResponses: number;
  consecutiveParseErrors: number;
  lastResponseLength: number;
  totalResponses: number;
}

export function createAgentHealth(): AgentHealthState {
  return { consecutiveEmptyResponses: 0, consecutiveParseErrors: 0, lastResponseLength: 0, totalResponses: 0 };
}

export function recordResponse(health: AgentHealthState, responseLength: number, parseOk: boolean): void {
  health.totalResponses++;
  health.lastResponseLength = responseLength;

  if (responseLength < 50) {
    health.consecutiveEmptyResponses++;
  } else {
    health.consecutiveEmptyResponses = 0;
  }

  if (!parseOk) {
    health.consecutiveParseErrors++;
  } else {
    health.consecutiveParseErrors = 0;
  }
}

export function isAgentUnstable(health: AgentHealthState): { unstable: boolean; reason?: string } {
  if (health.consecutiveEmptyResponses >= 3) {
    return { unstable: true, reason: `${health.consecutiveEmptyResponses} consecutive empty/short responses` };
  }
  if (health.consecutiveParseErrors >= 3) {
    return { unstable: true, reason: `${health.consecutiveParseErrors} consecutive parse errors` };
  }
  return { unstable: false };
}

export function getRecoveryAction(health: AgentHealthState): "retry" | "switch-model" | "escalate" {
  if (health.consecutiveEmptyResponses >= 5 || health.consecutiveParseErrors >= 5) return "escalate";
  if (health.consecutiveEmptyResponses >= 3 || health.consecutiveParseErrors >= 3) return "switch-model";
  return "retry";
}
