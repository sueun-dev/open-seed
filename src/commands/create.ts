/**
 * `agent create` — One-Prompt-to-App CLI command.
 *
 * The ultimate developer experience:
 * 1. User enters a single prompt ("Todo 앱 만들어줘")
 * 2. AI analyzes requirements and asks intelligent questions
 * 3. User answers (or accepts defaults)
 * 4. AI builds a complete, tested, submission-ready app
 *
 * Orchestrates the entire pipeline:
 * - Prompt Discovery → Blueprint → Full-Stack Build → Quality Gate
 *
 * All 40 roles, 49 subsystems, OMO hooks, and 14 tools are activated.
 */

import * as readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";

import {
  discoverRequirements,
  formatDiscoveryForUser,
  applyAnswers,
  type DiscoveryResult,
  type UserAnswer
} from "../orchestration/prompt-discovery.js";
import {
  generateBlueprint,
  formatBlueprintSummary,
  type AppBlueprint
} from "../orchestration/blueprint.js";
import {
  orchestrateFullBuild,
  formatProgress,
  type OrchestratorConfig,
  type OrchestratorProgress
} from "../orchestration/full-stack-orchestrator.js";
import {
  runQualityGate,
  getFailedChecksAsPrompt
} from "../orchestration/quality-gate.js";

// ─── Interactive I/O ─────────────────────────────────────────────────────────

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ─── Terminal UI Helpers ─────────────────────────────────────────────────────

function printHeader(): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        🚀 Open Seed — One-Prompt-to-App Engine              ║");
  console.log("║                                                              ║");
  console.log("║  프롬프트 하나로 완전한 앱을 만듭니다.                          ║");
  console.log("║  40개 전문가 역할 × 49개 서브시스템 × 14개 도구 총동원           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

function printPhaseHeader(phase: string, order: number, total: number): void {
  const bar = "█".repeat(Math.round((order / total) * 30));
  const empty = "░".repeat(30 - bar.length);
  console.log("");
  console.log(`  ┌─ Phase ${order}/${total}: ${phase.toUpperCase()} [${bar}${empty}]`);
}

function printSuccess(message: string): void {
  console.log(`  ✅ ${message}`);
}

function printError(message: string): void {
  console.log(`  ❌ ${message}`);
}

function printInfo(message: string): void {
  console.log(`  ℹ️  ${message}`);
}

// ─── Main Create Command ─────────────────────────────────────────────────────

export async function runCreateCommand(prompt: string): Promise<void> {
  printHeader();
  const rl = createPromptInterface();

  try {
    // ── Step 1: Discover Requirements ──────────────────────────────────

    console.log("🔍 프롬프트를 분석하고 있습니다...\n");
    const discovery = discoverRequirements(prompt);

    // Show analysis results
    console.log(formatDiscoveryForUser(discovery));

    // ── Step 2: Interactive Q&A ────────────────────────────────────────

    const answers = await conductInteractiveQA(rl, discovery);

    // Apply answers to refine discovery
    const refinedDiscovery = applyAnswers(discovery, answers);

    // ── Step 3: Generate Blueprint ─────────────────────────────────────

    console.log("\n📐 앱 설계도를 생성하고 있습니다...\n");
    const blueprint = generateBlueprint(refinedDiscovery, answers);

    // Show blueprint summary
    console.log(formatBlueprintSummary(blueprint));

    // ── Step 4: Confirm and Build ──────────────────────────────────────

    const confirm = await ask(rl, "\n🚀 이 설계도로 빌드를 시작할까요? (Y/n/수정): ");
    if (confirm.toLowerCase() === "n" || confirm === "아니오") {
      console.log("\n빌드를 취소했습니다.");
      rl.close();
      return;
    }

    // Create project directory
    const projectDir = path.resolve(process.cwd(), blueprint.name);
    try {
      await fs.mkdir(projectDir, { recursive: true });
    } catch {
      // Directory might already exist
    }

    console.log(`\n📁 프로젝트 디렉토리: ${projectDir}`);
    console.log("🔨 빌드를 시작합니다...\n");

    // Close readline before build (build may use stdin)
    rl.close();

    // ── Step 5: Orchestrate Full Build ─────────────────────────────────

    const config: OrchestratorConfig = {
      projectDir,
      cwd: process.cwd(),
      maxPhaseRetries: 3,
      maxTotalRounds: 50,
      interactive: true,

      async onPhaseStart(phase) {
        printPhaseHeader(
          phase.phase,
          phase.order,
          blueprint.phases.length
        );
        printInfo(`${phase.description}`);
        printInfo(`Tasks: ${phase.tasks.length} | Files: ${phase.files.length} | Roles: ${phase.roles.join(", ")}`);
      },

      async onPhaseComplete(phase, success) {
        if (success) {
          printSuccess(`Phase ${phase.phase} 완료`);
        } else {
          printError(`Phase ${phase.phase} 실패 — 재시도 중...`);
        }
      },

      async onProgress(progress) {
        if (process.stderr.isTTY) {
          process.stderr.write(`\r\x1b[K  ${formatProgress(progress)}`);
        }
      },

      async onNeedInput(question, context) {
        const inputRl = createPromptInterface();
        console.log(`\n⚠️  ${question}`);
        console.log(`   ${context}`);
        const answer = await ask(inputRl, "   → 답변 (skip으로 건너뛰기): ");
        inputRl.close();
        return answer;
      },
    };

    const result = await orchestrateFullBuild(blueprint, config);

    // ── Step 6: Quality Gate ───────────────────────────────────────────

    console.log("\n\n🔒 최종 품질 검사를 실행합니다...\n");
    const qualityResult = await runQualityGate(projectDir, blueprint);
    console.log(qualityResult.summary);

    // ── Step 7: Fix Loop (if quality gate fails) ───────────────────────

    if (!qualityResult.passed && qualityResult.blockers.length > 0) {
      console.log("\n🔧 품질 검사 실패 항목을 자동으로 수정합니다...\n");
      const fixPrompt = getFailedChecksAsPrompt(qualityResult);

      // Run one more engine pass to fix quality issues
      const { runEngine } = await import("../orchestration/engine.js");
      await runEngine({
        cwd: projectDir,
        task: fixPrompt,
        mode: "run",
      });

      // Re-run quality gate
      console.log("\n🔒 품질 검사를 다시 실행합니다...\n");
      const retryResult = await runQualityGate(projectDir, blueprint);
      console.log(retryResult.summary);
    }

    // ── Step 8: Final Report ───────────────────────────────────────────

    console.log("\n" + result.summary);

    if (result.success) {
      console.log("\n" + "═".repeat(60));
      console.log("🎉 앱이 완성되었습니다!");
      console.log("");
      console.log("  시작하려면:");
      console.log(`    cd ${blueprint.name}`);
      console.log("    npm install");
      console.log("    npm run dev");
      console.log("");
      console.log("═".repeat(60));
    }

  } catch (error) {
    printError(`빌드 실패: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    // Ensure readline is closed
    try { rl.close(); } catch { /* already closed */ }
  }
}

// ─── Interactive Q&A Session ─────────────────────────────────────────────────

async function conductInteractiveQA(
  rl: readline.Interface,
  discovery: DiscoveryResult
): Promise<UserAnswer[]> {
  const answers: UserAnswer[] = [];
  const criticalQuestions = discovery.questions.filter(q => q.priority === "critical");
  const recommendedQuestions = discovery.questions.filter(q => q.priority === "recommended");
  const optionalQuestions = discovery.questions.filter(q => q.priority === "optional");

  // Always ask critical questions
  if (criticalQuestions.length > 0) {
    console.log("\n── 필수 확인 사항 ──────────────────────────────────────────\n");
    for (const question of criticalQuestions) {
      const answer = await askQuestion(rl, question);
      answers.push(answer);
    }
  }

  // Ask if user wants to answer recommended questions
  if (recommendedQuestions.length > 0) {
    const wantRecommended = await ask(
      rl,
      `\n추천 사항 ${recommendedQuestions.length}개를 확인하시겠어요? (Y/n, 기본값 사용): `
    );

    if (wantRecommended.toLowerCase() !== "n" && wantRecommended !== "아니오") {
      console.log("");
      for (const question of recommendedQuestions) {
        const answer = await askQuestion(rl, question);
        answers.push(answer);
      }
    } else {
      // Use suggestions as defaults
      for (const question of recommendedQuestions) {
        answers.push({
          questionId: question.id,
          answer: question.suggestion ?? "",
          skipped: true,
        });
      }
    }
  }

  // Optional questions — always use defaults unless user wants to customize
  if (optionalQuestions.length > 0) {
    const wantOptional = await ask(
      rl,
      `\n선택 사항 ${optionalQuestions.length}개를 커스터마이즈 하시겠어요? (y/N): `
    );

    if (wantOptional.toLowerCase() === "y" || wantOptional === "예") {
      console.log("");
      for (const question of optionalQuestions) {
        const answer = await askQuestion(rl, question);
        answers.push(answer);
      }
    } else {
      for (const question of optionalQuestions) {
        answers.push({
          questionId: question.id,
          answer: question.suggestion ?? "",
          skipped: true,
        });
      }
    }
  }

  return answers;
}

async function askQuestion(
  rl: readline.Interface,
  question: { id: string; question: string; options?: string[]; suggestion?: string }
): Promise<UserAnswer> {
  let prompt = `  ❓ ${question.question}\n`;
  if (question.options) {
    question.options.forEach((opt, i) => {
      prompt += `     ${i + 1}) ${opt}\n`;
    });
  }
  if (question.suggestion) {
    prompt += `     💡 추천: ${question.suggestion}\n`;
  }
  prompt += "     → 답변 (Enter로 추천값 사용): ";

  const answer = await ask(rl, prompt);

  // If user selected a number from options
  if (question.options && /^\d+$/.test(answer)) {
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < question.options.length) {
      return { questionId: question.id, answer: question.options[idx] };
    }
  }

  // Empty answer = use suggestion
  if (answer === "" && question.suggestion) {
    return { questionId: question.id, answer: question.suggestion, skipped: true };
  }

  return { questionId: question.id, answer };
}
