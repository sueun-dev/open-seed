#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline";
import { analyzeProject } from "./analyzer.js";
import { generateHarness, getDefaultAnswers } from "./generator.js";
import {
  generateOrchestratorConfig,
  generateOrchestratorPrompt,
  writeHarnessToDisk,
} from "./orchestrator.js";
import type { CurationItem } from "./types.js";

const program = new Command();

program
  .name("harness")
  .description("Harness Engineering Bootstrap CLI")
  .version("1.0.0");

// ── harness init (Phase 1: 완전 자동, 버튼 한번) ───────────

program
  .command("init")
  .description("프로젝트를 분석하고 harness scaffold를 자동 생성 (Phase 1 — 사람 입력 없이)")
  .argument("[dir]", "프로젝트 루트 디렉토리", ".")
  .option("--dry-run", "파일을 쓰지 않고 미리보기만")
  .action(async (dir: string, opts: { dryRun?: boolean }) => {
    console.log(chalk.bold.cyan("\n🔧 Harness Bootstrap — Phase 1: Auto Scaffold\n"));

    // Step 1: Analyze
    console.log(chalk.yellow("▸ Analyzing project..."));
    const analysis = analyzeProject(dir);
    printAnalysis(analysis);

    // Step 2: Generate with defaults
    console.log(chalk.yellow("\n▸ Generating harness scaffold with defaults..."));
    const defaults = getDefaultAnswers();
    const output = generateHarness(analysis, defaults);

    // Step 3: Generate orchestrator
    const orchConfig = generateOrchestratorConfig(analysis, output);
    const orchPrompt = generateOrchestratorPrompt(analysis, orchConfig);

    if (opts.dryRun) {
      console.log(chalk.gray("\n── AGENTS.md Preview ──────────────────\n"));
      console.log(output.agentsMd);
      console.log(chalk.gray("\n── Orchestrator Prompt Preview ────────\n"));
      console.log(orchPrompt.slice(0, 500) + "...");
      console.log(chalk.yellow("\n(dry-run: no files written)"));
    } else {
      // Step 4: Write to disk
      console.log(chalk.yellow("\n▸ Writing harness files..."));
      const written = writeHarnessToDisk(dir, output, orchPrompt);

      console.log(chalk.green("\n✓ Harness scaffold created:"));
      for (const f of written) {
        console.log(chalk.gray(`  ├── ${f}`));
      }

      // Step 5: Show curation needs
      if (analysis.curationNeeded.length > 0) {
        console.log(chalk.yellow(`\n⚠ ${analysis.curationNeeded.length}개 항목이 human curation 필요:`));
        for (const item of analysis.curationNeeded) {
          const marker = item.required ? chalk.red("*") : chalk.gray("○");
          console.log(`  ${marker} ${item.question.split("\n")[0]}`);
        }
        console.log(chalk.cyan(`\n→ 'harness curate ${dir}' 를 실행해서 채워넣으세요.`));
      }
    }

    console.log("");
  });

// ── harness curate (Phase 2: 인터랙티브 curation) ───────────

program
  .command("curate")
  .description("Human curation: AI가 못 판단하는 항목을 인터랙티브로 채움 (Phase 2)")
  .argument("[dir]", "프로젝트 루트 디렉토리", ".")
  .action(async (dir: string) => {
    console.log(chalk.bold.cyan("\n🎯 Harness Bootstrap — Phase 2: Human Curation\n"));

    const analysis = analyzeProject(dir);
    const answers = new Map<string, string>();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    for (const item of analysis.curationNeeded) {
      console.log(chalk.bold(`\n[${item.category.toUpperCase()}] ${item.question}`));

      if (item.suggestions.length > 0) {
        console.log(chalk.gray("  추천 옵션:"));
        item.suggestions.forEach((s, i) => {
          console.log(chalk.gray(`    ${i + 1}. ${s}`));
        });
      }

      const answer = await ask(
        chalk.cyan("  → 번호 선택 또는 직접 입력 (Enter=기본값): ")
      );

      if (answer === "" || answer === undefined) {
        answers.set(item.id, item.suggestions[0] ?? "");
      } else {
        const num = parseInt(answer, 10);
        if (!isNaN(num) && num >= 1 && num <= item.suggestions.length) {
          answers.set(item.id, item.suggestions[num - 1]);
        } else {
          answers.set(item.id, answer);
        }
      }

      console.log(chalk.green(`  ✓ ${answers.get(item.id)}`));
    }

    rl.close();

    // Re-generate with answers
    console.log(chalk.yellow("\n▸ Regenerating harness with your answers..."));
    const output = generateHarness(analysis, answers);
    const orchConfig = generateOrchestratorConfig(analysis, output);
    const orchPrompt = generateOrchestratorPrompt(analysis, orchConfig);

    const written = writeHarnessToDisk(dir, output, orchPrompt);
    console.log(chalk.green("\n✓ Harness updated:"));
    for (const f of written) {
      console.log(chalk.gray(`  ├── ${f}`));
    }

    console.log(
      chalk.cyan("\n→ Phase 3: 별도 AI에게 docs/orchestrator-prompt.md 를 시스템 프롬프트로 넘기세요.")
    );
    console.log("");
  });

// ── harness analyze (분석만) ────────────────────────────────

program
  .command("analyze")
  .description("프로젝트를 분석하고 결과만 출력 (파일 생성 없음)")
  .argument("[dir]", "프로젝트 루트 디렉토리", ".")
  .action((dir: string) => {
    console.log(chalk.bold.cyan("\n🔍 Harness Bootstrap — Project Analysis\n"));
    const analysis = analyzeProject(dir);
    printAnalysis(analysis);
    printCurationNeeds(analysis.curationNeeded);
    console.log("");
  });

// ── Helpers ─────────────────────────────────────────────────

function printAnalysis(analysis: ReturnType<typeof analyzeProject>) {
  const { techStack: s } = analysis;

  console.log(chalk.bold(`  Project: ${analysis.name}`));
  console.log(chalk.bold(`  Root:    ${analysis.root}`));
  console.log("");

  console.log(chalk.underline("  Tech Stack"));
  if (s.languages.length) console.log(`    Languages:   ${s.languages.join(", ")}`);
  if (s.frameworks.length) console.log(`    Frameworks:  ${s.frameworks.join(", ")}`);
  if (s.packageManager) console.log(`    Pkg Manager: ${s.packageManager}`);
  if (s.runtime) console.log(`    Runtime:     ${s.runtime}`);
  if (s.linter) console.log(`    Linter:      ${s.linter.name} (${s.linter.configFile})`);
  if (s.formatter) console.log(`    Formatter:   ${s.formatter}`);
  if (s.testRunner) console.log(`    Test Runner: ${s.testRunner}`);
  if (s.buildTool) console.log(`    Build Tool:  ${s.buildTool}`);
  if (s.database) console.log(`    Database:    ${s.database}`);
  if (s.orm) console.log(`    ORM:         ${s.orm}`);
  if (s.cicd) console.log(`    CI/CD:       ${s.cicd}`);

  console.log("");
  console.log(chalk.underline("  Detected Commands"));
  for (const [key, val] of Object.entries(analysis.commands)) {
    if (val) console.log(`    ${key.padEnd(12)} ${val}`);
  }

  if (analysis.monorepo) {
    console.log("");
    console.log(chalk.underline(`  Monorepo (${analysis.monorepo.tool})`));
    for (const pkg of analysis.monorepo.packages) {
      console.log(`    ${pkg.path.padEnd(24)} ${pkg.description}`);
    }
  }

  if (analysis.existingConfigs.length > 0) {
    console.log("");
    console.log(chalk.underline("  Existing Configs"));
    for (const cfg of analysis.existingConfigs) {
      console.log(`    ${cfg.path}`);
    }
  }
}

function printCurationNeeds(items: CurationItem[]) {
  if (items.length === 0) return;

  console.log("");
  console.log(chalk.underline("  Human Curation Needed"));
  for (const item of items) {
    const marker = item.required ? chalk.red("[필수]") : chalk.gray("[선택]");
    console.log(`    ${marker} ${item.question.split("\n")[0]}`);
  }
}

program.parse();
