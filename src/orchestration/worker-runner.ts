import fs from "node:fs/promises";

import { loadConfig } from "../core/config.js";
import type { AgentEventBus } from "../core/event-bus.js";
import type {
  ExecutorArtifact,
  PlannerArtifact,
  ProviderId,
  ResearchArtifact,
  ReviewResult,
  SpecialistArtifact,
  ToolBearingArtifact,
  RoleDefinition
} from "../core/types.js";
import { extractJsonBlock } from "../core/utils.js";
import { ProviderRegistry } from "../providers/registry.js";
import { getRoleRegistry, resolveRole } from "../roles/registry.js";
import { ApprovalEngine } from "../safety/approval.js";
import { RulesEngine } from "../safety/rules-engine.js";
import { SessionStore } from "../sessions/store.js";
import type { DiffSandbox } from "../tools/diff-sandbox.js";
import { ToolRuntime } from "../tools/runtime.js";
import { isToolBearingArtifact, normalizeSpecialistArtifact } from "./contracts.js";
import { CostTracker } from "./cost-tracker.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import { HookRegistry } from "./hooks.js";
import type { UndoManager } from "./undo.js";
import { parseJsonWithRecovery, truncateObservation, createRetryPolicy } from "./retry.js";
import { learnFromToolOutput, type LearnedPattern } from "./ralph.js";
import { analyzeForSimplification, buildSimplificationReport, detectLanguageFromPath } from "./code-simplifier.js";

function isCoreRole(roleId: string): boolean {
  return roleId === "planner"
    || roleId === "researcher"
    || roleId === "executor"
    || roleId === "reviewer"
    || roleId === "frontend-engineer";
}

function parseRoleArtifact(role: RoleDefinition, rawText: string): PlannerArtifact | ExecutorArtifact | ResearchArtifact | ReviewResult | SpecialistArtifact {
  // Reject obviously broken responses (< 50 chars means LLM didn't follow instructions)
  if (rawText.length < 50 && (role.id === "executor" || role.id === "frontend-engineer")) {
    throw new Error(`SyntaxError: Executor response too short (${rawText.length} chars). LLM did not generate tool calls. Raw: ${rawText}`);
  }

  // Use recovery-aware JSON parser (handles markdown fences, partial JSON, etc.)
  const { parsed: parsedRaw } = parseJsonWithRecovery(rawText);
  const parsed = parsedRaw as PlannerArtifact | ExecutorArtifact | ResearchArtifact | ReviewResult | SpecialistArtifact;

  // Reject executor responses without toolCalls — force retry
  if ((role.id === "executor" || role.id === "frontend-engineer")) {
    const asExec = parsed as unknown as Record<string, unknown>;
    const toolCalls = asExec.toolCalls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      throw new Error(`SyntaxError: Executor must include toolCalls array with at least one tool call. Got: ${JSON.stringify(parsed).slice(0, 100)}`);
    }
  }

  if (role.id === "reviewer") {
    return parsed as ReviewResult;
  }
  if (role.id === "planner") {
    return parsed as PlannerArtifact;
  }
  if (role.id === "researcher") {
    return parsed as ResearchArtifact;
  }
  if (role.id === "executor" || role.id === "frontend-engineer") {
    return normalizeSpecialistArtifact({ id: "executor", category: "execution" }, parsed) as ExecutorArtifact;
  }
  if (!isCoreRole(role.id)) {
    return normalizeSpecialistArtifact(role, parsed);
  }
  return parsed as ExecutorArtifact;
}

export async function runWorkerInline(params: {
  cwd: string;
  sessionId: string;
  taskId: string;
  roleId: string;
  providerId: ProviderId;
  prompt: string;
  costTracker?: CostTracker;
  projectMemory?: ProjectMemoryStore;
  rulesEngine?: RulesEngine;
  hooks?: HookRegistry;
  sandbox?: DiffSandbox;
  eventBus?: AgentEventBus;
  undoManager?: UndoManager;
}): Promise<unknown> {
  const config = await loadConfig(params.cwd);
  const registry = getRoleRegistry(config);
  const role = resolveRole(registry, params.roleId);
  const providers = new ProviderRegistry();
  const store = new SessionStore(params.cwd, config.sessions);
  const response = await providers.invokeWithFailover(config, params.providerId, {
    role: role.id,
    category: role.category,
    systemPrompt: role.prompt,
    prompt: params.prompt,
    responseFormat: "json"
  }, {
    onTextDelta: async (chunk, providerId) => {
      if (chunk.trim().length === 0) {
        return;
      }
      await store.appendEvent(params.sessionId, {
        type: "provider.stream",
        at: new Date().toISOString(),
        payload: {
          provider: providerId,
          role: role.id,
          chunk: chunk.slice(-1_000)
        }
      });
    }
  });
  if ((response.metadata?.attempts ?? 1) > 1) {
    await store.appendEvent(params.sessionId, {
      type: "provider.retry",
      at: new Date().toISOString(),
      payload: {
        provider: response.provider,
        attempts: response.metadata?.attempts ?? 1
      }
    });
  }
  if (response.metadata?.fallbackFrom && response.metadata.fallbackFrom !== response.provider) {
    await store.appendEvent(params.sessionId, {
      type: "provider.fallback",
      at: new Date().toISOString(),
      payload: {
        from: response.metadata.fallbackFrom,
        to: response.provider
      }
    });
  }
  // Record cost data from provider response
  if (params.costTracker && response.usage) {
    params.costTracker.record({
      taskId: params.taskId,
      roleId: params.roleId,
      providerId: response.provider,
      model: response.model,
      usage: {
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0
      }
    });
  }

  // Debug: log raw LLM response
  if (process.env.AGENT40_DEBUG) {
    console.error(`[DEBUG] ${params.roleId} raw response (${response.text.length} chars):\n${response.text.slice(0, 800)}`);
  }

  const artifact = await finalizeRoleArtifact({
    role,
    rawText: response.text,
    cwd: params.cwd,
    sessionId: params.sessionId,
    config,
    store,
    projectMemory: params.projectMemory,
    rulesEngine: params.rulesEngine,
    hooks: params.hooks,
    sandbox: params.sandbox,
    eventBus: params.eventBus,
    undoManager: params.undoManager
  });
  await store.writeArtifact(params.taskId, artifact);
  return artifact;
}

async function finalizeRoleArtifact(params: {
  role: RoleDefinition;
  rawText: string;
  cwd: string;
  sessionId: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  store: SessionStore;
  projectMemory?: ProjectMemoryStore;
  rulesEngine?: RulesEngine;
  hooks?: HookRegistry;
  sandbox?: DiffSandbox;
  eventBus?: AgentEventBus;
  undoManager?: UndoManager;
}): Promise<PlannerArtifact | ExecutorArtifact | ResearchArtifact | ReviewResult | SpecialistArtifact> {
  const artifact = parseRoleArtifact(params.role, params.rawText);
  if (!isToolBearingArtifact(artifact)) {
    return artifact;
  }
  const runtime = new ToolRuntime({
    cwd: params.cwd,
    config: params.config,
    role: params.role,
    sessionId: params.sessionId,
    sessionStore: params.store,
    approvalEngine: new ApprovalEngine(params.config.safety),
    rulesEngine: params.rulesEngine,
    hooks: params.hooks,
    sandbox: params.sandbox,
    eventBus: params.eventBus
  });
  const executionArtifact = artifact as ToolBearingArtifact & SpecialistArtifact;
  const retryPolicy = createRetryPolicy();
  const toolResults = await runtime.executePlan(executionArtifact.toolCalls);
  executionArtifact.toolResults = toolResults;
  if (toolResults.length > 0) {
    const completed = toolResults.filter((result) => result.ok).length;
    const blocked = toolResults.filter((result) => !result.ok).length;
    executionArtifact.summary = `${executionArtifact.summary} Executed ${completed} tool calls${blocked > 0 ? `, ${blocked} blocked or failed` : ""}.`;
    const toolChanges = toolResults.map((result) => result.ok
      ? `tool:${result.name} succeeded`
      : `tool:${result.name} blocked or failed: ${result.error ?? "unknown error"}`);
    appendToolChanges(executionArtifact, toolChanges);

    // Wire UndoManager: track file mutations for rollback
    if (params.undoManager) {
      const mutations: Array<{ path: string; beforeContent: string | null; afterContent: string | null }> = [];
      for (const result of toolResults) {
        if (result.ok && (result.name === "write" || result.name === "apply_patch")) {
          const output = result.output as { path?: string } | undefined;
          if (output?.path) {
            // For sandbox: beforeContent = original, afterContent = staged
            // For direct: we capture after-write content
            mutations.push({
              path: output.path,
              beforeContent: null, // Already captured by sandbox or not trackable post-facto
              afterContent: null   // Placeholder — undo relies on sandbox revert for safe mode
            });
          }
        }
      }
      if (mutations.length > 0) {
        await params.undoManager.recordMutation(params.role.id, mutations, "tool-batch");
      }
    }

    // Wire ProjectMemory: learn from tool results
    if (params.projectMemory) {
      for (const result of toolResults) {
        await params.projectMemory.recordToolCall(result.name, result.ok);

        // Learn from bash outputs
        if (result.name === "bash" && result.ok && result.output) {
          const output = result.output as { command?: string; stdout?: string };
          if (output.command && output.stdout) {
            await params.projectMemory.learnFromBashOutput(output.command, output.stdout);
          }
        }

        // Record file accesses
        if ((result.name === "read" || result.name === "write" || result.name === "apply_patch") && result.ok && result.output) {
          const output = result.output as { path?: string };
          if (output.path) {
            await params.projectMemory.recordFileAccess(output.path);
          }
        }
      }
    }

    // Project Learner: learn patterns from tool outputs (RALPH-style)
    for (const result of toolResults) {
      if (result.ok && result.output) {
        const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        // learnFromToolOutput is pure — we just accumulate patterns
        // The engine will persist them at session end
      }
    }

    // Code Simplifier: analyze written files for quality issues
    for (const result of toolResults) {
      if (result.ok && result.name === "write" && result.output) {
        const output = result.output as { path?: string; content?: string };
        if (output.path) {
          const lang = detectLanguageFromPath(output.path);
          if (lang !== "unknown" && typeof output.content === "string") {
            const issues = analyzeForSimplification(output.content, lang);
            if (issues.length > 0) {
              const report = buildSimplificationReport({ simplified: false, changes: issues, originalLines: output.content.split("\n").length, simplifiedLines: output.content.split("\n").length });
              if (report) {
                executionArtifact.summary += ` Code analysis: ${issues.length} issue(s) found.`;
              }
            }
          }
        }
      }
    }

    // Truncate large tool outputs for context efficiency
    for (const result of toolResults) {
      if (result.ok && typeof result.output === "object" && result.output !== null) {
        const outputObj = result.output as Record<string, unknown>;
        if (typeof outputObj.stdout === "string") {
          const { text, truncated } = truncateObservation(outputObj.stdout, retryPolicy);
          if (truncated) {
            outputObj.stdout = text;
          }
        }
        if (typeof outputObj.content === "string") {
          const { text, truncated } = truncateObservation(outputObj.content, retryPolicy);
          if (truncated) {
            outputObj.content = text;
          }
        }
      }
    }
  }
  return executionArtifact;
}

function appendToolChanges(artifact: ToolBearingArtifact & SpecialistArtifact, toolChanges: string[]): void {
  const arrayFields = [
    "changes",
    "fixes",
    "coverage",
    "docChanges",
    "deliverables",
    "decisions",
    "optimizations",
    "logs",
    "infrastructureChanges",
    "pipelineChanges",
    "phases",
    "schemaChanges",
    "flows"
  ] as const;
  const target = artifact as unknown as Record<string, unknown>;

  for (const field of arrayFields) {
    if (Array.isArray(target[field])) {
      (target[field] as string[]).push(...toolChanges);
      return;
    }
  }
}

export async function runWorkerCommand(options: {
  session: string;
  task: string;
  role: string;
  provider: string;
  promptFile: string;
}): Promise<void> {
  const cwd = process.cwd();
  const prompt = await fs.readFile(options.promptFile, "utf8");
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await runWorkerInline({
        cwd,
        sessionId: options.session,
        taskId: options.task,
        roleId: options.role,
        providerId: options.provider as ProviderId,
        prompt
      });
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < maxRetries && /SyntaxError|too short|must include toolCalls/i.test(msg)) {
        // Retriable: LLM returned bad response, try again
        continue;
      }
      throw error;
    }
  }
}
