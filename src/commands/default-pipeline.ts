import { loadConfig } from "../core/config.js";
import type {
  ProviderId,
  ReviewResult,
  RoleCategory,
  SessionRecord,
  TaskRecord,
  ToolResult
} from "../core/types.js";
import { nowIso } from "../core/utils.js";
import { runAgiPipeline, type AgiPipelineEvent, type AgiStep, type StepType } from "../orchestration/agi-pipeline.js";
import type { AnalyzeArtifact } from "../orchestration/analyze-artifact.js";
import { extractAnalyzeArtifactFromEngineResult, extractAnalyzeArtifactFromText, extractOriginalTaskFromPrompt } from "../orchestration/analyze-artifact.js";
import type { DebateArtifact } from "../orchestration/debate-artifact.js";
import { extractDebateArtifactFromEngineResult, extractDebateArtifactFromText } from "../orchestration/debate-artifact.js";
import type { DesignArtifact } from "../orchestration/design-artifact.js";
import { extractDesignArtifactFromEngineResult } from "../orchestration/design-artifact.js";
import { runEngine, type RunEngineResult } from "../orchestration/engine.js";
import { SessionStore } from "../sessions/store.js";

const PIPELINE_KIND = "agi-default";
const SYNTHETIC_PROVIDER: ProviderId = "mock";

type PipelineMode = "run" | "team";

interface PipelineMetadata {
  pipelineKind: typeof PIPELINE_KIND;
  pipelineMode: PipelineMode;
  childSessionIds: string[];
  currentStepId?: string;
  currentStepType?: StepType;
  totalSteps?: number;
  completedSteps?: number;
  replanCount?: number;
}

export interface RunDefaultPipelineOptions {
  cwd: string;
  task: string;
  mode: PipelineMode;
  resumeSessionId?: string;
  onSessionReady?: (sessionId: string) => void | Promise<void>;
}

export interface RunDefaultPipelineResult {
  session: SessionRecord;
  review: ReviewResult;
  pipeline: Awaited<ReturnType<typeof runAgiPipeline>>;
}

export function isDefaultPipelineSession(session: SessionRecord | null | undefined): boolean {
  return session?.metadata?.pipelineKind === PIPELINE_KIND;
}

export async function runDefaultPipeline(options: RunDefaultPipelineOptions): Promise<RunDefaultPipelineResult> {
  const config = await loadConfig(options.cwd);
  const store = new SessionStore(options.cwd, config.sessions);
  const session = await loadOrCreatePipelineSession(store, options);
  let writeQueue = Promise.resolve();

  const enqueueWrite = (fn: () => Promise<void>): void => {
    writeQueue = writeQueue.then(fn, fn);
  };

  const flushWrites = async (): Promise<void> => {
    await writeQueue;
  };

  await options.onSessionReady?.(session.id);

  const persistEvent = (event: AgiPipelineEvent): void => {
    enqueueWrite(async () => {
      applyPipelineEventToSession(session, event, options.mode);
      await store.appendEvent(session.id, {
        type: event.type,
        at: nowIso(),
        payload: buildEventPayload(event)
      });
      await store.saveSnapshot(session);
    });
  };

  try {
    const pipeline = await runAgiPipeline({
      cwd: options.cwd,
      task: options.task,
      projectDir: options.cwd,
      onEvent: persistEvent,
      executeStep: async (stepPrompt, stepMode, _maxTurns, step) => {
        await flushWrites();

        const childResult = await runEngine({
          cwd: options.cwd,
          task: buildChildStepTask(session, step, stepPrompt),
          mode: options.mode === "team" ? "team" : stepMode
        });

        const metadata = getPipelineMetadata(session, options.mode);
        metadata.childSessionIds.push(childResult.session.id);
        session.metadata = metadata as unknown as Record<string, unknown>;

        const stepTask = ensurePipelineTask(session, step, options.mode);
        const output = buildStepOutput(step, childResult, stepPrompt);
        stepTask.output = {
          ...output,
          childSessionId: childResult.session.id,
          childStatus: childResult.session.status,
          childReview: childResult.review
        };
        stepTask.updatedAt = nowIso();

        await store.saveSnapshot(session);
        return output;
      }
    });

    await flushWrites();

    const review = buildPipelineReview(pipeline);
    session.lastReview = review;
    session.status = pipeline.success ? "completed" : "failed";
    session.phase = "done";
    session.metadata = {
      ...getPipelineMetadata(session, options.mode),
      currentStepId: undefined,
      currentStepType: undefined,
      completedSteps: pipeline.context.stepResults.filter((step) => step.status === "completed").length,
      totalSteps: pipeline.plan.steps.length,
      replanCount: pipeline.plan.replanCount
    } as unknown as Record<string, unknown>;
    await store.saveSnapshot(session);
    await store.appendEvent(session.id, {
      type: review.verdict === "pass" ? "review.pass" : "review.fail",
      at: nowIso(),
      payload: { review }
    });
    await store.appendEvent(session.id, {
      type: "session.completed",
      at: nowIso(),
      payload: { status: session.status, pipelineKind: PIPELINE_KIND }
    });

    return { session, review, pipeline };
  } catch (error) {
    await flushWrites();
    const message = error instanceof Error ? error.message : String(error);
    const review: ReviewResult = {
      verdict: "fail",
      summary: message,
      followUp: [message]
    };
    session.status = "failed";
    session.phase = "done";
    session.lastReview = review;
    session.metadata = {
      ...getPipelineMetadata(session, options.mode),
      currentStepId: undefined,
      currentStepType: undefined
    } as unknown as Record<string, unknown>;
    await store.saveSnapshot(session);
    await store.appendEvent(session.id, {
      type: "error.fatal",
      at: nowIso(),
      payload: { message, pipelineKind: PIPELINE_KIND }
    });
    await store.appendEvent(session.id, {
      type: "review.fail",
      at: nowIso(),
      payload: { review }
    });
    await store.appendEvent(session.id, {
      type: "session.completed",
      at: nowIso(),
      payload: { status: session.status, pipelineKind: PIPELINE_KIND }
    });
    throw error;
  }
}

async function loadOrCreatePipelineSession(
  store: SessionStore,
  options: RunDefaultPipelineOptions
): Promise<SessionRecord> {
  const existing = options.resumeSessionId
    ? await store.loadSnapshot(options.resumeSessionId)
    : null;

  if (!existing) {
    const session = await store.createSession(options.task, options.resumeSessionId);
    session.phase = "planning";
    session.metadata = createPipelineMetadata(options.mode) as unknown as Record<string, unknown>;
    await store.saveSnapshot(session);
    return session;
  }

  if (!isDefaultPipelineSession(existing)) {
    throw new Error(`Session ${existing.id} is not an AGI pipeline session`);
  }

  existing.task = options.task;
  existing.status = "running";
  existing.phase = "planning";
  existing.tasks = [];
  existing.lastReview = undefined;
  existing.metadata = createPipelineMetadata(options.mode) as unknown as Record<string, unknown>;
  await store.saveSnapshot(existing);
  await store.appendEvent(existing.id, {
    type: "session.resumed",
    at: nowIso(),
    payload: { resumedFrom: existing.id, pipelineKind: PIPELINE_KIND }
  });
  return existing;
}

function createPipelineMetadata(mode: PipelineMode): PipelineMetadata {
  return {
    pipelineKind: PIPELINE_KIND,
    pipelineMode: mode,
    childSessionIds: []
  };
}

function getPipelineMetadata(session: SessionRecord, mode: PipelineMode): PipelineMetadata {
  const existing = session.metadata ?? {};
  return {
    pipelineKind: PIPELINE_KIND,
    pipelineMode: mode,
    childSessionIds: Array.isArray(existing.childSessionIds)
      ? existing.childSessionIds.filter((value): value is string => typeof value === "string")
      : [],
    currentStepId: typeof existing.currentStepId === "string" ? existing.currentStepId : undefined,
    currentStepType: isStepType(existing.currentStepType) ? existing.currentStepType : undefined,
    totalSteps: typeof existing.totalSteps === "number" ? existing.totalSteps : undefined,
    completedSteps: typeof existing.completedSteps === "number" ? existing.completedSteps : undefined,
    replanCount: typeof existing.replanCount === "number" ? existing.replanCount : undefined
  };
}

function isStepType(value: unknown): value is StepType {
  return typeof value === "string"
    && ["analyze", "debate", "design", "build", "verify", "fix", "improve", "review", "deploy", "custom"].includes(value);
}

function buildChildStepTask(session: SessionRecord, step: AgiStep, stepPrompt: string): string {
  const stepTask = ensurePipelineTask(session, step, "run");
  const ordinal = Math.max(1, session.tasks.findIndex((task) => task.id === stepTask.id) + 1);
  return `[STEP ${ordinal}: ${step.type.toUpperCase()}] ${step.title}\n\n${stepPrompt}`;
}

function applyPipelineEventToSession(session: SessionRecord, event: AgiPipelineEvent, mode: PipelineMode): void {
  const metadata = getPipelineMetadata(session, mode);

  if (event.type === "agi.pipeline.start") {
    metadata.totalSteps = event.totalSteps;
    metadata.completedSteps = event.completedSteps;
  } else if (event.type === "agi.replan") {
    metadata.totalSteps = event.totalSteps;
    metadata.replanCount = event.replanCount;
  } else if (event.stepId && event.stepType && event.stepTitle) {
    const task = ensurePipelineTask(session, {
      id: event.stepId,
      type: event.stepType,
      title: event.stepTitle,
      description: event.stepTitle,
      mode: mode === "team" ? "team" : "run",
      maxTurns: 0,
      dependsOn: [],
      priority: 0,
      maxRetries: 0,
      useStrategyBranching: false
    }, mode);
    task.updatedAt = nowIso();

    if (event.type === "agi.step.start") {
      task.status = "running";
      session.phase = mapStepTypeToPhase(event.stepType);
      metadata.currentStepId = event.stepId;
      metadata.currentStepType = event.stepType;
    } else {
      task.status = event.status === "failed" ? "failed" : "completed";
      task.output = {
        ...(typeof task.output === "object" && task.output !== null ? task.output as Record<string, unknown> : {}),
        status: event.status,
        summary: event.summary,
        stepType: event.stepType,
        stepTitle: event.stepTitle
      };
      metadata.completedSteps = event.completedSteps ?? metadata.completedSteps;
      metadata.totalSteps = event.totalSteps ?? metadata.totalSteps;
      if (metadata.currentStepId === event.stepId) {
        metadata.currentStepId = undefined;
        metadata.currentStepType = undefined;
      }
    }
  } else if (event.type === "agi.pipeline.complete" || event.type === "agi.pipeline.fail") {
    metadata.completedSteps = event.completedSteps;
    metadata.totalSteps = event.totalSteps;
    metadata.currentStepId = undefined;
    metadata.currentStepType = undefined;
  }

  session.metadata = metadata as unknown as Record<string, unknown>;
}

function ensurePipelineTask(session: SessionRecord, step: AgiStep, mode: PipelineMode): TaskRecord {
  const taskId = `pipe_${step.id}`;
  const existing = session.tasks.find((task) => task.id === taskId);
  if (existing) {
    return existing;
  }

  const task: TaskRecord = {
    id: taskId,
    sessionId: session.id,
    role: step.type,
    category: mapStepTypeToCategory(step.type),
    provider: SYNTHETIC_PROVIDER,
    prompt: `[${mode}] ${step.title}`,
    status: "pending",
    transport: "inline",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  session.tasks.push(task);
  return task;
}

function mapStepTypeToCategory(stepType: StepType): RoleCategory {
  if (stepType === "build" || stepType === "fix" || stepType === "improve" || stepType === "deploy") {
    return "execution";
  }
  if (stepType === "verify" || stepType === "review") {
    return "review";
  }
  if (stepType === "debate") {
    return "research";
  }
  return "planning";
}

function mapStepTypeToPhase(stepType: StepType): SessionRecord["phase"] {
  if (stepType === "build" || stepType === "fix" || stepType === "improve" || stepType === "deploy") {
    return "executing";
  }
  if (stepType === "verify" || stepType === "review") {
    return "reviewing";
  }
  return "planning";
}

function buildStepOutput(step: AgiStep, result: RunEngineResult, stepPrompt: string): {
  summary: string;
  changes: string[];
  toolResults: Array<{ name: string; ok: boolean; output?: string }>;
  tokensUsed: number;
  errors: string[];
  rawOutput?: string;
  analysisArtifact?: AnalyzeArtifact;
  debateArtifact?: DebateArtifact;
  designArtifact?: DesignArtifact;
} {
  const includeReview = shouldIncludeReviewArtifacts(step.type);
  const summary = collectStepSummary(result, includeReview);
  const changes = collectStepChanges(result);
  const toolResults = collectToolResults(result);
  const errors = collectStepErrors(step, result, toolResults);
  const tokensUsed = result.costs.totalInputTokens + result.costs.totalOutputTokens;
  const originalTask = extractOriginalTaskFromPrompt(stepPrompt);
  const analyzeArtifactFromPrompt = extractAnalyzeArtifactFromText(originalTask, stepPrompt) ?? undefined;
  const debateArtifactFromPrompt = extractDebateArtifactFromText(
    originalTask,
    stepPrompt,
    analyzeArtifactFromPrompt ?? undefined
  ) ?? undefined;
  const analysisArtifact = step.type === "analyze"
    ? (result.analysisArtifact ?? extractAnalyzeArtifactFromEngineResult({
      task: originalTask,
      outputs: result.session.tasks.map((task) => ({ role: task.role, output: task.output }))
    }))
    : undefined;
  const debateArtifact = step.type === "debate"
    ? (result.debateArtifact ?? extractDebateArtifactFromEngineResult({
      task: originalTask,
      analyzeArtifact: analyzeArtifactFromPrompt ?? undefined,
      outputs: result.session.tasks.map((task) => ({ role: task.role, output: task.output }))
    }))
    : undefined;
  const designArtifact = step.type === "design"
    ? (result.designArtifact ?? extractDesignArtifactFromEngineResult({
      task: originalTask,
      analyzeArtifact: analyzeArtifactFromPrompt ?? undefined,
      debateArtifact: debateArtifactFromPrompt ?? undefined,
      outputs: result.session.tasks.map((task) => ({ role: task.role, output: task.output }))
    }))
    : undefined;

  return {
    summary: analysisArtifact?.summary ?? debateArtifact?.summary ?? designArtifact?.summary ?? summary,
    changes,
    toolResults,
    tokensUsed,
    errors,
    rawOutput: analysisArtifact
      ? JSON.stringify(analysisArtifact, null, 2)
      : debateArtifact
        ? JSON.stringify(debateArtifact, null, 2)
        : designArtifact
          ? JSON.stringify(designArtifact, null, 2)
          : (collectStepRawOutput(result, includeReview) ?? summary),
    analysisArtifact,
    debateArtifact,
    designArtifact
  };
}

function collectStepSummary(result: RunEngineResult, includeReview: boolean): string {
  const sections: string[] = [];

  for (const task of result.session.tasks) {
    const output = task.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    const summary = typeof (output as { summary?: unknown }).summary === "string"
      ? (output as { summary: string }).summary
      : "";
    if (summary) {
      sections.push(`[${task.role}] ${summary}`);
    }
  }

  if (includeReview && result.review.summary) {
    sections.push(`[review] ${result.review.summary}`);
  }

  return sections.join("\n\n") || result.review.summary || "Step completed";
}

function collectStepRawOutput(result: RunEngineResult, includeReview: boolean): string | undefined {
  const sections: string[] = [];

  for (const task of result.session.tasks) {
    const output = task.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    sections.push(`## ${task.role}`);
    sections.push(stringifyStepOutput(output));
  }

  if (includeReview && (result.review.summary || result.review.followUp.length > 0)) {
    sections.push("## review");
    sections.push(stringifyStepOutput(result.review));
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function shouldIncludeReviewArtifacts(stepType: StepType): boolean {
  return stepType === "verify" || stepType === "review";
}

function stringifyStepOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectStepChanges(result: RunEngineResult): string[] {
  const changes = new Set<string>();

  for (const task of result.session.tasks) {
    const output = task.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    const typedOutput = output as {
      changes?: unknown;
      toolResults?: ToolResult[];
    };

    if (Array.isArray(typedOutput.changes)) {
      for (const change of typedOutput.changes) {
        if (typeof change === "string" && change.trim()) {
          changes.add(change);
        }
      }
    }

    if (Array.isArray(typedOutput.toolResults)) {
      for (const result of typedOutput.toolResults) {
        if (!result.ok) continue;
        if (result.name !== "write" && result.name !== "apply_patch") continue;
        const path = typeof result.output === "object" && result.output !== null
          && typeof (result.output as { path?: unknown }).path === "string"
          ? (result.output as { path: string }).path
          : undefined;
        changes.add(`${result.name}: ${path ?? "unknown"}`);
      }
    }
  }

  return Array.from(changes);
}

function collectToolResults(result: RunEngineResult): Array<{ name: string; ok: boolean; output?: string }> {
  const toolResults: Array<{ name: string; ok: boolean; output?: string }> = [];

  for (const task of result.session.tasks) {
    const output = task.output;
    if (!output || typeof output !== "object") {
      continue;
    }
    const typedOutput = output as { toolResults?: ToolResult[] };
    if (!Array.isArray(typedOutput.toolResults)) {
      continue;
    }
    for (const toolResult of typedOutput.toolResults) {
      toolResults.push({
        name: toolResult.name,
        ok: toolResult.ok,
        output: summarizeToolOutput(toolResult.output)
      });
    }
  }

  return toolResults;
}

function collectStepErrors(
  step: AgiStep,
  result: RunEngineResult,
  toolResults: Array<{ name: string; ok: boolean; output?: string }>
): string[] {
  const errors = new Set<string>();

  if (result.review.verdict === "fail") {
    if (result.review.followUp.length > 0) {
      for (const followUp of result.review.followUp) {
        errors.add(followUp);
      }
    } else if (result.review.summary) {
      errors.add(result.review.summary);
    }
  }

  for (const task of result.session.tasks) {
    if (task.status === "failed") {
      errors.add(`Task failed: ${task.role}`);
    }
  }

  for (const toolResult of toolResults) {
    if (!toolResult.ok) {
      errors.add(`Tool failed: ${toolResult.name}`);
    }
  }

  if (step.type !== "verify" && result.session.status === "failed" && errors.size === 0) {
    errors.add(result.review.summary || `${step.title} failed`);
  }

  return Array.from(errors);
}

function summarizeToolOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output.slice(0, 500);
  }
  if (output && typeof output === "object") {
    return JSON.stringify(output).slice(0, 500);
  }
  return undefined;
}

function buildPipelineReview(pipeline: Awaited<ReturnType<typeof runAgiPipeline>>): ReviewResult {
  const failedSteps = pipeline.context.stepResults.filter((step) => step.status === "failed");
  const unresolvedErrors = pipeline.context.stepResults.flatMap((step) => step.errors);
  const lastSummary = [...pipeline.context.stepResults]
    .reverse()
    .find((step) => step.summary.trim().length > 0)?.summary ?? `${pipeline.context.stepResults.length} steps completed`;

  if (pipeline.success) {
    return {
      verdict: "pass",
      summary: lastSummary,
      followUp: []
    };
  }

  return {
    verdict: "fail",
    summary: failedSteps[0]?.summary || lastSummary,
    followUp: unresolvedErrors.length > 0 ? unresolvedErrors.slice(0, 10) : [lastSummary]
  };
}

function buildEventPayload(event: AgiPipelineEvent): Record<string, unknown> {
  return {
    stepId: event.stepId,
    stepType: event.stepType,
    stepTitle: event.stepTitle,
    status: event.status,
    summary: event.summary,
    confidence: event.confidence,
    totalSteps: event.totalSteps,
    completedSteps: event.completedSteps,
    replanCount: event.replanCount,
    error: event.error
  };
}
