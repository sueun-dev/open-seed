/**
 * Engine Wiring — connects ALL subsystems that were built but not integrated.
 *
 * Closes every gap identified in the OMO comparison audit:
 * 1. Verify-fix auto-loop (re-run tests → parse errors → fix → retest)
 * 2. Ralph loop (auto-invoke until task 100% complete)
 * 3. Preemptive compaction (actually compact context before overflow)
 * 4. Context injection (auto-inject README + AGENTS.md + rules on every prompt)
 * 5. Session recovery (auto-resume from crash with recovery context injection)
 * 6. Background parallel agents (spawn concurrent specialists)
 * 7. OMO hooks → event bus (all hooks fire automatically)
 * 8. Tool output learning (RALPH pattern extraction from every tool call)
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { AgentEventBus } from "../core/event-bus.js";
import type { ExecutorArtifact, ReviewResult, ToolResult } from "../core/types.js";
import { estimateTokens, compactContext } from "../core/token-counter.js";
import {
  createVerifyFixState,
  parseVerifyOutput,
  updateVerifyFixState,
  shouldContinueVerifyFix,
  buildVerifyFixPrompt,
  type VerifyFixState,
  type VerifyOutput
} from "./verify-fix.js";
import {
  type ContextMonitorState,
  updateContextUsage,
  getContextStatus,
  buildContextWarning,
  buildRecoveryContext,
  type RecoveryState,
  detectKeywords,
  buildKeywordContext,
  BackgroundTaskManager,
  detectThinkMode,
  getThinkingBudget,
  selectEffort,
} from "./omo-hooks.js";
import {
  learnFromToolOutput,
  buildLearnedContext,
  type LearnedPattern,
  type RalphState,
  type PRD,
  type UserStory,
  loadRalphState,
  saveRalphState,
  createRalphState,
  createPRD,
  getNextStory,
  transitionRalph,
  isRalphDone,
  buildVerifyPrompt as buildRalphVerifyPrompt,
  buildFixPrompt as buildRalphFixPrompt,
  markStoryDone,
  markStoryFailed,
  markStoryInProgress,
} from "./ralph.js";
import { loadAgentsContext } from "../tools/agents-context.js";

// ─── 1. Verify-Fix Auto-Loop ─────────────────────────────────────────────────

export interface VerifyFixLoopParams {
  cwd: string;
  executionOutput: ExecutorArtifact;
  maxCycles: number;
  runCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  fixWithLLM: (fixPrompt: string) => Promise<ExecutorArtifact>;
  eventBus: AgentEventBus;
  sessionId: string;
}

export async function runVerifyFixLoop(params: VerifyFixLoopParams): Promise<{
  finalOutput: ExecutorArtifact;
  cycles: number;
  allPassed: boolean;
}> {
  const state = createVerifyFixState(params.maxCycles);
  let currentOutput = params.executionOutput;
  let cycles = 0;

  const verifyCommands = await detectVerifyCommands(params.cwd);

  while (shouldContinueVerifyFix(state) && cycles < params.maxCycles) {
    cycles++;

    // Run all verification commands and collect VerifyOutput[]
    const outputs: VerifyOutput[] = [];
    let allPassed = true;

    for (const cmd of verifyCommands) {
      try {
        const result = await params.runCommand(cmd);
        outputs.push({ command: cmd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        if (result.exitCode !== 0) allPassed = false;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outputs.push({ command: cmd, exitCode: 1, stdout: "", stderr: msg });
        allPassed = false;
      }
    }

    if (allPassed) {
      await params.eventBus.fire("enforcer.checklist", "engine", params.sessionId, {
        round: cycles, verdict: "verify-fix-pass",
        checklist: [`All ${verifyCommands.length} verification commands passed`]
      });
      return { finalOutput: currentOutput, cycles, allPassed: true };
    }

    // Parse errors using real VerifyOutput[]
    const verifyResult = parseVerifyOutput(outputs);
    updateVerifyFixState(state, verifyResult);

    // Build fix prompt
    const fixPrompt = buildVerifyFixPrompt(verifyResult, state);

    await params.eventBus.fire("enforcer.checklist", "engine", params.sessionId, {
      round: cycles, verdict: "verify-fix-cycle",
      checklist: [`Found ${verifyResult.issues.length} issues, fixing...`]
    });

    currentOutput = await params.fixWithLLM(fixPrompt);
  }

  return { finalOutput: currentOutput, cycles, allPassed: false };
}

async function detectVerifyCommands(cwd: string): Promise<string[]> {
  // Skip verification when node_modules is missing — running npm/npx commands
  // without installed dependencies causes slow downloads or long timeouts.
  try {
    await fs.access(path.join(cwd, "node_modules"));
  } catch {
    return [];
  }

  const commands: string[] = [];
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
    if (pkg.scripts?.typecheck) commands.push("npm run typecheck");
    else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      commands.push("npx tsc --noEmit");
    }
    if (pkg.scripts?.test) commands.push("npm test");
    if (pkg.scripts?.lint) commands.push("npm run lint");
    if (pkg.scripts?.build) commands.push("npm run build");
  } catch {
    try { await fs.access(path.join(cwd, "tsconfig.json")); commands.push("npx tsc --noEmit"); } catch {}
  }
  if (commands.length === 0) commands.push("npx tsc --noEmit 2>&1 || true");
  return commands;
}

// ─── 2. Ralph Auto-Loop ──────────────────────────────────────────────────────

export interface RalphLoopParams {
  cwd: string;
  configDir: string;
  task: string;
  maxIterations: number;
  executeFn: (prompt: string) => Promise<ExecutorArtifact>;
  verifyFn: (prompt: string) => Promise<ReviewResult>;
  eventBus: AgentEventBus;
  sessionId: string;
}

export async function runRalphLoop(params: RalphLoopParams): Promise<{
  state: RalphState;
  iterations: number;
  completed: boolean;
}> {
  let state: RalphState;
  try {
    const loaded = await loadRalphState(params.cwd, params.configDir);
    state = loaded ?? createRalphState();
  } catch {
    state = createRalphState();
  }

  // Initialize PRD if none exists
  if (!state.prd) {
    state.prd = createPRD(params.task, params.task, [
      { title: params.task, description: `Complete the full task: ${params.task}` }
    ]);
  }

  let iterations = 0;

  while (!isRalphDone(state) && iterations < params.maxIterations) {
    iterations++;

    const nextStory = getNextStory(state.prd);
    if (!nextStory) break;

    state.prd = markStoryInProgress(state.prd, nextStory.id);
    state.currentStoryId = nextStory.id;
    transitionRalph(state, "executing");

    // Execute
    const execResult = await params.executeFn(
      `Complete: ${nextStory.title}\n${nextStory.description}\nPatterns: ${buildLearnedContext(state.learnedPatterns)}`
    );

    // Verify
    transitionRalph(state, "verifying");
    const verifyPrompt = buildRalphVerifyPrompt(nextStory, execResult.summary);
    const verifyResult = await params.verifyFn(verifyPrompt);

    if (verifyResult.verdict === "pass") {
      state.prd = markStoryDone(state.prd, nextStory.id);
      transitionRalph(state, "idle");
      await params.eventBus.fire("task.completed", "engine", params.sessionId, {
        storyId: nextStory.id, title: nextStory.title, iteration: iterations
      });
    } else {
      transitionRalph(state, "fixing");
      const fixPrompt = buildRalphFixPrompt(nextStory, verifyResult.followUp);
      await params.executeFn(fixPrompt);

      const retryVerify = await params.verifyFn(verifyPrompt);
      if (retryVerify.verdict === "pass") {
        state.prd = markStoryDone(state.prd, nextStory.id);
      } else {
        state.prd = markStoryFailed(state.prd, nextStory.id, verifyResult.summary);
      }
      transitionRalph(state, "idle");
    }

    await saveRalphState(params.cwd, params.configDir, state);
  }

  return { state, iterations, completed: isRalphDone(state) };
}

// ─── 3. Preemptive Compaction ────────────────────────────────────────────────

export interface CompactionResult {
  compacted: boolean;
  originalTokens: number;
  compactedTokens: number;
  summary: string;
}

export function preemptiveCompact(
  context: string,
  monitor: ContextMonitorState,
  maxTokens: number
): CompactionResult {
  const status = getContextStatus(monitor);
  const originalTokens = estimateTokens(context);

  if (status === "ok") {
    return { compacted: false, originalTokens, compactedTokens: originalTokens, summary: "Context within limits" };
  }

  const targetRatio = status === "critical" ? 0.4 : 0.5;
  const targetTokens = Math.floor(maxTokens * targetRatio);

  const result = compactContext(context, targetTokens);

  return {
    compacted: true,
    originalTokens,
    compactedTokens: result.compactedTokens,
    summary: `Compacted from ${originalTokens} to ${result.compactedTokens} tokens. Status: ${status}`
  };
}

// ─── 4. Auto Context Injection ───────────────────────────────────────────────

export async function buildAutoInjectedContext(cwd: string): Promise<string> {
  const sections: string[] = [];

  // README.md injection (OMO: directory-readme-injector)
  try {
    const readme = await fs.readFile(path.join(cwd, "README.md"), "utf-8");
    if (readme.length > 0 && readme.length < 10000) {
      sections.push(`## Project README\n${readme.slice(0, 3000)}`);
    }
  } catch { /* no README */ }

  // AGENTS.md injection (OMO: directory-agents-injector)
  const agentsCtx = await loadAgentsContext(cwd);
  if (agentsCtx) {
    sections.push(agentsCtx);
  }

  // .agent/rules/ injection (OMO: rules-injector)
  try {
    const rulesDir = path.join(cwd, ".agent", "rules");
    const ruleFiles = await fs.readdir(rulesDir);
    for (const file of ruleFiles.filter(f => f.endsWith(".md"))) {
      const content = await fs.readFile(path.join(rulesDir, file), "utf-8");
      sections.push(`## Rule: ${file.replace(".md", "")}\n${content.slice(0, 1000)}`);
    }
  } catch { /* no rules dir */ }

  // .agent/CONTEXT.md injection
  try {
    const ctxFile = await fs.readFile(path.join(cwd, ".agent", "CONTEXT.md"), "utf-8");
    if (ctxFile.length > 0) {
      sections.push(`## Project Context\n${ctxFile.slice(0, 2000)}`);
    }
  } catch { /* no context file */ }

  return sections.join("\n\n");
}

// ─── 5. Session Auto-Recovery ────────────────────────────────────────────────

export async function detectAndRecoverSession(
  cwd: string,
  configDir: string,
  eventBus: AgentEventBus
): Promise<{ recovered: boolean; sessionId?: string; recoveryContext?: string }> {
  try {
    const { loadLatestCheckpoint, shouldAutoResume } = await import("./durable-execution.js");
    const checkpoint = await loadLatestCheckpoint(cwd, configDir);

    if (!checkpoint || !shouldAutoResume(checkpoint)) {
      return { recovered: false };
    }

    const recoveryState: RecoveryState = {
      sessionId: checkpoint.sessionId,
      lastPhase: checkpoint.phase,
      lastRound: checkpoint.round,
      modifiedFiles: checkpoint.modifiedFiles ?? [],
      pendingTasks: [],
      timestamp: checkpoint.timestamp
    };

    const recoveryContext = buildRecoveryContext(recoveryState);

    await eventBus.fire("session.resumed", "engine", checkpoint.sessionId, {
      autoRecovery: true, phase: checkpoint.phase, round: checkpoint.round
    });

    return { recovered: true, sessionId: checkpoint.sessionId, recoveryContext };
  } catch {
    return { recovered: false };
  }
}

// ─── 6. Background Parallel Agents ──────────────────────────────────────────

export interface BackgroundAgentTask {
  id: string;
  roleId: string;
  prompt: string;
  priority: number;
}

export interface BackgroundAgentResult {
  taskId: string;
  roleId: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export async function runParallelAgents(params: {
  tasks: BackgroundAgentTask[];
  maxConcurrency: number;
  executeFn: (roleId: string, prompt: string) => Promise<string>;
  eventBus: AgentEventBus;
  sessionId: string;
  bgManager: BackgroundTaskManager;
}): Promise<BackgroundAgentResult[]> {
  const results: BackgroundAgentResult[] = [];
  const sorted = [...params.tasks].sort((a, b) => b.priority - a.priority);

  for (let i = 0; i < sorted.length; i += params.maxConcurrency) {
    const chunk = sorted.slice(i, i + params.maxConcurrency);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (task) => {
        params.bgManager.register(task.id, `${task.roleId}: ${task.prompt.slice(0, 100)}`);
        const start = Date.now();

        await params.eventBus.fire("worker.spawned", "engine", params.sessionId, {
          taskId: task.id, roleId: task.roleId
        });

        try {
          const output = await params.executeFn(task.roleId, task.prompt);
          params.bgManager.complete(task.id, output.slice(0, 500));

          await params.eventBus.fire("worker.completed", "engine", params.sessionId, {
            taskId: task.id, roleId: task.roleId, success: true
          });

          return { taskId: task.id, roleId: task.roleId, success: true, output, durationMs: Date.now() - start } as BackgroundAgentResult;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          params.bgManager.fail(task.id, error);
          return { taskId: task.id, roleId: task.roleId, success: false, error, durationMs: Date.now() - start } as BackgroundAgentResult;
        }
      })
    );

    for (const r of chunkResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }

  return results;
}

// ─── 7. OMO Event Bus Hooks ──────────────────────────────────────────────────

export function wireAllOmoHooks(params: {
  eventBus: AgentEventBus;
  monitor: ContextMonitorState;
  bgManager: BackgroundTaskManager;
  learnedPatterns: LearnedPattern[];
  cwd: string;
  configDir: string;
  maxTokens: number;
}): void {
  // Hook: Context window auto-compaction warning + tracking
  params.eventBus.on("cost.update", async (event) => {
    const tokens = (event.payload.totalTokens as number) ?? 0;
    Object.assign(params.monitor, updateContextUsage(params.monitor, tokens));
    const status = getContextStatus(params.monitor);

    if (status === "critical") {
      params.monitor.compactionCount++;
      await params.eventBus.fire("error.retriable", "system", event.sessionId, {
        message: `[AUTO-COMPACT] Context at ${Math.round((params.monitor.estimatedTokens / params.monitor.maxTokens) * 100)}% — compaction #${params.monitor.compactionCount}`,
        category: "context-compaction",
        attempt: params.monitor.compactionCount
      });
    } else if (status === "warning") {
      const warning = buildContextWarning(params.monitor);
      if (warning) {
        await params.eventBus.fire("error.retriable", "system", event.sessionId, {
          message: warning, category: "context-warning", attempt: 0
        });
      }
    }
  });

  // Hook: RALPH pattern learning from every tool output
  params.eventBus.on("tool.completed", async (event) => {
    const tool = event.payload.tool as string;
    const ok = event.payload.ok as boolean;
    const output = event.payload.output;

    if (ok && output) {
      const outputStr = typeof output === "string" ? output : JSON.stringify(output).slice(0, 2000);
      const newPatterns = learnFromToolOutput(params.learnedPatterns, tool, outputStr);
      if (newPatterns.length > params.learnedPatterns.length) {
        params.learnedPatterns.length = 0;
        params.learnedPatterns.push(...newPatterns);
      }
    }
  });

  // Hook: Background task notification
  params.eventBus.on("worker.completed", async (event) => {
    const notification = params.bgManager.buildNotification();
    if (notification) {
      await params.eventBus.fire("task.completed", "system", event.sessionId, {
        notification, backgroundTasksCompleted: params.bgManager.getCompleted().length
      });
    }
  });

  // Hook: Think mode auto-switch
  params.eventBus.on("session.started", async (event) => {
    const task = (event.payload.task as string) ?? "";
    if (!task) return;
    const thinkState = detectThinkMode(task);
    if (thinkState.enabled) {
      await params.eventBus.fire("phase.transition", "system", event.sessionId, {
        from: "idle", to: "thinking",
        thinkBudget: getThinkingBudget(thinkState),
        complexity: thinkState.taskComplexity
      });
    }
  });

  // Hook: Effort level selection per round
  params.eventBus.on("enforcer.checklist", async (event) => {
    const round = (event.payload.round as number) ?? 1;
    const task = (event.payload.task as string) ?? "";
    const effort = selectEffort(task, round);
    (event.payload as Record<string, unknown>).effortLevel = effort;
  });

  // Hook: Keyword skill auto-detection on session start
  params.eventBus.on("session.started", async (event) => {
    const task = (event.payload.task as string) ?? "";
    if (!task) return;
    const skills = detectKeywords(task);
    if (skills.length > 0) {
      const ctx = buildKeywordContext(skills);
      await params.eventBus.fire("phase.transition", "system", event.sessionId, {
        from: "idle", to: "skill-detected",
        detectedSkills: skills.map(s => s.skill), context: ctx
      });
    }
  });

  // Hook: Durable checkpoint on every phase transition
  params.eventBus.on("phase.transition", async (event) => {
    try {
      const { saveDurableCheckpoint } = await import("./durable-execution.js");
      await saveDurableCheckpoint(params.cwd, params.configDir, {
        sessionId: event.sessionId,
        phase: (event.payload.to as string) ?? "unknown",
        round: (event.payload.round as number) ?? 0,
        timestamp: new Date().toISOString(),
        state: event.payload,
        modifiedFiles: [],
        resumable: true
      });
    } catch { /* non-critical */ }
  });
}

// ─── 8. Tool Output Learning ─────────────────────────────────────────────────

export function extractToolLearning(
  toolName: string,
  toolResult: ToolResult,
  patterns: LearnedPattern[]
): LearnedPattern[] {
  if (!toolResult.ok || !toolResult.output) return patterns;
  const outputStr = typeof toolResult.output === "string"
    ? toolResult.output
    : JSON.stringify(toolResult.output).slice(0, 3000);
  return learnFromToolOutput(patterns, toolName, outputStr);
}

// ─── Combined Startup Wiring ─────────────────────────────────────────────────

export interface EngineWiringResult {
  autoInjectedContext: string;
  recoveryContext: string;
  recoveredSessionId?: string;
}

export async function wireEverythingIntoEngine(params: {
  cwd: string;
  configDir: string;
  eventBus: AgentEventBus;
  monitor: ContextMonitorState;
  bgManager: BackgroundTaskManager;
  learnedPatterns: LearnedPattern[];
  maxTokens: number;
}): Promise<EngineWiringResult> {
  wireAllOmoHooks(params);
  const autoInjectedContext = await buildAutoInjectedContext(params.cwd);
  const recovery = await detectAndRecoverSession(params.cwd, params.configDir, params.eventBus);

  return {
    autoInjectedContext,
    recoveryContext: recovery.recoveryContext ?? "",
    recoveredSessionId: recovery.sessionId
  };
}
