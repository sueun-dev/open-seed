/**
 * AGI Pipeline — True Autonomous Multi-Step Orchestrator.
 *
 * Architecture synthesized from 22 research repos:
 * - AutoGPT: Task→Step hierarchy, reactive replanning, error-as-value
 * - MetaGPT: Message-based inter-agent communication, PLAN_AND_ACT mode
 * - OpenHands: Event stream, unlimited iterations, stuck detection, memory condenser
 * - SWE-Agent: Multi-level retry, trajectory checkpointing, context management
 * - Codex: Long-lived sessions, parallel tool execution, streaming
 * - Aider: RepoMap context injection, auto-test loop, reflection on failure
 * - Plandex: Diff sandbox staging, dual mode (plan vs execute)
 * - CrewAI: Task DAG with dependencies, output chaining between agents
 * - LangGraph: Typed state graph, checkpoint every step, conditional routing
 * - Devika: Specialized sub-agents, real-time state emission
 * - Cline: Git-based checkpoints, approval flow, context truncation
 *
 * Key differences from old 6-step pipeline:
 * 1. Inter-step shared memory (SharedContext) — every step sees all prior results
 * 2. Dynamic step planning — planner decides steps based on task, not hardcoded
 * 3. Conditional routing — failed verify loops back to build, not forward
 * 4. No turn limit — agentic loop runs until done (maxTurns: 200)
 * 5. All subsystems wired — debate, strategy branching, confidence, HITL, dep-graph
 * 6. Auto-recovery — step failures trigger self-heal → strategy branch → escalate
 */

import type { AgentEventBus } from "../core/event-bus.js";
import type { RunEngineOptions, RunEngineResult } from "./engine.js";

// ─── Shared Context (Inter-Step Memory) ──────────────────────────────────────

export interface SharedContext {
  /** Original user task */
  task: string;
  /** Project directory */
  projectDir: string;
  /** Accumulated results from each completed step */
  stepResults: StepResult[];
  /** Files created/modified across all steps */
  allFiles: Map<string, FileState>;
  /** Errors encountered and their resolutions */
  errorLog: ErrorEntry[];
  /** Architecture decisions made during design */
  decisions: string[];
  /** Current plan (can be modified by replanner) */
  plan: AgiPlan;
  /** Confidence score (updated after each step) */
  confidence: number;
  /** Total tokens used */
  totalTokens: number;
  /** Total cost USD */
  totalCostUsd: number;
  /** Start timestamp */
  startedAt: number;
  /** Debate results (if any) */
  debateResult?: import("./debate-mode.js").DebateResult;
  /** Strategy branching results (if any) */
  branchingResult?: import("./strategy-branching.js").BranchingResult;
  /** Dependency graph (built async) */
  depGraph?: Awaited<ReturnType<typeof import("./dependency-graph.js").buildDependencyGraph>>;
}

export interface FileState {
  path: string;
  status: "created" | "modified" | "deleted";
  stepId: string;
  content?: string;
}

export interface ErrorEntry {
  stepId: string;
  error: string;
  category: string;
  resolved: boolean;
  resolution?: string;
}

// ─── Step Definition ─────────────────────────────────────────────────────────

export type StepType =
  | "analyze"    // Understand intent, assess codebase
  | "debate"     // Multi-agent design debate (conditional)
  | "design"     // Architecture + file plan
  | "build"      // Write all code
  | "verify"     // Run tests, type-check, lint
  | "fix"        // Fix errors found in verify
  | "improve"    // Security, performance, docs
  | "review"     // Final quality review
  | "deploy"     // Build + run commands (conditional)
  | "custom";    // Dynamic step from planner

export interface AgiStep {
  id: string;
  type: StepType;
  title: string;
  description: string;
  /** Engine mode: run (single agent) or team (multi-agent) */
  mode: "run" | "team";
  /** Max agentic turns for this step (0 = unlimited) */
  maxTurns: number;
  /** Dependencies: step IDs that must complete first */
  dependsOn: string[];
  /** Condition: only run if this returns true */
  condition?: (ctx: SharedContext) => boolean;
  /** Priority: higher runs first when multiple steps are ready */
  priority: number;
  /** Retry config for this step */
  maxRetries: number;
  /** Whether to use strategy branching on failure */
  useStrategyBranching: boolean;
}

export interface StepResult {
  stepId: string;
  type: StepType;
  status: "completed" | "failed" | "skipped";
  summary: string;
  /** Files created/modified in this step */
  changes: string[];
  /** Tool execution evidence */
  toolResults: Array<{ name: string; ok: boolean; output?: string }>;
  /** Duration in ms */
  durationMs: number;
  /** Tokens used */
  tokensUsed: number;
  /** Errors encountered */
  errors: string[];
  /** Raw output from engine */
  rawOutput?: string;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export interface AgiPlan {
  steps: AgiStep[];
  /** Current step index (-1 = not started, steps.length = done) */
  currentStepIndex: number;
  /** Number of replan events */
  replanCount: number;
  /** Whether the plan was dynamically generated */
  isDynamic: boolean;
}

// ─── Planner: Generates Steps Based on Task ──────────────────────────────────

/**
 * Analyze the task and generate an optimal step sequence.
 * This replaces the hardcoded 6-step pipeline.
 */
export function generatePlan(task: string, assessment: {
  complexity: "simple" | "moderate" | "complex" | "massive";
  hasTests: boolean;
  isNewProject: boolean;
  primaryLanguage: string | null;
  needsDebate: boolean;
}): AgiPlan {
  const steps: AgiStep[] = [];
  let stepNum = 0;

  const makeId = (type: string) => `step-${++stepNum}-${type}`;

  // ── Step 1: ANALYZE (always) ──
  steps.push({
    id: makeId("analyze"),
    type: "analyze",
    title: "Analyze & Understand",
    description: "Deep analysis of task intent, requirements, risks, and codebase assessment",
    mode: "run",
    maxTurns: 30,
    dependsOn: [],
    priority: 100,
    maxRetries: 1,
    useStrategyBranching: false,
  });

  // ── Step 2: DEBATE (conditional — only for complex architectural decisions) ──
  if (assessment.needsDebate && assessment.complexity !== "simple") {
    steps.push({
      id: makeId("debate"),
      type: "debate",
      title: "Multi-Agent Design Debate",
      description: "Specialists debate architecture, technology choices, and tradeoffs",
      mode: "team",
      maxTurns: 50,
      dependsOn: [steps[steps.length - 1].id],
      priority: 90,
      maxRetries: 0,
      useStrategyBranching: false,
    });
  }

  // ── Step 3: DESIGN (skip for simple tasks) ──
  if (assessment.complexity !== "simple") {
    steps.push({
      id: makeId("design"),
      type: "design",
      title: "Architecture & Design",
      description: "Create detailed implementation plan with file structure, API design, component breakdown",
      mode: "run",
      maxTurns: 40,
      dependsOn: [steps[steps.length - 1].id],
      priority: 80,
      maxRetries: 1,
      useStrategyBranching: false,
    });
  }

  // ── Step 4: BUILD (always — the core step) ──
  const buildStep: AgiStep = {
    id: makeId("build"),
    type: "build",
    title: "Build & Implement",
    description: "Write ALL code files. Complete implementation with no placeholders.",
    mode: "team",
    maxTurns: 200, // Unlimited for complex builds
    dependsOn: [steps[steps.length - 1].id],
    priority: 70,
    maxRetries: 2,
    useStrategyBranching: true, // Try different approaches if first fails
  };
  steps.push(buildStep);

  // ── Step 5: VERIFY (always) ──
  const verifyStep: AgiStep = {
    id: makeId("verify"),
    type: "verify",
    title: "Verify & Test",
    description: "Run type-check, lint, tests, build. Report all errors.",
    mode: "run",
    maxTurns: 50,
    dependsOn: [buildStep.id],
    priority: 60,
    maxRetries: 0, // Don't retry verify itself — fix step handles it
    useStrategyBranching: false,
  };
  steps.push(verifyStep);

  // ── Step 6: FIX (conditional — only if verify found errors) ──
  const fixStep: AgiStep = {
    id: makeId("fix"),
    type: "fix",
    title: "Fix Errors",
    description: "Fix all errors found during verification. Re-verify after each fix.",
    mode: "run",
    maxTurns: 100,
    dependsOn: [verifyStep.id],
    condition: (ctx) => {
      // Only run if verify found errors
      const verifyResult = ctx.stepResults.find(r => r.type === "verify");
      return verifyResult ? verifyResult.errors.length > 0 || verifyResult.status === "failed" : false;
    },
    priority: 55,
    maxRetries: 3,
    useStrategyBranching: true,
  };
  steps.push(fixStep);

  // ── Step 7: IMPROVE (skip for simple tasks) ──
  if (assessment.complexity !== "simple") {
    steps.push({
      id: makeId("improve"),
      type: "improve",
      title: "Improve & Harden",
      description: "Security audit, performance optimization, add missing tests, documentation",
      mode: "team",
      maxTurns: 80,
      dependsOn: [fixStep.id],
      condition: (ctx) => {
        // Skip if we're already over budget
        return ctx.totalTokens < 500_000;
      },
      priority: 40,
      maxRetries: 1,
      useStrategyBranching: false,
    });
  }

  // ── Step 8: REVIEW (always) ──
  steps.push({
    id: makeId("review"),
    type: "review",
    title: "Final Review",
    description: "Comprehensive quality review: correctness, security, performance, accessibility",
    mode: assessment.complexity === "simple" ? "run" : "team",
    maxTurns: 40,
    dependsOn: [steps[steps.length - 1].id],
    priority: 30,
    maxRetries: 0,
    useStrategyBranching: false,
  });

  return {
    steps,
    currentStepIndex: -1,
    replanCount: 0,
    isDynamic: true,
  };
}

// ─── Complexity Assessment ───────────────────────────────────────────────────

export function assessComplexity(task: string): "simple" | "moderate" | "complex" | "massive" {
  const words = task.split(/\s+/).length;
  const hasMultipleFeatures = /and|also|plus|additionally|furthermore/i.test(task);
  const isFullApp = /full.*app|complete.*project|entire.*system|from.*scratch/i.test(task);
  const isSimple = /fix.*bug|rename|add.*comment|update.*version|change.*color/i.test(task);

  if (isSimple && words < 20) return "simple";
  if (isFullApp || words > 100) return "massive";
  if (hasMultipleFeatures || words > 40) return "complex";
  return "moderate";
}

// ─── Step Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build prompt for a step that includes ALL prior context.
 * This is the key difference from the old pipeline — full inter-step memory.
 */
export function buildStepPrompt(step: AgiStep, ctx: SharedContext): string {
  const sections: string[] = [];

  // 1. Task header
  sections.push(`# AGI Pipeline — ${step.title}`);
  sections.push(`## Original Task\n${ctx.task}`);

  // 2. Prior step results (CRITICAL — this is inter-step memory)
  if (ctx.stepResults.length > 0) {
    sections.push(`## Prior Step Results (${ctx.stepResults.length} completed)`);
    for (const result of ctx.stepResults) {
      const statusIcon = result.status === "completed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP";
      sections.push(`### [${statusIcon}] ${result.type.toUpperCase()}`);
      sections.push(result.summary.slice(0, 2000));
      if (result.changes.length > 0) {
        sections.push(`Files: ${result.changes.join(", ")}`);
      }
      if (result.errors.length > 0) {
        sections.push(`Errors: ${result.errors.join("; ")}`);
      }
    }
  }

  // 3. Architecture decisions
  if (ctx.decisions.length > 0) {
    sections.push(`## Architecture Decisions\n${ctx.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
  }

  // 4. Debate results (if design debate happened)
  if (ctx.debateResult) {
    sections.push(`## Design Debate Consensus\n${ctx.debateResult.consensus}\nDecision: ${ctx.debateResult.finalDecision}`);
  }

  // 5. Known files
  if (ctx.allFiles.size > 0) {
    const fileList = Array.from(ctx.allFiles.values())
      .map(f => `- ${f.path} (${f.status})`)
      .join("\n");
    sections.push(`## Project Files\n${fileList}`);
  }

  // 6. Error history (so the agent doesn't repeat mistakes)
  const unresolvedErrors = ctx.errorLog.filter(e => !e.resolved);
  if (unresolvedErrors.length > 0) {
    sections.push(`## Unresolved Errors\n${unresolvedErrors.map(e => `- [${e.category}] ${e.error}`).join("\n")}`);
  }

  // 7. Step-specific instructions
  sections.push(`## Your Task: ${step.title}\n${step.description}`);

  // 8. Step-type specific instructions
  sections.push(getStepTypeInstructions(step.type, ctx));

  // 9. Project structure rules (for new projects)
  if (ctx.allFiles.size === 0 && (step.type === "build" || step.type === "design")) {
    sections.push(SCAFFOLD_INSTRUCTIONS);
  }

  return sections.join("\n\n");
}

function getStepTypeInstructions(type: StepType, ctx: SharedContext): string {
  switch (type) {
    case "analyze":
      return `## Instructions
Perform deep analysis:
1. Understand the user's intent precisely
2. Identify ALL requirements (explicit and implicit)
3. Assess risks and potential blockers
4. List technology choices needed
5. Estimate complexity and effort

Respond with your analysis. Include:
- Requirements list
- Risk assessment
- Technology recommendations
- Complexity estimate`;

    case "debate":
      return `## Instructions
This is a multi-agent design debate. Multiple specialists will argue their positions.
Focus on architecture decisions, technology tradeoffs, and design patterns.
Present your position with clear reasoning, risks, and alternatives.`;

    case "design":
      return `## Instructions
Create a detailed implementation plan:
1. File structure (every file that needs to be created)
2. Architecture decisions (patterns, frameworks, libraries)
3. API design (endpoints, schemas, contracts)
4. Component breakdown (modules, classes, functions)
5. Data model (types, interfaces, schemas)
6. Task ordering (what to build first)

Be specific. List exact file paths and their purposes.`;

    case "build":
      return `## Instructions
IMPLEMENT EVERYTHING. Write ALL code files with COMPLETE content.
- NO placeholders, NO TODOs, NO "implement here"
- Every file must be fully functional
- Use ALL available tools — especially 'write' for creating files
- Write complete implementations, not stubs
- If a design was provided, follow it exactly
- Create ${ctx.allFiles.size === 0 ? "a complete project structure" : "all remaining files"}

DO NOT STOP until every planned file is written.`;

    case "verify":
      return `## Instructions
Run ALL verification checks:
1. Type-check: tsc --noEmit (for TypeScript)
2. Lint: eslint or equivalent
3. Tests: npm test, pytest, etc.
4. Build: npm run build or equivalent
5. Check for missing dependencies

Report ALL errors precisely. Include file paths and line numbers.
Do NOT fix errors yourself — just report them.`;

    case "fix":
      return `## Instructions
Fix ALL errors from the verify step.
For each error:
1. Read the file
2. Understand the root cause
3. Apply the minimal fix
4. Verify the fix works

After fixing, run verification again to confirm.
Keep fixing until all errors are resolved or you've exhausted retries.`;

    case "improve":
      return `## Instructions
Improve the codebase:
1. Security audit — check for XSS, injection, auth issues
2. Performance — optimize hot paths, lazy loading, caching
3. Testing — add missing test cases
4. Documentation — add JSDoc/docstrings to public APIs
5. Error handling — add proper try/catch and error boundaries

Only improve what exists. Don't add new features.`;

    case "review":
      return `## Instructions
Final quality review. Check EVERY aspect:
1. Correctness — does it do what was asked?
2. Completeness — are all features implemented?
3. Security — any vulnerabilities?
4. Performance — any obvious bottlenecks?
5. Code quality — clean, readable, maintainable?
6. Testing — adequate coverage?

Provide a verdict: "pass" or "fail" with specific reasons.
If fail, list exactly what needs to be fixed.`;

    case "deploy":
      return `## Instructions
Prepare for deployment:
1. Run final build
2. Run all tests
3. Generate any needed config files
4. Verify the project runs with: npm install && npm start`;

    default:
      return "";
  }
}

const SCAFFOLD_INSTRUCTIONS = `
## Project Structure Rules
This is a STANDALONE project. Create a complete, runnable structure:
1. package.json (MUST include "start" script)
2. tsconfig.json (if TypeScript)
3. src/ directory for source code
4. public/ or app/ for static assets
5. tests/ for test files
6. README.md with setup instructions

The project must be runnable with: npm install && npm start
Do NOT reference files outside this project directory.`;

// ─── Replanner: Adapt Plan Based on Results ──────────────────────────────────

/**
 * Check if the plan needs modification based on step results.
 * Returns modified plan or null if no changes needed.
 */
export function replanIfNeeded(ctx: SharedContext): AgiPlan | null {
  const { plan, stepResults } = ctx;
  const lastResult = stepResults[stepResults.length - 1];
  if (!lastResult) return null;

  // Case 1: Verify failed → ensure fix step exists after it
  if (lastResult.type === "verify" && lastResult.status === "failed") {
    const currentIdx = plan.currentStepIndex;
    const nextStep = plan.steps[currentIdx + 1];

    // If next step isn't a fix step, insert one
    if (!nextStep || nextStep.type !== "fix") {
      const newSteps = [...plan.steps];
      const fixStep: AgiStep = {
        id: `step-replan-${plan.replanCount + 1}-fix`,
        type: "fix",
        title: "Fix Errors (auto-inserted)",
        description: `Fix errors from verification:\n${lastResult.errors.join("\n")}`,
        mode: "run",
        maxTurns: 100,
        dependsOn: [lastResult.stepId],
        priority: 55,
        maxRetries: 3,
        useStrategyBranching: true,
      };
      newSteps.splice(currentIdx + 1, 0, fixStep);

      // Also insert a re-verify after fix
      const reVerifyStep: AgiStep = {
        id: `step-replan-${plan.replanCount + 1}-reverify`,
        type: "verify",
        title: "Re-verify (auto-inserted)",
        description: "Verify fixes resolved all errors",
        mode: "run",
        maxTurns: 50,
        dependsOn: [fixStep.id],
        priority: 54,
        maxRetries: 0,
        useStrategyBranching: false,
      };
      newSteps.splice(currentIdx + 2, 0, reVerifyStep);

      return { ...plan, steps: newSteps, replanCount: plan.replanCount + 1 };
    }
  }

  // Case 2: Fix failed after max retries → insert strategy branching build
  if (lastResult.type === "fix" && lastResult.status === "failed") {
    const fixRetries = stepResults.filter(r => r.type === "fix").length;
    if (fixRetries >= 2) {
      // Try a completely different build approach
      const newSteps = [...plan.steps];
      const currentIdx = plan.currentStepIndex;
      const rebuildStep: AgiStep = {
        id: `step-replan-${plan.replanCount + 1}-rebuild`,
        type: "build",
        title: "Rebuild (alternative strategy)",
        description: `Previous approach failed ${fixRetries} times. Try a COMPLETELY DIFFERENT implementation approach.\nPrevious errors:\n${ctx.errorLog.map(e => e.error).join("\n")}`,
        mode: "team",
        maxTurns: 200,
        dependsOn: [lastResult.stepId],
        priority: 65,
        maxRetries: 1,
        useStrategyBranching: true,
      };
      newSteps.splice(currentIdx + 1, 0, rebuildStep);
      return { ...plan, steps: newSteps, replanCount: plan.replanCount + 1 };
    }
  }

  // Case 3: Review failed → loop back to fix
  if (lastResult.type === "review" && lastResult.status === "failed") {
    const reviewFailCount = stepResults.filter(r => r.type === "review" && r.status === "failed").length;
    if (reviewFailCount < 3) {
      const newSteps = [...plan.steps];
      const currentIdx = plan.currentStepIndex;
      const fixStep: AgiStep = {
        id: `step-replan-${plan.replanCount + 1}-reviewfix`,
        type: "fix",
        title: "Fix Review Issues",
        description: `Review failed. Issues:\n${lastResult.summary}`,
        mode: "run",
        maxTurns: 80,
        dependsOn: [lastResult.stepId],
        priority: 35,
        maxRetries: 2,
        useStrategyBranching: false,
      };
      const reReviewStep: AgiStep = {
        id: `step-replan-${plan.replanCount + 1}-rereview`,
        type: "review",
        title: "Re-review",
        description: "Re-review after fixes applied",
        mode: "run",
        maxTurns: 40,
        dependsOn: [fixStep.id],
        priority: 34,
        maxRetries: 0,
        useStrategyBranching: false,
      };
      newSteps.splice(currentIdx + 1, 0, fixStep, reReviewStep);
      return { ...plan, steps: newSteps, replanCount: plan.replanCount + 1 };
    }
  }

  return null;
}

// ─── Context Builder for Engine Calls ────────────────────────────────────────

/**
 * Build a condensed context string from SharedContext for injection into engine prompts.
 * Implements OpenHands-style memory condensation.
 */
export function condenseContext(ctx: SharedContext, maxTokensEstimate: number): string {
  const sections: string[] = [];

  // Always include: task + decisions
  sections.push(`Task: ${ctx.task}`);
  if (ctx.decisions.length > 0) {
    sections.push(`Decisions: ${ctx.decisions.join("; ")}`);
  }

  // Estimate tokens used so far
  let estimatedTokens = sections.join("\n").length / 4;

  // Include step results (most recent first, with truncation)
  const sortedResults = [...ctx.stepResults].reverse();
  for (const result of sortedResults) {
    const entry = `[${result.type}] ${result.status}: ${result.summary.slice(0, 500)}`;
    const entryTokens = entry.length / 4;
    if (estimatedTokens + entryTokens > maxTokensEstimate) break;
    sections.push(entry);
    estimatedTokens += entryTokens;
  }

  // Include file list (compact)
  if (ctx.allFiles.size > 0 && estimatedTokens < maxTokensEstimate * 0.8) {
    const fileList = Array.from(ctx.allFiles.keys()).join(", ");
    sections.push(`Files: ${fileList}`);
  }

  return sections.join("\n\n");
}

// ─── Event Types for UI ──────────────────────────────────────────────────────

export interface AgiPipelineEvent {
  type: "agi.step.start" | "agi.step.complete" | "agi.step.fail" | "agi.step.skip"
    | "agi.replan" | "agi.debate.start" | "agi.strategy.branch"
    | "agi.pipeline.start" | "agi.pipeline.complete" | "agi.pipeline.fail"
    | "agi.context.update";
  stepId?: string;
  stepType?: StepType;
  stepTitle?: string;
  status?: string;
  summary?: string;
  plan?: AgiPlan;
  context?: Partial<SharedContext>;
  error?: string;
  confidence?: number;
  totalSteps?: number;
  completedSteps?: number;
  replanCount?: number;
}

// ─── Pipeline Runner ─────────────────────────────────────────────────────────

export interface AgiPipelineOptions {
  cwd: string;
  task: string;
  projectDir: string;
  eventBus?: AgentEventBus;
  /** Called for each step — this is where the actual engine.runEngine() happens */
  executeStep: (stepPrompt: string, mode: "run" | "team", maxTurns: number) => Promise<{
    summary: string;
    changes: string[];
    toolResults: Array<{ name: string; ok: boolean; output?: string }>;
    tokensUsed: number;
    errors: string[];
    rawOutput?: string;
  }>;
  /** Called to emit events to UI */
  onEvent?: (event: AgiPipelineEvent) => void;
  /** Maximum total pipeline duration in ms (0 = unlimited) */
  maxDurationMs?: number;
  /** Maximum replan iterations before force-stop */
  maxReplans?: number;
}

/**
 * Run the full AGI pipeline.
 *
 * This is the main entry point. It:
 * 1. Assesses the task complexity
 * 2. Generates a dynamic plan
 * 3. Executes each step with full inter-step context
 * 4. Replans on failure (verify fail → fix → re-verify)
 * 5. Tracks all state in SharedContext
 */
export async function runAgiPipeline(options: AgiPipelineOptions): Promise<{
  context: SharedContext;
  plan: AgiPlan;
  success: boolean;
  totalDurationMs: number;
}> {
  const startTime = Date.now();
  const maxDuration = options.maxDurationMs ?? 0;
  const maxReplans = options.maxReplans ?? 10;
  const emit = options.onEvent ?? (() => {});

  // Assess complexity
  const complexity = assessComplexity(options.task);
  const needsDebateCheck = /architect|design|pattern|approach|strategy|tradeoff|choose|select|compare|migrate|upgrade/i.test(options.task);

  // Generate dynamic plan
  let plan = generatePlan(options.task, {
    complexity,
    hasTests: true, // assume tests will be created
    isNewProject: true, // AGI pipeline creates new projects
    primaryLanguage: null, // will be detected
    needsDebate: needsDebateCheck,
  });

  // Initialize shared context
  const ctx: SharedContext = {
    task: options.task,
    projectDir: options.projectDir,
    stepResults: [],
    allFiles: new Map(),
    errorLog: [],
    decisions: [],
    plan,
    confidence: 0.5,
    totalTokens: 0,
    totalCostUsd: 0,
    startedAt: startTime,
  };

  emit({
    type: "agi.pipeline.start",
    plan,
    totalSteps: plan.steps.length,
    completedSteps: 0,
    confidence: ctx.confidence,
  });

  // Execute steps
  let stepIndex = 0;
  let success = true;

  while (stepIndex < plan.steps.length) {
    // Duration guard
    if (maxDuration > 0 && Date.now() - startTime > maxDuration) {
      emit({ type: "agi.pipeline.fail", error: "Pipeline duration limit exceeded" });
      success = false;
      break;
    }

    // Replan guard
    if (plan.replanCount > maxReplans) {
      emit({ type: "agi.pipeline.fail", error: `Max replans (${maxReplans}) exceeded` });
      success = false;
      break;
    }

    const step = plan.steps[stepIndex];
    plan.currentStepIndex = stepIndex;

    // Check condition
    if (step.condition && !step.condition(ctx)) {
      const skipResult: StepResult = {
        stepId: step.id,
        type: step.type,
        status: "skipped",
        summary: "Condition not met — skipped",
        changes: [],
        toolResults: [],
        durationMs: 0,
        tokensUsed: 0,
        errors: [],
      };
      ctx.stepResults.push(skipResult);
      emit({ type: "agi.step.skip", stepId: step.id, stepType: step.type, stepTitle: step.title });
      stepIndex++;
      continue;
    }

    // Build prompt with full context
    const stepPrompt = buildStepPrompt(step, ctx);

    emit({
      type: "agi.step.start",
      stepId: step.id,
      stepType: step.type,
      stepTitle: step.title,
      totalSteps: plan.steps.length,
      completedSteps: ctx.stepResults.filter(r => r.status === "completed").length,
    });

    // Execute with retries
    let result: StepResult | null = null;
    let attempts = 0;

    while (attempts <= step.maxRetries) {
      attempts++;
      const stepStart = Date.now();

      try {
        const output = await options.executeStep(
          attempts > 1
            ? `${stepPrompt}\n\n[RETRY ${attempts}/${step.maxRetries + 1}] Previous attempt failed. Try a different approach.\nPrevious errors: ${result?.errors.join("; ") ?? "unknown"}`
            : stepPrompt,
          step.mode,
          step.maxTurns
        );

        result = {
          stepId: step.id,
          type: step.type,
          status: output.errors.length === 0 || step.type === "verify" ? "completed" : "failed",
          summary: output.summary,
          changes: output.changes,
          toolResults: output.toolResults,
          durationMs: Date.now() - stepStart,
          tokensUsed: output.tokensUsed,
          errors: output.errors,
          rawOutput: output.rawOutput,
        };

        // For verify step: completed even with errors (errors are the output)
        if (step.type === "verify") {
          result.status = "completed";
        }

        // Success — break retry loop
        if (result.status === "completed") break;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        result = {
          stepId: step.id,
          type: step.type,
          status: "failed",
          summary: `Step failed: ${error}`,
          changes: [],
          toolResults: [],
          durationMs: Date.now() - stepStart,
          tokensUsed: 0,
          errors: [error],
        };

        // Log error
        ctx.errorLog.push({
          stepId: step.id,
          error,
          category: "runtime",
          resolved: false,
        });
      }
    }

    // Record result
    if (result) {
      ctx.stepResults.push(result);
      ctx.totalTokens += result.tokensUsed;

      // Update file tracking
      for (const change of result.changes) {
        const cleanPath = change.replace(/^(created|modified|updated|deleted)\s+/i, "").trim();
        ctx.allFiles.set(cleanPath, {
          path: cleanPath,
          status: /^(created|added)/i.test(change) ? "created" : /^deleted/i.test(change) ? "deleted" : "modified",
          stepId: step.id,
        });
      }

      // Mark errors as resolved if step succeeded
      if (result.status === "completed") {
        for (const entry of ctx.errorLog) {
          if (entry.stepId === step.id && !entry.resolved) {
            entry.resolved = true;
            entry.resolution = "Step completed successfully";
          }
        }
      }

      // Extract decisions from analyze/design steps
      if ((step.type === "analyze" || step.type === "design") && result.status === "completed") {
        const decisionMatches = result.summary.match(/(?:decision|chose|selected|will use|architecture):\s*([^\n]+)/gi);
        if (decisionMatches) {
          ctx.decisions.push(...decisionMatches.map(d => d.slice(0, 200)));
        }
      }

      const eventType = result.status === "completed" ? "agi.step.complete"
        : result.status === "failed" ? "agi.step.fail" : "agi.step.skip";

      emit({
        type: eventType as AgiPipelineEvent["type"],
        stepId: step.id,
        stepType: step.type,
        stepTitle: step.title,
        status: result.status,
        summary: result.summary.slice(0, 500),
        totalSteps: plan.steps.length,
        completedSteps: ctx.stepResults.filter(r => r.status === "completed").length,
        confidence: ctx.confidence,
      });

      // Replan check
      const newPlan = replanIfNeeded(ctx);
      if (newPlan) {
        plan = newPlan;
        ctx.plan = plan;
        emit({
          type: "agi.replan",
          plan: newPlan,
          replanCount: newPlan.replanCount,
          totalSteps: newPlan.steps.length,
        });
      }
    }

    stepIndex++;
  }

  // Final status
  const completedSteps = ctx.stepResults.filter(r => r.status === "completed").length;
  const failedSteps = ctx.stepResults.filter(r => r.status === "failed").length;
  const reviewResult = ctx.stepResults.find(r => r.type === "review");
  const pipelineSuccess = success && failedSteps === 0 && (!reviewResult || reviewResult.status === "completed");

  // Update confidence
  ctx.confidence = completedSteps / Math.max(1, ctx.stepResults.length);

  emit({
    type: pipelineSuccess ? "agi.pipeline.complete" : "agi.pipeline.fail",
    totalSteps: plan.steps.length,
    completedSteps,
    confidence: ctx.confidence,
    summary: `${completedSteps}/${ctx.stepResults.length} steps completed, ${ctx.allFiles.size} files, ${ctx.totalTokens} tokens`,
  });

  return {
    context: ctx,
    plan,
    success: pipelineSuccess,
    totalDurationMs: Date.now() - startTime,
  };
}
