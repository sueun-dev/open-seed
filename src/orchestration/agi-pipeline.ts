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
 * Key differences from older pipelines:
 * 1. Inter-step shared memory (SharedContext) — every step sees all prior results
 * 2. Dynamic build-wave expansion from the DesignArtifact while keeping the top-level phases fixed
 * 3. Fixed six-phase routing — ANALYZE → DEBATE → DESIGN → BUILD → VERIFY → FIX
 * 4. No turn limit — agentic loop runs until done (maxTurns: 200)
 * 5. All subsystems wired — debate, strategy branching, confidence, HITL, dep-graph
 * 6. Artifact handoff — downstream steps consume normalized upstream artifacts, not raw transcripts
 */

import type { AgentEventBus } from "../core/event-bus.js";
import type { RunEngineOptions, RunEngineResult } from "./engine.js";
import type { AnalyzeArtifact } from "./analyze-artifact.js";
import { extractAnalyzeArtifactFromText, renderAnalyzeArtifact } from "./analyze-artifact.js";
import type { DebateArtifact } from "./debate-artifact.js";
import { extractDebateArtifactFromText, renderDebateArtifact } from "./debate-artifact.js";
import type { DesignArtifact, DesignBuildWave, DesignWorkstream } from "./design-artifact.js";
import { extractDesignArtifactFromText, renderDesignArtifact } from "./design-artifact.js";

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
  /** Normalized output from the ANALYZE step */
  analyzeArtifact?: AnalyzeArtifact;
  /** Normalized output from the DEBATE step */
  debateArtifact?: DebateArtifact;
  /** Normalized output from the DESIGN step */
  designArtifact?: DesignArtifact;
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
  | "debate"     // Multi-agent design debate
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
  /** Normalized output from the ANALYZE step */
  analysisArtifact?: AnalyzeArtifact;
  /** Normalized output from the DEBATE step */
  debateArtifact?: DebateArtifact;
  /** Normalized output from the DESIGN step */
  designArtifact?: DesignArtifact;
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
 * Generate the fixed six-phase AGI pipeline.
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

  // ── Step 2: DEBATE (default) ──
  steps.push({
    id: makeId("debate"),
    type: "debate",
    title: "Multi-Agent Design Debate",
    description: assessment.needsDebate
      ? "Specialists debate architecture, technology choices, and tradeoffs"
      : "Stress-test the implementation approach, edge cases, and tradeoffs before coding",
    mode: "team",
    maxTurns: 50,
    dependsOn: [steps[steps.length - 1].id],
    priority: 90,
    maxRetries: 0,
    useStrategyBranching: false,
  });

  // ── Step 3: DESIGN (default) ──
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

  // ── Step 4: BUILD (always — the core step) ──
  const buildStep: AgiStep = {
    id: makeId("build"),
    type: "build",
    title: "Build & Implement",
    description: "Write ALL code files. Complete implementation with no placeholders.",
    mode: "team",
    maxTurns: 200, // Unlimited for complex builds
    dependsOn: [steps[steps.length - 1].id],
    condition: (ctx) => !ctx.analyzeArtifact?.clarificationRequired
      && ctx.debateArtifact?.readiness !== "blocked"
      && ctx.designArtifact?.readiness !== "blocked",
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

  // ── Step 6: FIX (always, but may become a no-op if VERIFY found nothing) ──
  steps.push({
    id: makeId("fix"),
    type: "fix",
    title: "Fix Errors",
    description: "Address verification findings with targeted code changes. If VERIFY found nothing actionable, confirm that no fixes were required.",
    mode: "run",
    maxTurns: 100,
    dependsOn: [verifyStep.id],
    priority: 55,
    maxRetries: 3,
    useStrategyBranching: true,
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
  const analysisArtifact = step.type !== "analyze" ? ctx.analyzeArtifact : undefined;
  const debateArtifact = step.type !== "analyze" && step.type !== "debate" ? ctx.debateArtifact : undefined;
  const designArtifact = step.type !== "analyze" && step.type !== "debate" && step.type !== "design" ? ctx.designArtifact : undefined;

  // 1. Task header
  sections.push(`# AGI Pipeline — ${step.title}`);
  sections.push(`## Original Task\n${ctx.task}`);

  // 2. Prior step results (CRITICAL — this is inter-step memory)
  if (ctx.stepResults.length > 0) {
    sections.push(`## Prior Step Results (${ctx.stepResults.length} completed)`);
    for (const result of ctx.stepResults) {
      const statusIcon = result.status === "completed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP";
      if (result.type === "analyze" && analysisArtifact && step.type !== "analyze") {
        sections.push(`### [${statusIcon}] ANALYZE`);
        sections.push("AnalyzeArtifact generated. Use the normalized artifact below as the authoritative ANALYZE output.");
      } else if (result.type === "debate" && debateArtifact && step.type !== "debate") {
        sections.push(`### [${statusIcon}] DEBATE`);
        sections.push("DebateArtifact generated. Use the normalized artifact below as the authoritative DEBATE output.");
      } else if (result.type === "design" && designArtifact && step.type !== "design") {
        sections.push(`### [${statusIcon}] DESIGN`);
        sections.push("DesignArtifact generated. Use the normalized artifact below as the authoritative DESIGN output.");
      } else {
        sections.push(`### [${statusIcon}] ${result.type.toUpperCase()}`);
        sections.push(getStepResultContext(result));
      }
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

  // 7. Normalized analyze context
  if (analysisArtifact) {
    sections.push(renderAnalyzeArtifact(analysisArtifact));
  }

  // 8. Normalized debate context
  if (debateArtifact) {
    sections.push(renderDebateArtifact(debateArtifact));
  }

  // 9. Normalized design context
  if (designArtifact) {
    sections.push(renderDesignArtifact(designArtifact));
  }

  // 10. Step-specific instructions
  sections.push(`## Your Task: ${step.title}\n${step.description}`);

  // 11. Step-type specific instructions
  sections.push(getStepTypeInstructions(step.type, ctx));

  // 12. Project structure rules (for new projects)
  if (ctx.allFiles.size === 0 && (step.type === "build" || step.type === "design")) {
    sections.push(SCAFFOLD_INSTRUCTIONS);
  }

  return sections.join("\n\n");
}

function getStepResultContext(result: StepResult): string {
  const rawOutput = result.rawOutput?.trim();
  if (rawOutput) {
    return rawOutput;
  }
  return result.summary;
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
Treat the Analyze Artifact as the only authoritative ANALYZE output.
Do not reconstruct or speculate from missing raw transcripts.
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
7. Workstream decomposition (scaffold, frontend, backend, database, realtime, testing, docs as needed)
8. Build waves (which workstreams can run together and which must wait)
9. Test plan (which test files prove each critical path)

Treat AnalyzeArtifact and DebateArtifact as the authoritative upstream outputs.
Do not reconstruct design direction from missing raw debate transcripts.
Design output must be rich enough to produce a DesignArtifact with file manifest, workstreams, build waves, and test plan.
Be specific. List exact file paths and their purposes.`;

    case "build":
      return `## Instructions
IMPLEMENT EVERYTHING. Write ALL code files with COMPLETE content.
- NO placeholders, NO TODOs, NO "implement here"
- Every file must be fully functional
- Use ALL available tools — especially 'write' for creating files
- Write complete implementations, not stubs
- Treat the DesignArtifact as the authoritative build plan
- Create the tests/ files and test code described in the DesignArtifact workstreams and test plan
- If a design was provided, follow it exactly
- Create ${ctx.allFiles.size === 0 ? "a complete project structure" : "all remaining files"}
- DO NOT run typecheck, lint, test, or build verification inside BUILD
- DO NOT perform final review inside BUILD; VERIFY and REVIEW are separate stages

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
Do NOT write or edit files in VERIFY.
Do NOT fix errors yourself — just report them.`;

    case "fix":
      return `## Instructions
Fix ALL errors from the verify step.
For each error:
1. Read the file
2. Understand the root cause
3. Apply the minimal fix
4. Update the code or tests that are actually broken

Do NOT run verification commands inside FIX.
The next VERIFY step will confirm whether the fixes worked.`;

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
If fail, list exactly what needs to be fixed.
Do NOT edit files or execute build/fix work in REVIEW.`;

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

function buildWaveDescription(wave: DesignBuildWave, workstreams: DesignWorkstream[], artifact: DesignArtifact): string {
  const files = Array.from(new Set(workstreams.flatMap((workstream) => workstream.files)));
  const deliverables = Array.from(new Set(workstreams.flatMap((workstream) => workstream.deliverables)));
  const testTargets = Array.from(new Set(workstreams.flatMap((workstream) => workstream.testTargets)));
  const lines: string[] = [
    `Implement build wave ${wave.wave}: ${wave.title}.`,
    `Objective: ${wave.objective}`,
  ];

  if (workstreams.length > 0) {
    lines.push(`Workstreams:
${workstreams.map((workstream) => `- ${workstream.id} [${workstream.owner}] ${workstream.title} — ${workstream.focus}`).join("\n")}`);
  }
  if (files.length > 0) {
    lines.push(`Files to create or complete:
${files.map((filePath) => `- ${filePath}`).join("\n")}`);
  }
  if (deliverables.length > 0) {
    lines.push(`Deliverables:
${deliverables.map((item) => `- ${item}`).join("\n")}`);
  }
  if (testTargets.length > 0) {
    lines.push(`Tests to author or update in this wave:
${testTargets.map((target) => `- ${target}`).join("\n")}`);
  }
  if (artifact.acceptanceChecks.length > 0) {
    lines.push(`Acceptance checks to keep in view:
${artifact.acceptanceChecks.map((check) => `- ${check}`).join("\n")}`);
  }

  return lines.join("\n\n");
}

function expandBuildStepsFromDesignArtifact(plan: AgiPlan, designArtifact: DesignArtifact): AgiPlan | null {
  if (designArtifact.readiness === "blocked") return null;

  const buildIdx = plan.steps.findIndex((step, index) => index > plan.currentStepIndex && step.type === "build");
  if (buildIdx === -1) return null;

  const buildStep = plan.steps[buildIdx];
  if (buildStep.title.startsWith("Build Wave ")) return null;

  const workstreamById = new Map(designArtifact.workstreams.map((workstream) => [workstream.id, workstream]));
  const waves = designArtifact.buildWaves.length > 0
    ? designArtifact.buildWaves
    : [{
      wave: 1,
      title: buildStep.title,
      objective: buildStep.description,
      workstreamIds: designArtifact.workstreams.map((workstream) => workstream.id),
    } satisfies DesignBuildWave];

  const expandedSteps: AgiStep[] = waves.map((wave, index) => {
    const waveWorkstreams = wave.workstreamIds.map((id) => workstreamById.get(id)).filter((value): value is DesignWorkstream => Boolean(value));
    const fileCount = waveWorkstreams.reduce((total, workstream) => total + workstream.files.length, 0);
    const turnBudget = Math.min(200, Math.max(60, 45 + fileCount * 4));
    return {
      id: `${buildStep.id}-wave-${wave.wave}`,
      type: "build",
      title: `Build Wave ${wave.wave}: ${wave.title}`,
      description: buildWaveDescription(wave, waveWorkstreams, designArtifact),
      mode: "team",
      maxTurns: Math.min(buildStep.maxTurns, turnBudget),
      dependsOn: index === 0 ? buildStep.dependsOn : [`${buildStep.id}-wave-${waves[index - 1]?.wave ?? wave.wave - 1}`],
      condition: buildStep.condition,
      priority: Math.max(1, buildStep.priority - index),
      maxRetries: buildStep.maxRetries,
      useStrategyBranching: buildStep.useStrategyBranching,
    };
  });

  const newSteps = [...plan.steps];
  newSteps.splice(buildIdx, 1, ...expandedSteps);
  const lastExpandedId = expandedSteps[expandedSteps.length - 1]?.id ?? buildStep.id;

  for (let index = buildIdx + expandedSteps.length; index < newSteps.length; index++) {
    const step = newSteps[index];
    if (!step.dependsOn.includes(buildStep.id)) continue;
    newSteps[index] = {
      ...step,
      dependsOn: step.dependsOn.map((dependencyId) => dependencyId === buildStep.id ? lastExpandedId : dependencyId),
    };
  }

  return {
    ...plan,
    steps: newSteps,
    replanCount: plan.replanCount + 1,
  };
}

// ─── Replanner: Adapt Plan Based on Results ──────────────────────────────────

/**
 * Check if the plan needs modification based on step results.
 * Returns modified plan or null if no changes needed.
 */
export function replanIfNeeded(ctx: SharedContext): AgiPlan | null {
  const { plan, stepResults } = ctx;
  const lastResult = stepResults[stepResults.length - 1];
  if (!lastResult) return null;

  if (lastResult.type === "design" && lastResult.status === "completed" && ctx.designArtifact) {
    const expandedPlan = expandBuildStepsFromDesignArtifact(plan, ctx.designArtifact);
    if (expandedPlan) {
      return expandedPlan;
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
  if (ctx.analyzeArtifact) {
    sections.push(`Analyze: ${ctx.analyzeArtifact.summary}`);
  }
  if (ctx.debateArtifact) {
    sections.push(`Debate: ${ctx.debateArtifact.summary}`);
  }
  if (ctx.designArtifact) {
    sections.push(`Design: ${ctx.designArtifact.summary}`);
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
  executeStep: (stepPrompt: string, mode: "run" | "team", maxTurns: number, step: AgiStep) => Promise<{
    summary: string;
    changes: string[];
    toolResults: Array<{ name: string; ok: boolean; output?: string }>;
    tokensUsed: number;
    errors: string[];
    rawOutput?: string;
    analysisArtifact?: AnalyzeArtifact;
    debateArtifact?: DebateArtifact;
    designArtifact?: DesignArtifact;
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
 * 4. Expands BUILD into waves from the DesignArtifact when available
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
    analyzeArtifact: undefined,
    debateArtifact: undefined,
    designArtifact: undefined,
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
          step.maxTurns,
          step
        );

        const analysisArtifact = step.type === "analyze"
          ? (output.analysisArtifact ?? extractAnalyzeArtifactFromText(options.task, output.rawOutput ?? output.summary ?? "") ?? undefined)
          : undefined;
        const debateArtifact = step.type === "debate"
          ? (output.debateArtifact ?? extractDebateArtifactFromText(
            options.task,
            output.rawOutput ?? output.summary ?? "",
            ctx.analyzeArtifact ?? undefined
          ) ?? undefined)
          : undefined;
        const designArtifact = step.type === "design"
          ? (output.designArtifact ?? extractDesignArtifactFromText(
            options.task,
            output.rawOutput ?? output.summary ?? "",
            ctx.analyzeArtifact ?? undefined,
            ctx.debateArtifact ?? undefined
          ) ?? undefined)
          : undefined;

        const stepErrors = [...output.errors];
        if (step.type === "analyze" && !analysisArtifact) {
          stepErrors.push("AnalyzeArtifact generation failed.");
        }
        if (step.type === "debate" && !debateArtifact) {
          stepErrors.push("DebateArtifact generation failed.");
        }
        if (step.type === "design" && !designArtifact) {
          stepErrors.push("DesignArtifact generation failed.");
        }

        const nextResult: StepResult = {
          stepId: step.id,
          type: step.type,
          status: stepErrors.length === 0 ? "completed" : "failed",
          summary: step.type === "analyze" && analysisArtifact
            ? analysisArtifact.summary
            : step.type === "debate" && debateArtifact
              ? debateArtifact.summary
              : step.type === "design" && designArtifact
                ? designArtifact.summary
                : output.summary,
          changes: output.changes,
          toolResults: output.toolResults,
          durationMs: Date.now() - stepStart,
          tokensUsed: output.tokensUsed,
          errors: Array.from(new Set(stepErrors)),
          rawOutput: step.type === "analyze" && analysisArtifact
            ? JSON.stringify(analysisArtifact, null, 2)
            : step.type === "debate" && debateArtifact
              ? JSON.stringify(debateArtifact, null, 2)
              : step.type === "design" && designArtifact
                ? JSON.stringify(designArtifact, null, 2)
                : output.rawOutput,
          analysisArtifact,
          debateArtifact,
          designArtifact,
        };
        result = nextResult;

        // Success — break retry loop
        if (nextResult.status === "completed") break;
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

      if (step.type === "analyze" && result.analysisArtifact) {
        ctx.analyzeArtifact = result.analysisArtifact;
      }
      if (step.type === "debate" && result.debateArtifact) {
        ctx.debateArtifact = result.debateArtifact;
      }
      if (step.type === "design" && result.designArtifact) {
        ctx.designArtifact = result.designArtifact;
      }

      // Extract decisions from analyze/design steps
      if ((step.type === "analyze" || step.type === "design") && result.status === "completed") {
        const decisionSource = result.rawOutput ?? result.summary;
        const decisionMatches = decisionSource.match(/(?:decision|chose|selected|will use|architecture):\s*([^\n]+)/gi);
        if (decisionMatches) {
          ctx.decisions.push(...decisionMatches);
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

      if (step.type === "analyze" && result.status !== "completed") {
        emit({ type: "agi.pipeline.fail", error: result.errors[0] || "AnalyzeArtifact generation failed" });
        success = false;
        break;
      }
      if (step.type === "debate" && result.status !== "completed") {
        emit({ type: "agi.pipeline.fail", error: result.errors[0] || "DebateArtifact generation failed" });
        success = false;
        break;
      }
      if (step.type === "design" && result.status !== "completed") {
        emit({ type: "agi.pipeline.fail", error: result.errors[0] || "DesignArtifact generation failed" });
        success = false;
        break;
      }
      if (step.type === "build" && result.status !== "completed") {
        emit({ type: "agi.pipeline.fail", error: result.errors[0] || "Build step failed" });
        success = false;
        break;
      }

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
  const pipelineSuccess = success && failedSteps === 0;

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
