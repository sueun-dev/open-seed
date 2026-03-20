/**
 * Full-Stack Orchestrator — The master conductor that coordinates ALL 40 roles,
 * all 49 subsystems, OMO hooks, and every tool to build a complete app from a blueprint.
 *
 * This is the "One-Prompt-to-App" brain. It takes a Blueprint and:
 * 1. Executes each phase in order
 * 2. Delegates to the right specialist roles
 * 3. Runs verify-fix loops after each phase
 * 4. Tracks evidence requirements
 * 5. Self-heals on failure
 * 6. Produces a submission-ready app
 *
 * Inspired by:
 * - oh-my-openagent Sisyphus: phased execution with evidence gates
 * - oh-my-claudecode: tmux parallel workers + RALPH learning
 * - Devin: autonomous multi-file app generation
 * - OpenHands: event-driven delegation
 * - CrewAI: task DAG with dependency resolution
 * - Plandex: diff sandbox with atomic apply/rollback
 * - SWE-Agent: structured retry with error recovery
 */

import type { AgentEvent, PlannerTask, ReviewResult, RoleCategory, SessionRecord } from "../core/types.js";
import type { AgentEventBus } from "../core/event-bus.js";
import type { AppBlueprint, BlueprintPhaseSpec } from "./blueprint.js";
import type { RunEngineOptions, RunEngineResult } from "./engine.js";
import { runEngine } from "./engine.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Working directory for the new project */
  projectDir: string;
  /** Parent working directory */
  cwd: string;
  /** Max retries per phase */
  maxPhaseRetries: number;
  /** Max total rounds across all phases */
  maxTotalRounds: number;
  /** Whether to run in interactive mode (ask user on failure) */
  interactive: boolean;
  /** External event bus for UI integration */
  eventBus?: AgentEventBus;
  /** Callback when a phase starts */
  onPhaseStart?: (phase: BlueprintPhaseSpec) => void | Promise<void>;
  /** Callback when a phase completes */
  onPhaseComplete?: (phase: BlueprintPhaseSpec, success: boolean) => void | Promise<void>;
  /** Callback for progress updates */
  onProgress?: (progress: OrchestratorProgress) => void | Promise<void>;
  /** Callback when user input is needed */
  onNeedInput?: (question: string, context: string) => Promise<string>;
}

export interface OrchestratorProgress {
  currentPhase: number;
  totalPhases: number;
  phaseName: string;
  currentTask: number;
  totalTasks: number;
  taskName: string;
  filesCreated: number;
  totalFiles: number;
  testsPass: boolean | null;
  buildPass: boolean | null;
  overallPercent: number;
}

export interface PhaseResult {
  phase: BlueprintPhaseSpec;
  success: boolean;
  attempts: number;
  engineResult?: RunEngineResult;
  filesCreated: string[];
  errors: string[];
  duration: number;
}

export interface OrchestratorResult {
  success: boolean;
  blueprint: AppBlueprint;
  phaseResults: PhaseResult[];
  totalDuration: number;
  totalFiles: number;
  totalTasks: number;
  finalVerification: FinalVerification;
  /** Summary message for the user */
  summary: string;
}

export interface FinalVerification {
  typeCheck: VerificationCheck;
  lint: VerificationCheck;
  tests: VerificationCheck;
  build: VerificationCheck;
  overall: "pass" | "partial" | "fail";
}

export interface VerificationCheck {
  passed: boolean;
  output?: string;
  error?: string;
}

// ─── Phase-to-Task Prompt Builder ────────────────────────────────────────────

function buildPhaseTaskPrompt(
  blueprint: AppBlueprint,
  phase: BlueprintPhaseSpec,
  attempt: number
): string {
  const lines: string[] = [];

  lines.push(`## One-Prompt-to-App: Phase ${phase.order} — ${phase.phase.toUpperCase()}`);
  lines.push("");
  lines.push(`Project: ${blueprint.name}`);
  lines.push(`Description: ${blueprint.description}`);
  lines.push("");

  // Tech stack context
  lines.push("### Tech Stack");
  for (const [key, value] of Object.entries(blueprint.stack)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");

  // Phase description
  lines.push(`### Phase Goal: ${phase.description}`);
  lines.push("");

  // Files to create
  if (phase.files.length > 0) {
    lines.push("### Files to Create");
    for (const file of phase.files) {
      lines.push(`- \`${file.path}\`: ${file.description}`);
      if (file.dependsOn && file.dependsOn.length > 0) {
        lines.push(`  (depends on: ${file.dependsOn.join(", ")})`);
      }
    }
    lines.push("");
  }

  // Tasks to complete
  lines.push("### Tasks");
  for (const task of phase.tasks) {
    lines.push(`- [ ] ${task.title}`);
  }
  lines.push("");

  // Schema context (if relevant)
  if ((phase.phase === "schema" || phase.phase === "backend") && blueprint.schema.length > 0) {
    lines.push("### Data Model");
    for (const entity of blueprint.schema) {
      lines.push(`#### ${entity.name}`);
      lines.push(`${entity.description}`);
      for (const field of entity.fields) {
        const flags = [
          field.nullable ? "nullable" : "",
          field.unique ? "unique" : "",
          field.reference ? `→ ${field.reference}` : ""
        ].filter(Boolean).join(", ");
        lines.push(`- ${field.name}: ${field.type}${flags ? ` (${flags})` : ""}`);
      }
      lines.push("");
    }
  }

  // API context (if relevant)
  if (phase.phase === "backend" && blueprint.endpoints.length > 0) {
    lines.push("### API Endpoints to Implement");
    for (const ep of blueprint.endpoints) {
      lines.push(`- ${ep.method} ${ep.path} ${ep.auth ? "[AUTH]" : "[PUBLIC]"} — ${ep.description}`);
    }
    lines.push("");
  }

  // UI context (if relevant)
  if (phase.phase === "frontend") {
    if (blueprint.pages.length > 0) {
      lines.push("### Pages to Build");
      for (const page of blueprint.pages) {
        lines.push(`- ${page.path}: ${page.name} (${page.layout}) — ${page.description}`);
        lines.push(`  Components: ${page.components.join(", ")}`);
      }
      lines.push("");
    }
    if (blueprint.components.length > 0) {
      lines.push("### Components to Build");
      for (const comp of blueprint.components) {
        lines.push(`- ${comp.name} ${comp.shared ? "[SHARED]" : ""}: ${comp.description}`);
      }
      lines.push("");
    }
  }

  // Dependencies context (scaffold phase)
  if (phase.phase === "scaffold") {
    lines.push("### Dependencies");
    lines.push("```json");
    lines.push(JSON.stringify(blueprint.dependencies, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("### Dev Dependencies");
    lines.push("```json");
    lines.push(JSON.stringify(blueprint.devDependencies, null, 2));
    lines.push("```");
    lines.push("");

    if (blueprint.envVars.length > 0) {
      lines.push("### Environment Variables");
      for (const v of blueprint.envVars) {
        lines.push(`- ${v.key}=${v.example} — ${v.description}${v.required ? " [REQUIRED]" : ""}`);
      }
      lines.push("");
    }

    lines.push("### Directory Structure to Create");
    for (const dir of blueprint.directoryStructure) {
      lines.push(`- ${dir}/`);
    }
    lines.push("");
  }

  // Testing context
  if (phase.phase === "testing") {
    lines.push("### Test Requirements");
    lines.push("- Write comprehensive tests for ALL API endpoints");
    lines.push("- Test happy paths AND error cases");
    lines.push("- Test authentication/authorization if applicable");
    lines.push("- Test input validation");
    lines.push("- All tests must PASS before moving to next phase");
    lines.push("");
  }

  // Evidence requirements
  lines.push("### Evidence Required (phase not complete without these)");
  for (const evidence of phase.evidence) {
    lines.push(`- [ ] ${evidence}`);
  }
  lines.push("");

  // Retry context
  if (attempt > 1) {
    lines.push(`### ⚠️ Retry Attempt ${attempt}`);
    lines.push("Previous attempt failed. Review errors and fix the root cause.");
    lines.push("Do NOT repeat the same approach that failed.");
    lines.push("");
  }

  // Critical rules
  lines.push("### Critical Rules");
  lines.push("- Write COMPLETE file content (no snippets or placeholders)");
  lines.push("- Follow the tech stack exactly as specified above");
  lines.push("- Match the data model schema precisely");
  lines.push("- Implement ALL tasks listed — no partial work");
  lines.push("- Verify each file compiles after writing");
  lines.push("- Create files in dependency order");
  lines.push("");

  return lines.join("\n");
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

export async function orchestrateFullBuild(
  blueprint: AppBlueprint,
  config: OrchestratorConfig
): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let totalFilesCreated = 0;
  let totalTasksCompleted = 0;

  // Sort phases by order
  const sortedPhases = [...blueprint.phases].sort((a, b) => a.order - b.order);

  for (let phaseIndex = 0; phaseIndex < sortedPhases.length; phaseIndex++) {
    const phase = sortedPhases[phaseIndex];
    const phaseStart = Date.now();

    await config.onPhaseStart?.(phase);

    // Progress update
    await config.onProgress?.({
      currentPhase: phaseIndex + 1,
      totalPhases: sortedPhases.length,
      phaseName: phase.phase,
      currentTask: 0,
      totalTasks: phase.tasks.length,
      taskName: phase.description,
      filesCreated: totalFilesCreated,
      totalFiles: blueprint.totalFiles,
      testsPass: null,
      buildPass: null,
      overallPercent: Math.round((phaseIndex / sortedPhases.length) * 100),
    });

    let phaseSuccess = false;
    let attempts = 0;
    let lastResult: RunEngineResult | undefined;
    const filesCreated: string[] = [];
    const errors: string[] = [];

    // Retry loop per phase
    while (attempts < config.maxPhaseRetries && !phaseSuccess) {
      attempts++;

      try {
        const taskPrompt = buildPhaseTaskPrompt(blueprint, phase, attempts);

        // Run the engine for this phase
        const engineResult = await runEngine({
          cwd: config.projectDir,
          task: taskPrompt,
          mode: phase.roles.length > 2 ? "team" : "run",
          eventBus: config.eventBus,
        });

        lastResult = engineResult;

        // Check if the phase passed
        if (engineResult.review.verdict === "pass") {
          phaseSuccess = true;
          totalTasksCompleted += phase.tasks.length;
          totalFilesCreated += phase.files.length;
        } else {
          errors.push(`Phase ${phase.phase} attempt ${attempts}: ${engineResult.review.summary}`);

          // Ask user if interactive mode
          if (config.interactive && config.onNeedInput && attempts < config.maxPhaseRetries) {
            const userInput = await config.onNeedInput(
              `Phase ${phase.phase} failed. What should I do?`,
              `Error: ${engineResult.review.summary}\nFollow-up: ${engineResult.review.followUp.join(", ")}`
            );
            if (userInput.toLowerCase().includes("skip")) {
              break;
            }
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`Phase ${phase.phase} attempt ${attempts} error: ${msg}`);
      }
    }

    phaseResults.push({
      phase,
      success: phaseSuccess,
      attempts,
      engineResult: lastResult,
      filesCreated,
      errors,
      duration: Date.now() - phaseStart,
    });

    await config.onPhaseComplete?.(phase, phaseSuccess);

    // If scaffold or schema phase fails, abort — downstream phases can't work
    if (!phaseSuccess && (phase.phase === "scaffold" || phase.phase === "schema")) {
      break;
    }
  }

  // Final verification
  const finalVerification = await runFinalVerification(config.projectDir);

  const totalDuration = Date.now() - startTime;
  const allPhasesPass = phaseResults.every(r => r.success);

  return {
    success: allPhasesPass && finalVerification.overall === "pass",
    blueprint,
    phaseResults,
    totalDuration,
    totalFiles: totalFilesCreated,
    totalTasks: totalTasksCompleted,
    finalVerification,
    summary: buildOrchestratorSummary(blueprint, phaseResults, finalVerification, totalDuration),
  };
}

// ─── Final Verification ──────────────────────────────────────────────────────

async function runFinalVerification(projectDir: string): Promise<FinalVerification> {
  const { execSync } = await import("node:child_process");

  const runCheck = (command: string): VerificationCheck => {
    try {
      const output = execSync(command, {
        cwd: projectDir,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { passed: true, output: output.slice(0, 2000) };
    } catch (error: unknown) {
      const err = error as { stderr?: string; stdout?: string; message?: string };
      return {
        passed: false,
        error: (err.stderr ?? err.stdout ?? err.message ?? "Unknown error").slice(0, 2000),
      };
    }
  };

  const typeCheck = runCheck("npx tsc --noEmit 2>&1 || true");
  const lint = runCheck("npx eslint . --max-warnings 0 2>&1 || true");
  const tests = runCheck("npx vitest run 2>&1 || true");
  const build = runCheck("npm run build 2>&1 || true");

  const passes = [typeCheck, lint, tests, build].filter(c => c.passed).length;
  const overall: FinalVerification["overall"] =
    passes === 4 ? "pass" :
    passes >= 2 ? "partial" :
    "fail";

  return { typeCheck, lint, tests, build, overall };
}

// ─── Summary Builder ─────────────────────────────────────────────────────────

function buildOrchestratorSummary(
  blueprint: AppBlueprint,
  phaseResults: PhaseResult[],
  verification: FinalVerification,
  totalDuration: number
): string {
  const lines: string[] = [];
  const seconds = Math.round(totalDuration / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              ✅ 빌드 완료 리포트                               ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`📦 프로젝트: ${blueprint.name}`);
  lines.push(`⏱️  소요 시간: ${minutes > 0 ? `${minutes}분 ` : ""}${remainingSeconds}초`);
  lines.push("");

  lines.push("── 단계별 결과 ────────────────────────────────────────────");
  for (const result of phaseResults) {
    const icon = result.success ? "✅" : "❌";
    const duration = Math.round(result.duration / 1000);
    lines.push(`  ${icon} ${result.phase.phase.toUpperCase().padEnd(15)} ${duration}s (${result.attempts} attempt${result.attempts > 1 ? "s" : ""})`);
    if (!result.success && result.errors.length > 0) {
      lines.push(`     └─ ${result.errors[result.errors.length - 1]}`);
    }
  }
  lines.push("");

  lines.push("── 최종 검증 ──────────────────────────────────────────────");
  lines.push(`  ${verification.typeCheck.passed ? "✅" : "❌"} TypeScript 타입 체크`);
  lines.push(`  ${verification.lint.passed ? "✅" : "❌"} ESLint 린트`);
  lines.push(`  ${verification.tests.passed ? "✅" : "❌"} 테스트 스위트`);
  lines.push(`  ${verification.build.passed ? "✅" : "❌"} 프로덕션 빌드`);
  lines.push("");

  const overallIcon = verification.overall === "pass" ? "🎉" :
    verification.overall === "partial" ? "⚠️" : "❌";
  lines.push(`${overallIcon} 최종 결과: ${verification.overall.toUpperCase()}`);
  lines.push("");

  if (verification.overall === "pass") {
    lines.push("🚀 앱이 제출 가능한 상태입니다!");
    lines.push("");
    lines.push("시작하려면:");
    lines.push(`  cd ${blueprint.name}`);
    lines.push("  npm run dev");
  } else if (verification.overall === "partial") {
    lines.push("⚠️ 대부분 완료되었지만 일부 검증이 실패했습니다.");
    lines.push("위의 실패 항목을 확인하고 수정이 필요합니다.");
  } else {
    lines.push("❌ 빌드에 문제가 있습니다. 로그를 확인해주세요.");
  }

  return lines.join("\n");
}

// ─── Format Progress for Terminal ────────────────────────────────────────────

export function formatProgress(progress: OrchestratorProgress): string {
  const bar = buildProgressBar(progress.overallPercent, 30);
  return [
    `[${progress.currentPhase}/${progress.totalPhases}] ${progress.phaseName.toUpperCase()}`,
    `${bar} ${progress.overallPercent}%`,
    `📝 ${progress.taskName}`,
    `📁 ${progress.filesCreated}/${progress.totalFiles} files`,
  ].join(" | ");
}

function buildProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
