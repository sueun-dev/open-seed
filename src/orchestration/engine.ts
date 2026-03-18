/**
 * Orchestration Engine — the core agent loop.
 *
 * Architecture inspired by:
 * - Codex: session-based with resumable checkpoints
 * - OpenHands: event stream for distributed delegation
 * - MetaGPT: state machine with explicit phase transitions
 * - SWE-Agent: retry loop with structured error recovery
 * - CrewAI: task DAG with dependency resolution
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../core/config.js";
import { AgentEventBus } from "../core/event-bus.js";
import type {
  AgentPhase,
  ExecutorArtifact,
  PlannerArtifact,
  ResearchArtifact,
  RoleArtifact,
  ReviewResult,
  SessionRecord,
  SpecialistArtifact,
  WorkerTransport
} from "../core/types.js";
import { nowIso } from "../core/utils.js";
import { ProviderRegistry } from "../providers/registry.js";
import { classifyTask } from "../routing/policy.js";
import { getRoleRegistry, resolveRole } from "../roles/registry.js";
import { ApprovalEngine } from "../safety/approval.js";
import { RulesEngine } from "../safety/rules-engine.js";
import { SessionStore } from "../sessions/store.js";
import { loadAgentsContext } from "../tools/agents-context.js";
import { getBrowserHealth } from "../tools/browser.js";
import { getRepoMapPath } from "../core/paths.js";
import { buildRepoMap } from "../tools/repomap.js";
import { DiffSandbox } from "../tools/diff-sandbox.js";
import {
  augmentPlannerTasks,
  buildDelegationPrompt,
  createDelegationNote,
  selectDelegationAssignments,
  summarizeDelegationArtifacts,
  type DelegationAssignment,
  type DelegationOutcome
} from "./delegation.js";
import { loadDesignReferenceContext } from "./design-references.js";
import {
  buildExecutorPrompt,
  buildPlannerPrompt,
  buildRepoSummary,
  buildResearchPrompt,
  buildReviewerPrompt,
  buildSystemPrompt,
  buildErrorPrompt,
  buildFollowUpPrompt
} from "./prompts.js";
import {
  createEnforcerState,
  updateEnforcerAfterExecution,
  updateEnforcerAfterReview,
  getEnforcerFollowUp,
  isEnforcerDone
} from "./enforcer.js";
import { analyzeIntent, type IntentAnalysis } from "./intent-gate.js";
import { FileCheckpointSaver, createCheckpoint } from "./checkpoint.js";
import { HookRegistry, registerBuiltinHooks } from "./hooks.js";
import { CostTracker } from "./cost-tracker.js";
import { SpawnReservationManager } from "./spawn-reservation.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import { LocalWorkerManager } from "./worker-manager.js";
import { runWorkerInline } from "./worker-runner.js";
import { StuckDetector } from "./stuck-detector.js";
import { loadMicroagents, getActiveMicroagents, buildMicroagentContext } from "./microagents.js";
import { extractSessionMemories, loadConsolidatedMemoryContext } from "../memory/memory-pipeline.js";
import { UndoManager } from "./undo.js";
import { diagnoseError, shouldSelfHeal, buildRecoveryPrompt, detectErrorsInOutput } from "./self-heal.js";
import { learnFromToolOutput, buildLearnedContext, type LearnedPattern } from "./ralph.js";
import { createVerifyFixState, parseVerifyOutput, updateVerifyFixState, shouldContinueVerifyFix, buildVerifyFixPrompt, type VerifyFixState } from "./verify-fix.js";
import { selectModelForRole, buildModelRoutingContext } from "./model-router.js";
import { extractClaims, verifyClaims, buildFactcheckContext } from "./factcheck.js";
import { analyzeForSimplification, buildSimplificationReport, detectLanguageFromPath } from "./code-simplifier.js";
import { createHudState, updateHudFromEvent, formatHudTerminal, wireHudToEventBus, type HudState } from "./hud.js";
import { createWriteGuard, recordRead, recordCreate, createEditRecovery, createAgentHealth, recordResponse, isAgentUnstable, getRecoveryAction, type WriteGuardState, type AgentHealthState } from "./guards.js";
import { createTokenBudget, estimateTokens, compactContext, needsCompaction, updateBudget } from "../core/token-counter.js";
import { getModelVariant, applyVariantToPrompt, detectModelFamily } from "./model-variants.js";
import { wireEventBusToStream, createTerminalWriter } from "./stream-protocol.js";
import {
  assessCodebase,
  verbalizeIntent,
  createEvidenceRequirements,
  updateEvidence,
  allEvidenceSatisfied,
  checkOracleEscalation,
  buildOraclePrompt,
  createSandboxEnvironment
} from "./sisyphus.js";

// ─── Public Interface ────────────────────────────────────────────────────────

export interface RunEngineOptions {
  cwd: string;
  task: string;
  mode: "run" | "team";
  resumeSessionId?: string;
  onSessionReady?: (sessionId: string) => void | Promise<void>;
  /** External event bus for UI integration */
  eventBus?: AgentEventBus;
}

export interface RunEngineResult {
  session: SessionRecord;
  review: ReviewResult;
  intent: IntentAnalysis;
  costs: ReturnType<CostTracker["getSummary"]>;
  /** Event bus used during this run (for post-run inspection) */
  eventBus: AgentEventBus;
  /** Sisyphus evidence status */
  evidence?: import("./sisyphus.js").EvidenceRequirement[];
  /** Undo manager for post-run rollback */
  undoManager: UndoManager;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export async function runEngine(options: RunEngineOptions): Promise<RunEngineResult> {
  const config = await loadConfig(options.cwd);
  const sessionStore = new SessionStore(options.cwd, config.sessions);
  const roleRegistry = getRoleRegistry(config);
  const providerRegistry = new ProviderRegistry();
  const approvalEngine = new ApprovalEngine(config.safety);
  const workerManager = new LocalWorkerManager(config.team.maxWorkers);

  // Event bus — central nervous system
  const eventBus = options.eventBus ?? new AgentEventBus();

  // Subsystems — ALL wired into the pipeline
  const costTracker = new CostTracker();
  if (config.sandbox?.enabled) {
    costTracker.setBudget(50.0); // Default $50 budget guard
  }
  const hooks = new HookRegistry();
  registerBuiltinHooks(hooks);
  const checkpointSaver = new FileCheckpointSaver(options.cwd, config.sessions.localDirName);
  const projectMemory = new ProjectMemoryStore(options.cwd, config.sessions.localDirName);
  const spawnManager = new SpawnReservationManager({ maxConcurrentAgents: config.team.maxWorkers });
  const rulesEngine = await RulesEngine.fromWorkspace(options.cwd, config.rules);
  const stuckDetector = new StuckDetector();

  // Plandex-style DiffSandbox — all writes go to staging first
  const sandbox = config.sandbox?.enabled
    ? new DiffSandbox(options.cwd, path.join(options.cwd, config.sessions.localDirName, "staging"))
    : undefined;

  // Token budget tracking
  const tokenBudget = createTokenBudget(config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-5");

  // Stream protocol — wire event bus to terminal for real-time output
  if (process.stdout.isTTY) {
    wireEventBusToStream(eventBus, createTerminalWriter(process.stderr));
  }

  // HUD — real-time progress display
  const hud = createHudState();
  wireHudToEventBus(eventBus, hud, (h) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`\r\x1b[K${formatHudTerminal(h)}`);
    }
  });

  // Project learner — accumulates patterns across tool executions
  let learnedPatterns: LearnedPattern[] = [];
  try {
    const { loadLearnedPatterns } = await import("./ralph.js");
    learnedPatterns = await loadLearnedPatterns(options.cwd, config.sessions.localDirName);
  } catch { /* first run */ }

  // Verify-Fix state — structured test→parse→fix→retest
  const verifyFixState = createVerifyFixState(config.retry.maxToolRetries + 3);

  // OMO Guards — all run automatically, no setup needed
  const writeGuard = createWriteGuard();
  const editRecovery = createEditRecovery();
  const agentHealth = createAgentHealth();

  // Wire write guard into event bus
  eventBus.on("tool.completed", async (event) => {
    const tool = event.payload.tool as string;
    const ok = event.payload.ok as boolean;
    if (ok && tool === "read") {
      const output = event.payload.output as { path?: string } | undefined;
      if (output?.path) recordRead(writeGuard, output.path);
    }
    if (ok && tool === "write") {
      const output = event.payload.output as { path?: string } | undefined;
      if (output?.path) recordCreate(writeGuard, output.path);
    }
  });

  // Wire event bus to session store for persistence
  eventBus.on("*", async (event) => {
    if (event.sessionId) {
      await sessionStore.appendEvent(event.sessionId, {
        type: event.type,
        at: event.at,
        payload: event.payload
      });
    }
  });

  // Wire cost tracking into event bus
  eventBus.on("provider.stream", async () => {
    // Emit cost update periodically
    const summary = costTracker.getSummary();
    if (summary.entries > 0 && summary.entries % 5 === 0) {
      await eventBus.fire("cost.update", "system", session?.id ?? "", {
        totalCostUsd: summary.totalEstimatedCostUsd,
        totalTokens: summary.totalInputTokens + summary.totalOutputTokens
      });
    }
  });

  // ─── Session Setup ───────────────────────────────────────────────────────

  let session = options.resumeSessionId
    ? await sessionStore.loadSnapshot(options.resumeSessionId)
    : null;

  if (session && session.status === "completed") {
    session.status = "running";
    session.phase = "planning";
    session.updatedAt = nowIso();
    await sessionStore.saveSnapshot(session);
    await eventBus.fire("session.resumed", "engine", session.id, { resumedFrom: session.id });
  }

  if (!session) {
    session = await sessionStore.createSession(options.task, options.resumeSessionId);
    session.phase = "planning";
  }

  await options.onSessionReady?.(session.id);

  // Fire session.start hook
  await hooks.fire("session.start", { sessionId: session.id, task: options.task, event: "session.start", data: {} });

  // ─── Phase: Intent Analysis + Sisyphus Assessment ────────────────────────

  const memoryContext = await projectMemory.getContext();
  const consolidatedMemoryContext = await loadConsolidatedMemoryContext(options.cwd, config.sessions.localDirName);
  const microagentRegistry = await loadMicroagents(options.cwd);
  const activeMicroagents = getActiveMicroagents(microagentRegistry, options.task);
  const microagentContext = buildMicroagentContext(activeMicroagents);
  const intent = analyzeIntent(options.task);

  // Sisyphus Phase 1: Codebase Assessment
  const files = await walkTopLevel(options.cwd);
  const configFiles: Record<string, string> = {};
  for (const f of ["package.json", "pyproject.toml", "Cargo.toml"]) {
    const fp = path.join(options.cwd, f);
    try { configFiles[f] = await fs.readFile(fp, "utf8"); } catch { /* skip */ }
  }
  const codebaseAssessment = assessCodebase(files, configFiles);

  // Sisyphus: Intent Verbalization
  const verbalized = verbalizeIntent(options.task, intent);

  // Sisyphus: Evidence Requirements
  const evidence = createEvidenceRequirements(intent);

  // Model variant detection
  const providerModel = config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-5";
  const modelVariant = getModelVariant(providerModel);

  // Undo Manager
  const undoManager = new UndoManager(options.cwd, session.id, path.join(options.cwd, config.sessions.localDirName));

  await eventBus.fire("session.started", "engine", session.id, {
    intent: intent.action,
    scope: intent.scope,
    risk: intent.risk,
    suggestedRoles: intent.suggestedRoles,
    constraints: intent.constraints,
    skipResearch: intent.skipResearch,
    skipDelegation: intent.skipDelegation,
    codebaseMaturity: codebaseAssessment.maturity,
    verbalized: verbalized.category,
    evidenceCount: evidence.length,
    modelFamily: modelVariant.family
  });

  // ─── Phase: Context Gathering ────────────────────────────────────────────

  const repoMap = await buildRepoMap(options.cwd);
  await fs.writeFile(getRepoMapPath(options.cwd, config.sessions.localDirName), JSON.stringify(repoMap, null, 2), "utf8");

  const browserHealth = await getBrowserHealth();
  const agentsContext = await loadAgentsContext(options.cwd);
  const designReferenceContext = await loadDesignReferenceContext();

  // Inject codebase assessment conventions into context
  const assessmentContext = codebaseAssessment.conventions.length > 0
    ? `# Codebase Conventions (${codebaseAssessment.maturity} project)\n${codebaseAssessment.conventions.map(c => `- ${c}`).join("\n")}${codebaseAssessment.warnings.length > 0 ? `\n\n# Warnings\n${codebaseAssessment.warnings.map(w => `- ${w}`).join("\n")}` : ""}`
    : "";

  // Model routing context
  const modelRoutingCtx = buildModelRoutingContext(options.task);

  // Learned patterns from previous runs
  const learnedCtx = buildLearnedContext(learnedPatterns);

  const combinedContext = [agentsContext, designReferenceContext, memoryContext, consolidatedMemoryContext, microagentContext, assessmentContext, modelRoutingCtx, learnedCtx].filter(Boolean).join("\n\n");
  const requestedCategory = classifyTask(options.task);
  const repoSummary = buildRepoSummary(repoMap);

  const plannerRole = resolveRole(roleRegistry, "planner");
  const researcherRole = resolveRole(roleRegistry, "researcher");
  const executorRole = resolveRole(roleRegistry, requestedCategory === "frontend" ? "frontend-engineer" : "executor");
  const reviewerRole = resolveRole(roleRegistry, "reviewer");

  // ─── Phase: Planning + Research (parallel) ───────────────────────────────

  await transitionPhase(session, "planning", sessionStore, eventBus);

  // Fire before.plan hook
  await hooks.fire("before.plan", { sessionId: session.id, task: options.task, event: "before.plan", data: { intent } });

  const roleTaskCtx = { session, sessionStore, workerManager, providerRegistry, config, costTracker, projectMemory, rulesEngine, hooks, spawnManager, stuckDetector, sandbox, eventBus, undoManager, modelVariant };

  const plannerPromise = executeRoleTask({
    ...roleTaskCtx,
    role: plannerRole, mode: options.mode,
    prompt: buildPlannerPrompt(options.task, combinedContext, repoMap),
    retryConfig: config.retry
  }) as Promise<PlannerArtifact>;

  const researchPromise = options.mode === "team" && !intent.skipResearch
    ? executeRoleTask({
      ...roleTaskCtx,
      role: researcherRole, mode: options.mode,
      prompt: buildResearchPrompt(options.task, combinedContext, repoMap),
      retryConfig: config.retry
    }) as Promise<ResearchArtifact>
    : Promise.resolve(undefined);

  const [plannerOutput, researchOutput] = await Promise.all([plannerPromise, researchPromise]);

  // Fire after.plan hook
  await hooks.fire("after.plan", { sessionId: session.id, task: options.task, event: "after.plan", data: { plan: plannerOutput.summary, research: researchOutput?.summary } });

  // ─── Phase: Delegation ───────────────────────────────────────────────────

  const delegatedPlannerTasks = augmentPlannerTasks(options.task, plannerOutput.tasks ?? []);
  const delegationAssignments = options.mode === "team" && !intent.skipDelegation
    ? selectDelegationAssignments({
      tasks: delegatedPlannerTasks.filter((task) => task.category !== "review"),
      registry: roleRegistry,
      limit: Math.max(0, config.team.maxWorkers - 2)
    })
    : [];

  const delegationOutcomes = delegationAssignments.length > 0
    ? await executeDelegatedAssignments({
      assignments: delegationAssignments,
      rootTask: options.task,
      session, sessionStore, workerManager, providerRegistry, config,
      costTracker, projectMemory, rulesEngine, hooks, spawnManager, stuckDetector,
      plannerSummary: plannerOutput.summary,
      researchSummary: researchOutput?.summary,
      context: combinedContext,
      repoSummary,
      eventBus,
      sandbox,
      undoManager,
      modelVariant
    })
    : [];
  const delegationSummary = summarizeDelegationArtifacts(delegationOutcomes);

  // ─── Phase: Factcheck ───────────────────────────────────────────────────

  // Verify assumptions in the planner's output before execution
  const planClaims = extractClaims(plannerOutput.summary + " " + plannerOutput.tasks.map(t => t.title).join(" "));
  const factcheckResult = await verifyClaims(options.cwd, planClaims);
  const factcheckCtx = buildFactcheckContext(factcheckResult);
  if (factcheckCtx) {
    await eventBus.fire("enforcer.checklist", "engine", session.id, {
      round: 0, verdict: "factcheck", checklist: factcheckResult.warnings
    });
  }

  // ─── Phase: Execution + Review (enforcer loop) ───────────────────────────

  await transitionPhase(session, "executing", sessionStore, eventBus);

  // Fire before.execute hook
  await hooks.fire("before.execute", { sessionId: session.id, task: options.task, event: "before.execute", data: { plan: plannerOutput.summary } });

  // Inject factcheck warnings into context
  const executionContext = factcheckCtx ? `${combinedContext}\n\n${factcheckCtx}` : combinedContext;

  let enforcer = createEnforcerState(intent);
  const maxRetries = config.retry.maxParseRetries;

  let executionOutput = await executeRoleTaskWithRetry({
    ...roleTaskCtx,
    role: executorRole, mode: options.mode,
    prompt: buildExecutorPrompt(
      options.task, plannerOutput.summary, researchOutput?.summary,
      delegationSummary, executionContext, repoMap
    ),
    retryConfig: config.retry, maxRetries
  }) as ExecutorArtifact;
  enforcer = updateEnforcerAfterExecution(enforcer, executionOutput);

  // Fire after.execute hook
  await hooks.fire("after.execute", { sessionId: session.id, task: options.task, event: "after.execute", data: { execution: executionOutput.summary } });

  // Checkpoint after first execution
  await checkpointSaver.save(createCheckpoint(session.id, "executing", enforcer.executionRounds, {
    executionOutput, costs: costTracker.getSummary()
  }));

  // Fire before.review hook
  await hooks.fire("before.review", { sessionId: session.id, task: options.task, event: "before.review", data: { execution: executionOutput.summary } });

  await transitionPhase(session, "reviewing", sessionStore, eventBus);

  let review = await executeRoleTaskWithRetry({
    ...roleTaskCtx,
    role: reviewerRole, mode: options.mode,
    prompt: buildReviewerPrompt(options.task, executionOutput, delegationSummary, combinedContext),
    retryConfig: config.retry, maxRetries
  }) as ReviewResult;
  enforcer = updateEnforcerAfterReview(enforcer, review);

  // Fire after.review hook
  await hooks.fire("after.review", { sessionId: session.id, task: options.task, event: "after.review", data: { verdict: review.verdict } });

  // Stuck detection
  stuckDetector.recordRound(enforcer.executionRounds, review.verdict, executionOutput.summary);

  await eventBus.fire("enforcer.checklist", "engine", session.id, {
    round: enforcer.executionRounds,
    verdict: enforcer.verdict,
    checklist: enforcer.checklist
  });

  // ─── Enforcer Loop (with self-heal, evidence, oracle) ────────────────────

  let consecutiveFailures = 0;
  let updatedEvidence = [...evidence];
  const failureHistory: string[] = [];

  // Update evidence from first execution
  updatedEvidence = updateEvidence(updatedEvidence, executionOutput.summary);

  while (!isEnforcerDone(enforcer)) {
    // Check if stuck (OpenHands-inspired loop detection)
    if (stuckDetector.isStuck()) {
      await eventBus.fire("enforcer.stuck", "engine", session.id, {
        reason: stuckDetector.getStuckReason(),
        rounds: enforcer.executionRounds
      });
      break;
    }

    // Budget guard — stop if cost exceeds budget
    if (costTracker.isOverBudget()) {
      await eventBus.fire("error.fatal", "engine", session.id, {
        message: `Cost budget exceeded: $${costTracker.getSummary().totalEstimatedCostUsd.toFixed(4)}`
      });
      break;
    }

    // Oracle escalation — consult strategic advisor after repeated failures
    if (review.verdict === "fail") {
      consecutiveFailures++;
      failureHistory.push(`Round ${enforcer.executionRounds}: ${executionOutput.summary.slice(0, 200)}`);

      const oracle = checkOracleEscalation(consecutiveFailures);
      if (oracle.shouldEscalate) {
        await eventBus.fire("enforcer.checklist", "engine", session.id, {
          round: enforcer.executionRounds,
          verdict: "oracle-escalation",
          checklist: [oracle.reason]
        });
        // Build oracle prompt and inject into next execution
        const oraclePrompt = buildOraclePrompt(options.task, failureHistory, stuckDetector.getStuckReason() ?? `${consecutiveFailures} failures`);
        // Oracle guidance becomes part of the follow-up context
        failureHistory.push(`[Oracle consulted at round ${enforcer.executionRounds}]`);
      }
    } else {
      consecutiveFailures = 0;
    }

    // Self-healing: detect errors in execution output and generate recovery prompt
    let selfHealContext = "";
    if (review.verdict === "fail") {
      const detectedErrors = detectErrorsInOutput(executionOutput.summary);
      if (detectedErrors.length > 0) {
        const primaryError = detectedErrors[0];
        if (shouldSelfHeal(primaryError, consecutiveFailures, config.retry.maxParseRetries + 2)) {
          selfHealContext = buildRecoveryPrompt(primaryError, options.task);
          await eventBus.fire("error.retriable", "engine", session.id, {
            message: primaryError.message,
            category: primaryError.category,
            strategy: primaryError.strategy,
            attempt: consecutiveFailures
          });
        }
      }
    }

    await transitionPhase(session, "executing", sessionStore, eventBus);

    // Fire before.execute for each round
    await hooks.fire("before.execute", { sessionId: session.id, task: options.task, event: "before.execute", data: { round: enforcer.executionRounds } });

    const enforcerFollowUp = getEnforcerFollowUp(enforcer);
    const reviewFollowUp = review.verdict === "fail" ? review.followUp : [];
    const combinedFollowUp = [...reviewFollowUp, ...enforcerFollowUp];
    if (selfHealContext) combinedFollowUp.push(selfHealContext);

    const followUpTask = buildFollowUpPrompt(options.task, combinedFollowUp);

    // Context compaction: if context is getting too large, compact it
    let effectiveContext = executionContext;
    const contextTokens = estimateTokens(effectiveContext);
    if (contextTokens > tokenBudget.compactionThreshold * 0.5) {
      const { compacted } = compactContext(effectiveContext, Math.floor(tokenBudget.compactionThreshold * 0.4));
      effectiveContext = compacted;
    }

    executionOutput = await executeRoleTaskWithRetry({
      ...roleTaskCtx,
      role: executorRole, mode: options.mode,
      prompt: buildExecutorPrompt(
        followUpTask, plannerOutput.summary, researchOutput?.summary,
        delegationSummary, effectiveContext, repoMap
      ),
      retryConfig: config.retry, maxRetries
    }) as ExecutorArtifact;
    enforcer = updateEnforcerAfterExecution(enforcer, executionOutput);

    // Update evidence from execution
    updatedEvidence = updateEvidence(updatedEvidence, executionOutput.summary);

    // Fire after.execute
    await hooks.fire("after.execute", { sessionId: session.id, task: options.task, event: "after.execute", data: { execution: executionOutput.summary, round: enforcer.executionRounds } });

    // Checkpoint each round
    await checkpointSaver.save(createCheckpoint(session.id, "executing", enforcer.executionRounds, {
      round: enforcer.executionRounds, costs: costTracker.getSummary(),
      evidence: updatedEvidence
    }));

    await transitionPhase(session, "reviewing", sessionStore, eventBus);

    // Fire before.review
    await hooks.fire("before.review", { sessionId: session.id, task: options.task, event: "before.review", data: { round: enforcer.executionRounds } });

    review = await executeRoleTaskWithRetry({
      ...roleTaskCtx,
      role: reviewerRole, mode: options.mode,
      prompt: buildReviewerPrompt(options.task, executionOutput, delegationSummary, executionContext),
      retryConfig: config.retry, maxRetries
    }) as ReviewResult;
    enforcer = updateEnforcerAfterReview(enforcer, review);

    // Update evidence from review
    updatedEvidence = updateEvidence(updatedEvidence, review.summary);

    // Fire after.review
    await hooks.fire("after.review", { sessionId: session.id, task: options.task, event: "after.review", data: { verdict: review.verdict, round: enforcer.executionRounds } });

    // Record round for stuck detection
    stuckDetector.recordRound(enforcer.executionRounds, review.verdict, executionOutput.summary);

    await eventBus.fire("enforcer.checklist", "engine", session.id, {
      round: enforcer.executionRounds,
      verdict: enforcer.verdict,
      checklist: enforcer.checklist,
      evidenceSatisfied: allEvidenceSatisfied(updatedEvidence),
      consecutiveFailures
    });
  }

  // ─── Sandbox Apply/Revert ────────────────────────────────────────────────

  if (sandbox && sandbox.hasChanges()) {
    if (review.verdict === "pass" && config.sandbox?.autoApplyOnPass) {
      const result = await sandbox.apply();
      await eventBus.fire("sandbox.applied", "engine", session.id, {
        applied: result.applied, paths: result.paths
      });
    } else if (review.verdict === "fail") {
      const result = await sandbox.revert();
      await eventBus.fire("sandbox.reverted", "engine", session.id, {
        reverted: result.reverted
      });
    }
  }

  // ─── Phase: Done ─────────────────────────────────────────────────────────

  session.lastReview = review;
  session.status = review.verdict === "pass" ? "completed" : "failed";
  session.updatedAt = nowIso();
  await transitionPhase(session, "done", sessionStore, eventBus);
  await sessionStore.saveSnapshot(session);

  await eventBus.fire(
    review.verdict === "pass" ? "review.pass" : "review.fail",
    "engine", session.id, { review }
  );

  // Final checkpoint
  await checkpointSaver.save(createCheckpoint(session.id, "completed", enforcer.executionRounds + 2, {
    status: session.status,
    review,
    costs: costTracker.getSummary(),
    enforcerVerdict: enforcer.verdict
  }));

  // Save project memory (learns from this session)
  await projectMemory.save();

  // Save learned patterns (RALPH-style persistence)
  try {
    const { saveRalphState, createRalphState: createRS } = await import("./ralph.js");
    const ralphState = createRS();
    ralphState.learnedPatterns = learnedPatterns;
    await saveRalphState(options.cwd, config.sessions.localDirName, ralphState);
  } catch { /* first run, no patterns yet */ }

  // Phase 1 memory extraction: extract learnings from this session's events
  const sessionEvents = await sessionStore.readEvents(session.id);
  await extractSessionMemories(options.cwd, config.sessions.localDirName, session.id, sessionEvents);

  // Fire session.end hook
  await hooks.fire("session.end", {
    sessionId: session.id, task: options.task,
    event: "session.end",
    data: { status: session.status, costs: costTracker.getSummary() }
  });

  await eventBus.fire("session.completed", "engine", session.id, {
    status: session.status,
    browserAvailable: browserHealth.available,
    costs: costTracker.getSummary()
  });

  return { session, review, intent, costs: costTracker.getSummary(), eventBus, evidence: updatedEvidence, undoManager };
}

// ─── Phase Transitions ───────────────────────────────────────────────────────

async function transitionPhase(
  session: SessionRecord,
  phase: AgentPhase,
  store: SessionStore,
  bus: AgentEventBus
): Promise<void> {
  const previousPhase = session.phase ?? "idle";
  session.phase = phase;
  session.updatedAt = nowIso();
  await store.saveSnapshot(session);
  await bus.fire("phase.transition", "engine", session.id, {
    from: previousPhase,
    to: phase
  });
}

// ─── SWE-Agent Style Retry Wrapper ───────────────────────────────────────────

async function executeRoleTaskWithRetry(params: Parameters<typeof executeRoleTask>[0] & {
  maxRetries?: number;
}): Promise<RoleArtifact> {
  const maxRetries = params.maxRetries ?? 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeRoleTask(params);
    } catch (error) {
      if (attempt >= maxRetries) throw error;

      const message = error instanceof Error ? error.message : String(error);
      const isRetriable = isRetriableError(message, params.retryConfig?.retriablePatterns ?? []);

      if (!isRetriable) throw error;

      // Build error recovery prompt
      const errorPrompt = buildErrorPrompt("parse", message, attempt + 1);
      params = { ...params, prompt: `${params.prompt}\n\n${errorPrompt}` };
    }
  }

  throw new Error("Unreachable");
}

function isRetriableError(message: string, patterns: string[]): boolean {
  // Always retry JSON parse errors
  if (/SyntaxError|Unexpected token|JSON/i.test(message)) return true;
  // Check configured patterns
  return patterns.some((p) => new RegExp(p, "i").test(message));
}

// ─── Delegation ──────────────────────────────────────────────────────────────

async function executeDelegatedAssignments(params: {
  assignments: DelegationAssignment[];
  rootTask: string;
  session: SessionRecord;
  sessionStore: SessionStore;
  workerManager: LocalWorkerManager;
  providerRegistry: ProviderRegistry;
  config: Awaited<ReturnType<typeof loadConfig>>;
  costTracker: CostTracker;
  projectMemory: ProjectMemoryStore;
  rulesEngine: RulesEngine;
  hooks: HookRegistry;
  spawnManager: SpawnReservationManager;
  stuckDetector: StuckDetector;
  plannerSummary: string;
  researchSummary?: string;
  context: string;
  repoSummary: string;
  eventBus: AgentEventBus;
  sandbox?: DiffSandbox;
  undoManager?: UndoManager;
  modelVariant?: import("./model-variants.js").ModelVariantConfig;
}): Promise<DelegationOutcome[]> {
  const concurrency = Math.min(params.assignments.length, Math.max(1, params.config.team.maxWorkers - 2));
  const outcomes: Array<DelegationOutcome | undefined> = new Array(params.assignments.length);
  let cursor = 0;

  async function workerLoop(): Promise<void> {
    while (cursor < params.assignments.length) {
      const index = cursor;
      cursor += 1;
      const assignment = params.assignments[index];
      if (!assignment) return;

      // Reserve spawn slot
      const reservation = await params.spawnManager.reserve({
        sessionId: params.session.id,
        parentSessionId: params.session.id,
        roleId: assignment.role.id
      });
      params.spawnManager.activate(reservation.id);

      // Fork event bus for isolated child agent stream (OpenHands pattern)
      const childBus = params.eventBus.fork(`delegation-${assignment.role.id}-${assignment.task.id}`);

      await params.eventBus.fire("delegation.started", "engine", params.session.id, {
        role: assignment.role.id,
        taskId: assignment.task.id,
        title: assignment.task.title,
        category: assignment.task.category
      });

      try {
        const artifact = await executeRoleTask({
          session: params.session,
          sessionStore: params.sessionStore,
          workerManager: params.workerManager,
          providerRegistry: params.providerRegistry,
          config: params.config,
          costTracker: params.costTracker,
          projectMemory: params.projectMemory,
          rulesEngine: params.rulesEngine,
          hooks: params.hooks,
          spawnManager: params.spawnManager,
          stuckDetector: params.stuckDetector,
          sandbox: params.sandbox,
          eventBus: childBus,
          undoManager: params.undoManager,
          modelVariant: params.modelVariant,
          role: assignment.role,
          mode: "team",
          prompt: buildDelegationPrompt({
            rootTask: params.rootTask,
            assignment,
            plannerSummary: params.plannerSummary,
            researchSummary: params.researchSummary,
            context: params.context,
            repoSummary: params.repoSummary
          }),
          retryConfig: params.config.retry
        }) as SpecialistArtifact;

        const note = createDelegationNote({ assignment, artifact });
        outcomes[index] = { assignment, artifact, note };

        params.spawnManager.complete(reservation.id);

        await params.eventBus.fire("delegation.completed", "engine", params.session.id, {
          role: assignment.role.id,
          taskId: assignment.task.id,
          title: assignment.task.title,
          summary: note.summary,
          contractKind: note.contractKind
        });
      } catch (error) {
        params.spawnManager.fail(reservation.id);
        throw error;
      }
    }
  }

  const results = await Promise.allSettled(Array.from({ length: concurrency }, () => workerLoop()));
  // Log any delegation failures but don't crash the whole pipeline
  for (const r of results) {
    if (r.status === "rejected") {
      await params.eventBus.fire("error.retriable", "engine", params.session.id, {
        message: `Delegation worker failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        attempt: 1
      });
    }
  }
  return outcomes.filter((o): o is DelegationOutcome => Boolean(o));
}

// ─── Role Task Execution ─────────────────────────────────────────────────────

async function executeRoleTask(params: {
  session: SessionRecord;
  sessionStore: SessionStore;
  workerManager: LocalWorkerManager;
  providerRegistry: ProviderRegistry;
  config: Awaited<ReturnType<typeof loadConfig>>;
  costTracker: CostTracker;
  projectMemory: ProjectMemoryStore;
  rulesEngine: RulesEngine;
  hooks: HookRegistry;
  spawnManager: SpawnReservationManager;
  stuckDetector: StuckDetector;
  sandbox?: DiffSandbox;
  eventBus?: AgentEventBus;
  undoManager?: UndoManager;
  modelVariant?: import("./model-variants.js").ModelVariantConfig;
  role: ReturnType<typeof resolveRole>;
  mode: "run" | "team";
  prompt: string;
  retryConfig?: { maxToolRetries: number; maxParseRetries: number; retriablePatterns: string[] };
}): Promise<RoleArtifact> {
  const providerSelection = params.providerRegistry.resolveForRole(params.config, params.role);
  const transport: WorkerTransport =
    params.mode === "team"
      ? params.workerManager.selectTransport(params.config.team.preferTmux)
      : "inline";

  // Only enforce worker limit for parallel transports (subprocess/tmux), not inline
  if (transport !== "inline") {
    params.workerManager.assertWithinLimit(
      params.session.tasks.filter((task) => task.status === "running").length
    );
  }

  const taskRecord = await params.sessionStore.createTask(
    params.session.id,
    params.role.id,
    params.role.category,
    providerSelection.providerId,
    params.prompt,
    transport
  );

  taskRecord.status = "running";
  await params.sessionStore.saveTask(taskRecord);
  params.session.tasks.push(taskRecord);
  await params.sessionStore.saveSnapshot(params.session);

  const promptFile = await params.sessionStore.writePrompt(
    taskRecord.id,
    `${buildSystemPrompt(params.role)}\n\n${params.prompt}`
  );

  let artifact: RoleArtifact | null;

  // Apply model variant to prompt if available
  const effectivePrompt = params.modelVariant
    ? applyVariantToPrompt(`${buildSystemPrompt(params.role)}\n\n${params.prompt}`, params.modelVariant)
    : `${buildSystemPrompt(params.role)}\n\n${params.prompt}`;

  if (transport === "inline") {
    artifact = await runWorkerInline({
      cwd: params.session.cwd,
      sessionId: params.session.id,
      taskId: taskRecord.id,
      roleId: params.role.id,
      providerId: providerSelection.providerId,
      prompt: effectivePrompt,
      costTracker: params.costTracker,
      projectMemory: params.projectMemory,
      rulesEngine: params.rulesEngine,
      hooks: params.hooks,
      sandbox: params.sandbox,
      eventBus: params.eventBus,
      undoManager: params.undoManager
    }) as RoleArtifact;
  } else if (transport === "subprocess") {
    const lease = await params.workerManager.runSubprocess({
      sessionId: params.session.id,
      taskId: taskRecord.id,
      role: params.role.id,
      provider: providerSelection.providerId,
      promptFile,
      cwd: params.session.cwd
    });
    artifact = await params.sessionStore.readArtifact(taskRecord.id) as RoleArtifact | null;
  } else {
    const lease = await params.workerManager.runTmux({
      sessionId: params.session.id,
      taskId: taskRecord.id,
      role: params.role.id,
      provider: providerSelection.providerId,
      promptFile,
      cwd: params.session.cwd
    });
    artifact = await pollArtifact(params.sessionStore, taskRecord.id) as RoleArtifact | null;
  }

  taskRecord.output = artifact ?? { error: "artifact missing" };
  taskRecord.status = artifact ? "completed" : "failed";
  await params.sessionStore.saveTask(taskRecord);
  await params.sessionStore.saveSnapshot(params.session);

  if (!artifact) {
    throw new Error(`Artifact missing for task ${taskRecord.id}`);
  }
  return artifact;
}

async function pollArtifact(sessionStore: SessionStore, taskId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const artifact = await sessionStore.readArtifact(taskId);
    if (artifact) return artifact;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Walk top-level files for Sisyphus codebase assessment */
async function walkTopLevel(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".agent"]);
  const visit = async (dir: string, depth: number) => {
    if (depth > 2) return;
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = path.relative(cwd, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          if (!SKIP.has(entry.name)) await visit(path.join(dir, entry.name), depth + 1);
        } else {
          files.push(rel);
        }
      }
    } catch { /* permission denied etc */ }
  };
  await visit(cwd, 0);
  return files;
}
