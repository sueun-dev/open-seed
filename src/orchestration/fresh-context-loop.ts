/**
 * Fresh Context Loop — iterative development with clean context per iteration.
 * From Goose's Ralph Loop pattern.
 *
 * Problem: after 50+ edits, LLM drowns in history.
 * Solution: each iteration starts FRESH, reads accumulated feedback files.
 *
 * Flow:
 * 1. Iteration 1: Execute task → write results to .agent/iterations/001.json
 * 2. Review results → write feedback to .agent/iterations/001.feedback.json
 * 3. Iteration 2: Fresh context + read feedback file → execute fixes
 * 4. Repeat until review passes or max iterations
 *
 * Each iteration gets: original task + all feedback files + current file state.
 * NOT: the entire conversation history.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, nowIso } from "../core/utils.js";

export interface IterationResult {
  iteration: number;
  summary: string;
  changedFiles: string[];
  toolCallCount: number;
  reviewVerdict: "pass" | "fail";
  reviewFeedback: string[];
  timestamp: string;
}

export interface FreshLoopState {
  taskDescription: string;
  iterations: IterationResult[];
  maxIterations: number;
  currentIteration: number;
  completed: boolean;
}

export function createFreshLoop(task: string, maxIterations = 5): FreshLoopState {
  return {
    taskDescription: task,
    iterations: [],
    maxIterations,
    currentIteration: 0,
    completed: false
  };
}

export function recordIteration(state: FreshLoopState, result: IterationResult): FreshLoopState {
  return {
    ...state,
    iterations: [...state.iterations, result],
    currentIteration: state.currentIteration + 1,
    completed: result.reviewVerdict === "pass" || state.currentIteration + 1 >= state.maxIterations
  };
}

/**
 * Build a FRESH prompt for the next iteration.
 * Instead of carrying entire history, summarize previous iterations as feedback.
 */
export function buildFreshIterationPrompt(state: FreshLoopState): string {
  const lines: string[] = [
    `Task: ${state.taskDescription}`,
    "",
    `Iteration: ${state.currentIteration + 1}/${state.maxIterations}`,
    ""
  ];

  if (state.iterations.length > 0) {
    lines.push("## Previous Iterations (feedback only — context is fresh)");
    lines.push("");
    for (const iter of state.iterations) {
      lines.push(`### Iteration ${iter.iteration}`);
      lines.push(`Verdict: ${iter.reviewVerdict}`);
      lines.push(`Changed: ${iter.changedFiles.join(", ")}`);
      if (iter.reviewFeedback.length > 0) {
        lines.push("Feedback:");
        iter.reviewFeedback.forEach(f => lines.push(`  - ${f}`));
      }
      lines.push("");
    }
    lines.push("Fix ALL feedback issues above. Read the current file state first.");
  }

  return lines.join("\n");
}

/**
 * Save iteration state to disk for cross-session persistence.
 */
export async function saveIterationState(cwd: string, localDirName: string, state: FreshLoopState): Promise<void> {
  const dir = path.join(cwd, localDirName, "iterations");
  await ensureDir(dir);
  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

export async function loadIterationState(cwd: string, localDirName: string): Promise<FreshLoopState | null> {
  const fp = path.join(cwd, localDirName, "iterations", "state.json");
  if (!(await fileExists(fp))) return null;
  return JSON.parse(await fs.readFile(fp, "utf8")) as FreshLoopState;
}
