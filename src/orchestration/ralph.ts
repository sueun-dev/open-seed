/**
 * RALPH Loop — Recursive Automated Loop for Persistent Handling.
 *
 * Inspired by oh-my-claudecode's Ralph system:
 * - Maintains state across sessions via PRD (Product Requirements Document)
 * - Tracks user stories with completion status
 * - Accumulates learned patterns across iterations
 * - Architect-driven verification decides if work is truly done
 * - Bounded iterations prevent infinite loops
 *
 * Flow: plan → create PRD → execute stories → verify → fix → mark complete
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, nowIso } from "../core/utils.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RalphPhase = "idle" | "planning" | "prd" | "executing" | "verifying" | "fixing" | "complete";

export interface UserStory {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  attempts: number;
  lastError?: string;
  completedAt?: string;
}

export interface PRD {
  title: string;
  objective: string;
  stories: UserStory[];
  createdAt: string;
  updatedAt: string;
}

export interface LearnedPattern {
  type: "build_command" | "test_command" | "setup_step" | "common_error" | "project_structure" | "shortcut";
  content: string;
  confidence: number;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

export interface RalphState {
  phase: RalphPhase;
  iteration: number;
  maxIterations: number;
  prd: PRD | null;
  currentStoryId: string | null;
  learnedPatterns: LearnedPattern[];
  failureHistory: string[];
  startedAt: string;
  updatedAt: string;
}

export interface RalphConfig {
  maxIterations?: number;
  prdPath?: string;
  progressPath?: string;
  learnPath?: string;
}

// ─── State Management ────────────────────────────────────────────────────────

export function createRalphState(config?: RalphConfig): RalphState {
  return {
    phase: "idle",
    iteration: 0,
    maxIterations: config?.maxIterations ?? 10,
    prd: null,
    currentStoryId: null,
    learnedPatterns: [],
    failureHistory: [],
    startedAt: nowIso(),
    updatedAt: nowIso()
  };
}

export function transitionRalph(state: RalphState, to: RalphPhase): RalphState {
  const validTransitions: Record<RalphPhase, RalphPhase[]> = {
    idle: ["planning"],
    planning: ["prd"],
    prd: ["executing"],
    executing: ["verifying"],
    verifying: ["fixing", "complete"],
    fixing: ["executing", "complete"],
    complete: ["idle"]
  };

  if (!validTransitions[state.phase]?.includes(to)) {
    throw new Error(`Invalid RALPH transition: ${state.phase} → ${to}`);
  }

  return {
    ...state,
    phase: to,
    iteration: to === "executing" ? state.iteration + 1 : state.iteration,
    updatedAt: nowIso()
  };
}

export function isRalphDone(state: RalphState): boolean {
  if (state.phase === "complete") return true;
  if (state.iteration >= state.maxIterations) return true;
  if (state.prd && state.prd.stories.every(s => s.status === "done")) return true;
  return false;
}

// ─── PRD Management ──────────────────────────────────────────────────────────

export function createPRD(title: string, objective: string, stories: Array<{ title: string; description: string }>): PRD {
  return {
    title,
    objective,
    stories: stories.map((s, i) => ({
      id: `story_${i + 1}`,
      title: s.title,
      description: s.description,
      status: "pending",
      attempts: 0
    })),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

export function getNextStory(prd: PRD): UserStory | null {
  return prd.stories.find(s => s.status === "pending" || s.status === "in_progress") ?? null;
}

export function markStoryDone(prd: PRD, storyId: string): PRD {
  return {
    ...prd,
    stories: prd.stories.map(s =>
      s.id === storyId ? { ...s, status: "done", completedAt: nowIso() } : s
    ),
    updatedAt: nowIso()
  };
}

export function markStoryFailed(prd: PRD, storyId: string, error: string): PRD {
  return {
    ...prd,
    stories: prd.stories.map(s =>
      s.id === storyId ? { ...s, status: "blocked", lastError: error, attempts: s.attempts + 1 } : s
    ),
    updatedAt: nowIso()
  };
}

export function markStoryInProgress(prd: PRD, storyId: string): PRD {
  return {
    ...prd,
    stories: prd.stories.map(s =>
      s.id === storyId ? { ...s, status: "in_progress", attempts: s.attempts + 1 } : s
    ),
    updatedAt: nowIso()
  };
}

export function getPRDProgress(prd: PRD): { done: number; total: number; blocked: number; percent: number } {
  const done = prd.stories.filter(s => s.status === "done").length;
  const blocked = prd.stories.filter(s => s.status === "blocked").length;
  return { done, total: prd.stories.length, blocked, percent: Math.round((done / prd.stories.length) * 100) };
}

// ─── Pattern Learning ────────────────────────────────────────────────────────

export function learnFromToolOutput(patterns: LearnedPattern[], toolName: string, output: string): LearnedPattern[] {
  const now = nowIso();
  const newPatterns = [...patterns];

  // Learn build commands
  if (toolName === "bash") {
    const buildMatch = output.match(/(?:npm|pnpm|yarn|bun)\s+run\s+(\w+)/);
    if (buildMatch) {
      upsertPattern(newPatterns, "build_command", `npm run ${buildMatch[1]}`, now);
    }
    const testMatch = output.match(/(?:npm|pnpm|yarn)\s+(?:run\s+)?test/);
    if (testMatch) {
      upsertPattern(newPatterns, "test_command", testMatch[0], now);
    }

    // Learn common errors
    const errorPatterns = [
      /Cannot find module '([^']+)'/,
      /Module not found: (.+)/,
      /error TS\d+: (.+)/,
      /SyntaxError: (.+)/,
      /ENOENT: (.+)/
    ];
    for (const ep of errorPatterns) {
      const match = output.match(ep);
      if (match) {
        upsertPattern(newPatterns, "common_error", match[0].slice(0, 200), now);
      }
    }
  }

  // Learn project structure
  if (toolName === "glob" || toolName === "repo_map") {
    if (output.includes("src/")) upsertPattern(newPatterns, "project_structure", "src/ directory exists", now);
    if (output.includes("tests/") || output.includes("__tests__/")) {
      upsertPattern(newPatterns, "project_structure", "tests directory exists", now);
    }
  }

  return newPatterns;
}

function upsertPattern(patterns: LearnedPattern[], type: LearnedPattern["type"], content: string, now: string): void {
  const key = `${type}:${content}`;
  const existing = patterns.find(p => `${p.type}:${p.content}` === key);
  if (existing) {
    existing.occurrences++;
    existing.lastSeen = now;
    existing.confidence = Math.min(1, existing.confidence + 0.1);
  } else {
    patterns.push({ type, content, confidence: 0.5, occurrences: 1, firstSeen: now, lastSeen: now });
  }
}

export function buildLearnedContext(patterns: LearnedPattern[]): string {
  if (patterns.length === 0) return "";

  const sorted = [...patterns].sort((a, b) => (b.confidence * b.occurrences) - (a.confidence * a.occurrences));
  const lines: string[] = ["# Learned Project Patterns"];

  const buildCmds = sorted.filter(p => p.type === "build_command");
  if (buildCmds.length > 0) lines.push(`Build: ${buildCmds.map(p => p.content).join(", ")}`);

  const testCmds = sorted.filter(p => p.type === "test_command");
  if (testCmds.length > 0) lines.push(`Test: ${testCmds.map(p => p.content).join(", ")}`);

  const errors = sorted.filter(p => p.type === "common_error").slice(0, 5);
  if (errors.length > 0) lines.push(`Common errors: ${errors.map(p => p.content).join("; ")}`);

  return lines.join("\n");
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function saveRalphState(cwd: string, localDirName: string, state: RalphState): Promise<void> {
  const dir = path.join(cwd, localDirName, "ralph");
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  if (state.prd) {
    await fs.writeFile(path.join(dir, "prd.json"), JSON.stringify(state.prd, null, 2), "utf8");
  }
  if (state.learnedPatterns.length > 0) {
    await fs.writeFile(path.join(dir, "patterns.json"), JSON.stringify(state.learnedPatterns, null, 2), "utf8");
  }
}

export async function loadRalphState(cwd: string, localDirName: string): Promise<RalphState | null> {
  const statePath = path.join(cwd, localDirName, "ralph", "state.json");
  if (!(await fileExists(statePath))) return null;
  return JSON.parse(await fs.readFile(statePath, "utf8")) as RalphState;
}

export async function loadLearnedPatterns(cwd: string, localDirName: string): Promise<LearnedPattern[]> {
  const patternsPath = path.join(cwd, localDirName, "ralph", "patterns.json");
  if (!(await fileExists(patternsPath))) return [];
  return JSON.parse(await fs.readFile(patternsPath, "utf8")) as LearnedPattern[];
}

// ─── Verification Prompts ────────────────────────────────────────────────────

export function buildVerifyPrompt(story: UserStory, executionSummary: string): string {
  return [
    "You are the Architect Verifier. Verify if this user story is truly complete.",
    "",
    `Story: ${story.title}`,
    `Description: ${story.description}`,
    "",
    "Execution summary:",
    executionSummary,
    "",
    "Check:",
    "1. Does the implementation match the story requirements?",
    "2. Were tests run and did they pass?",
    "3. Is the code clean and complete (no TODOs)?",
    "4. Were there any unresolved errors?",
    "",
    'Return JSON: {"verified": boolean, "issues": string[], "suggestions": string[]}'
  ].join("\n");
}

export function buildFixPrompt(story: UserStory, issues: string[]): string {
  return [
    `Fix the following issues for story: ${story.title}`,
    "",
    "Issues found by verifier:",
    ...issues.map((issue, i) => `${i + 1}. ${issue}`),
    "",
    "Fix these issues. Use tools to read, modify, and verify the code.",
    "After fixing, run relevant tests/build commands to verify."
  ].join("\n");
}

export function buildPRDPrompt(task: string, repoSummary: string): string {
  return [
    "Create a Product Requirements Document (PRD) for this task.",
    "",
    `Task: ${task}`,
    "",
    "Repository:",
    repoSummary.slice(0, 2000),
    "",
    "Break the task into specific user stories. Each story should be independently completable.",
    "",
    'Return JSON: {"title": string, "objective": string, "stories": [{"title": string, "description": string}]}'
  ].join("\n");
}
