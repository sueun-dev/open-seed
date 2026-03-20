/**
 * OMO Slash Commands — all missing commands from oh-my-openagent.
 *
 * Commands:
 * - /ralph-loop — run until ALL tasks complete
 * - /start-work — Prometheus planning → Atlas execution
 * - /refactor — intelligent refactoring with safety
 * - /handoff — context handoff to new session
 * - /stop-continuation — stop all continuation loops
 * - /cancel-ralph — cancel Ralph loop
 */

import { runEngine } from "../orchestration/engine.js";
import type { RunEngineResult } from "../orchestration/engine.js";

// ─── /ralph-loop ─────────────────────────────────────────────────────────────
// Runs the task in a loop until ALL subtasks are complete.

export async function runRalphLoopCommand(task: string): Promise<void> {
  const cwd = process.cwd();
  let iteration = 0;
  const maxIterations = 10;
  let lastResult: RunEngineResult | undefined;

  console.log(`\n🔄 Ralph Loop — running until task is 100% complete (max ${maxIterations} iterations)\n`);
  console.log(`   Task: ${task}\n`);

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n── Iteration ${iteration}/${maxIterations} ──────────────────────────────────\n`);

    const iterationTask = iteration === 1
      ? task
      : `Continue the task: ${task}\n\nPrevious iteration result: ${lastResult?.review.summary ?? "N/A"}\nPrevious verdict: ${lastResult?.review.verdict ?? "N/A"}\nFollow-up items: ${lastResult?.review.followUp?.join(", ") ?? "none"}\n\nComplete ALL remaining work. Do not repeat already-completed work.`;

    try {
      lastResult = await runEngine({ cwd, task: iterationTask, mode: "run" });

      if (lastResult.review.verdict === "pass") {
        console.log(`\n✅ Ralph Loop completed in ${iteration} iteration(s)!`);
        console.log(`   Review: ${lastResult.review.summary}`);
        return;
      }

      console.log(`   Verdict: ${lastResult.review.verdict} — continuing...`);
      console.log(`   Follow-up: ${lastResult.review.followUp.join(", ")}`);
    } catch (error) {
      console.log(`   ❌ Error in iteration ${iteration}: ${error instanceof Error ? error.message : String(error)}`);
      // Continue to next iteration on error
    }
  }

  console.log(`\n⚠️ Ralph Loop reached max iterations (${maxIterations}). Task may not be fully complete.`);
}

// ─── /start-work ─────────────────────────────────────────────────────────────
// Prometheus planning phase → Atlas execution. Interview mode first.

export async function runStartWorkCommand(task: string): Promise<void> {
  const cwd = process.cwd();

  console.log("\n🏗️ Start Work — Planning → Execution pipeline\n");

  // Phase 1: Planning (Prometheus)
  console.log("── Phase 1: Planning ────────────────────────────────────────\n");
  const planResult = await runEngine({
    cwd,
    task: `PLANNING ONLY — Do NOT write code yet.\n\nAnalyze this task and create a detailed execution plan:\n${task}\n\nReturn:\n1. Task breakdown with subtasks\n2. File changes needed\n3. Risks and dependencies\n4. Testing strategy\n5. Estimated complexity`,
    mode: "run"
  });

  console.log(`   Plan: ${planResult.review.summary}\n`);

  // Phase 2: Execution (Atlas)
  console.log("── Phase 2: Execution ──────────────────────────────────────\n");
  const execResult = await runEngine({
    cwd,
    task: `Execute this plan:\n${planResult.review.summary}\n\nOriginal task: ${task}\n\nImplement ALL changes. Run tests. Verify everything works.`,
    mode: "team"
  });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`   Status: ${execResult.session.status}`);
  console.log(`   Review: ${execResult.review.summary}`);
  console.log(`${"═".repeat(60)}`);
}

// ─── /refactor ───────────────────────────────────────────────────────────────
// Intelligent refactoring with safety (read → plan → refactor → verify)

export async function runRefactorCommand(target: string): Promise<void> {
  const cwd = process.cwd();

  console.log(`\n🔧 Refactor — safe refactoring with verification\n`);
  console.log(`   Target: ${target}\n`);

  const result = await runEngine({
    cwd,
    task: [
      `Refactor: ${target}`,
      "",
      "RULES for refactoring:",
      "1. Read ALL affected files FIRST",
      "2. Run existing tests to establish baseline",
      "3. Make changes incrementally (one logical change at a time)",
      "4. Preserve ALL existing behavior — no functional changes",
      "5. Run tests after EACH change",
      "6. If any test fails → REVERT immediately",
      "7. Do NOT change public APIs without explicit instruction",
      "8. Do NOT add new dependencies",
      "9. Keep commit-sized changes (easy to review)",
      "10. Document what was changed and why"
    ].join("\n"),
    mode: "run"
  });

  console.log(`\n   Status: ${result.session.status}`);
  console.log(`   Review: ${result.review.summary}`);
}

// ─── /handoff ────────────────────────────────────────────────────────────────
// Generate a context handoff document for session transfer.

export async function runHandoffCommand(): Promise<void> {
  const cwd = process.cwd();
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  console.log("\n📋 Handoff — generating session context document\n");

  // Gather context
  const { execSync } = await import("node:child_process");

  let gitStatus = "";
  let gitLog = "";
  let gitDiff = "";
  try {
    gitStatus = execSync("git status --short", { cwd, encoding: "utf-8" });
    gitLog = execSync("git log --oneline -10", { cwd, encoding: "utf-8" });
    gitDiff = execSync("git diff --stat", { cwd, encoding: "utf-8" });
  } catch { /* not a git repo */ }

  // Check for recent sessions
  let recentSessions = "";
  try {
    const sessionsDir = path.join(cwd, ".agent", "sessions");
    const files = await fs.readdir(sessionsDir);
    const recent = files.filter(f => f.endsWith(".json")).slice(-3);
    for (const f of recent) {
      const data = JSON.parse(await fs.readFile(path.join(sessionsDir, f), "utf-8"));
      recentSessions += `- ${data.task?.slice(0, 80)} (${data.status})\n`;
    }
  } catch { /* no sessions */ }

  const handoff = [
    `# Session Handoff — ${new Date().toISOString()}`,
    ``,
    `## Working Directory`,
    `\`${cwd}\``,
    ``,
    `## Git Status`,
    "```",
    gitStatus || "(no changes)",
    "```",
    ``,
    `## Recent Commits`,
    "```",
    gitLog || "(no commits)",
    "```",
    ``,
    `## Uncommitted Changes`,
    "```",
    gitDiff || "(none)",
    "```",
    ``,
    `## Recent Sessions`,
    recentSessions || "(none)",
    ``,
    `## Notes for Next Session`,
    `- Review uncommitted changes before continuing`,
    `- Run tests to verify current state`,
    `- Check for any TODO items in recent session output`,
  ].join("\n");

  const handoffPath = path.join(cwd, ".agent", "HANDOFF.md");
  await fs.mkdir(path.dirname(handoffPath), { recursive: true });
  await fs.writeFile(handoffPath, handoff, "utf-8");

  console.log(handoff);
  console.log(`\n📄 Saved to: ${handoffPath}`);
}

// ─── /stop-continuation ──────────────────────────────────────────────────────

export async function runStopContinuationCommand(): Promise<void> {
  // Write a signal file that the engine checks
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const signalPath = path.join(process.cwd(), ".agent", ".stop-signal");
  await fs.mkdir(path.dirname(signalPath), { recursive: true });
  await fs.writeFile(signalPath, new Date().toISOString(), "utf-8");
  console.log("🛑 Stop signal sent. Engine will halt at next checkpoint.");
}

// ─── /cancel-ralph ───────────────────────────────────────────────────────────

export async function runCancelRalphCommand(): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const ralphPath = path.join(process.cwd(), ".agent", "ralph-state.json");
  try {
    const raw = await fs.readFile(ralphPath, "utf-8");
    const state = JSON.parse(raw);
    state.phase = "complete";
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(ralphPath, JSON.stringify(state, null, 2), "utf-8");
    console.log("🛑 Ralph loop cancelled.");
  } catch {
    console.log("No active Ralph loop found.");
  }
}
