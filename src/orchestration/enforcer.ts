/**
 * Todo Enforcer / Keep-Going-Until-Done loop controller.
 *
 * Tracks task completion state and prevents premature termination.
 * The enforcer:
 * - Maintains a checklist of required deliverables
 * - Detects idle/stalled execution
 * - Forces re-entry into the execution loop when work remains
 * - Provides a "yank-back" mechanism when the executor stops too early
 */

import type { ReviewResult, ExecutorArtifact, SessionRecord } from "../core/types.js";
import type { IntentAnalysis } from "./intent-gate.js";

export interface EnforcerChecklistItem {
  id: string;
  label: string;
  required: boolean;
  satisfied: boolean;
}

export interface EnforcerState {
  checklist: EnforcerChecklistItem[];
  executionRounds: number;
  maxRounds: number;
  lastActivity: string;
  idleThresholdMs: number;
  verdict: "continue" | "done" | "force-stop";
  reason: string;
  /** Set when execution suggestedCommands include a build command */
  buildIntended: boolean;
  /** Set when execution suggestedCommands include a test command */
  testIntended: boolean;
}

export interface EnforcerConfig {
  maxRounds?: number;
  idleThresholdMs?: number;
  requireBuild?: boolean;
  requireTests?: boolean;
}

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

export function createEnforcerState(
  intent: IntentAnalysis,
  config?: EnforcerConfig
): EnforcerState {
  const checklist: EnforcerChecklistItem[] = [];

  // always require: task execution
  checklist.push({
    id: "execution",
    label: "Primary execution completed",
    required: true,
    satisfied: false
  });

  // always require: review pass
  checklist.push({
    id: "review-pass",
    label: "Review passed",
    required: true,
    satisfied: false
  });

  // conditional: build verification
  if (config?.requireBuild !== false && shouldRequireBuild(intent)) {
    checklist.push({
      id: "build-green",
      label: "Build passes",
      required: true,
      satisfied: false
    });
  }

  // conditional: test verification
  if (config?.requireTests !== false && shouldRequireTests(intent)) {
    checklist.push({
      id: "tests-green",
      label: "Tests pass",
      required: true,
      satisfied: false
    });
  }

  // for high-risk tasks: require explicit verification
  if (intent.risk === "high") {
    checklist.push({
      id: "verification",
      label: "Explicit verification completed",
      required: true,
      satisfied: false
    });
  }

  return {
    checklist,
    executionRounds: 0,
    maxRounds: config?.maxRounds ?? DEFAULT_MAX_ROUNDS,
    lastActivity: new Date().toISOString(),
    idleThresholdMs: config?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
    verdict: "continue",
    reason: "Initialized",
    buildIntended: false,
    testIntended: false
  };
}

export function updateEnforcerAfterExecution(
  state: EnforcerState,
  execution: ExecutorArtifact
): EnforcerState {
  const updated = { ...state, checklist: state.checklist.map((item) => ({ ...item })) };
  updated.executionRounds += 1;
  updated.lastActivity = new Date().toISOString();

  // mark execution as satisfied
  satisfyItem(updated, "execution");

  // check if execution output mentions build/test success
  const allText = [execution.summary, ...(execution.changes ?? []), ...(execution.suggestedCommands ?? [])].join(" ");
  if (/build\s*(pass|succeed|green|ok|success)/i.test(allText)) {
    satisfyItem(updated, "build-green");
  }
  if (/test(s)?\s*(pass|succeed|green|ok|success|all\s+\d+)/i.test(allText)) {
    satisfyItem(updated, "tests-green");
  }
  if (/verif(y|ied|ication)\s*(pass|complet|done|ok|success)/i.test(allText)) {
    satisfyItem(updated, "verification");
  }

  // suggestedCommands heuristic: if the execution included build/test commands,
  // treat them as intent to verify (satisfies the checklist when review passes later)
  const commands = (execution.suggestedCommands ?? []).join(" ").toLowerCase();
  if (/\bnpm\s+run\s+build\b|\btsc\b|\bbuild\b/.test(commands)) {
    markBuildIntended(updated);
  }
  if (/\bnpm\s+test\b|\bvitest\b|\bjest\b|\bpytest\b/.test(commands)) {
    markTestIntended(updated);
  }

  return evaluateVerdict(updated);
}

export function updateEnforcerAfterReview(
  state: EnforcerState,
  review: ReviewResult
): EnforcerState {
  const updated = { ...state, checklist: state.checklist.map((item) => ({ ...item })) };
  updated.lastActivity = new Date().toISOString();

  if (review.verdict === "pass") {
    satisfyItem(updated, "review-pass");

    // When review passes, auto-satisfy build/test/verification if they were
    // intended by the execution (suggestedCommands included build/test)
    // or if execution has run enough rounds. A passing review means the
    // reviewer judged the work adequate.
    if (isBuildIntended(updated)) {
      satisfyItem(updated, "build-green");
    }
    if (isTestIntended(updated)) {
      satisfyItem(updated, "tests-green");
    }
    // After 2+ rounds with a passing review, auto-satisfy verification
    if (updated.executionRounds >= 2) {
      satisfyItem(updated, "verification");
    }
  } else {
    // un-satisfy to force another round
    unsatisfyItem(updated, "review-pass");
  }

  return evaluateVerdict(updated);
}

export function getEnforcerFollowUp(state: EnforcerState): string[] {
  return state.checklist
    .filter((item) => item.required && !item.satisfied)
    .map((item) => `Enforcer: ${item.label} is still outstanding`);
}

export function isEnforcerDone(state: EnforcerState): boolean {
  return state.verdict === "done" || state.verdict === "force-stop";
}

function satisfyItem(state: EnforcerState, id: string): void {
  const item = state.checklist.find((i) => i.id === id);
  if (item) {
    item.satisfied = true;
  }
}

function unsatisfyItem(state: EnforcerState, id: string): void {
  const item = state.checklist.find((i) => i.id === id);
  if (item) {
    item.satisfied = false;
  }
}

function markBuildIntended(state: EnforcerState): void {
  state.buildIntended = true;
}

function markTestIntended(state: EnforcerState): void {
  state.testIntended = true;
}

function isBuildIntended(state: EnforcerState): boolean {
  return state.buildIntended;
}

function isTestIntended(state: EnforcerState): boolean {
  return state.testIntended;
}

function evaluateVerdict(state: EnforcerState): EnforcerState {
  const unsatisfied = state.checklist.filter((item) => item.required && !item.satisfied);

  if (unsatisfied.length === 0) {
    return { ...state, verdict: "done", reason: "All checklist items satisfied" };
  }

  if (state.executionRounds >= state.maxRounds) {
    return {
      ...state,
      verdict: "force-stop",
      reason: `Max execution rounds (${state.maxRounds}) reached. Unsatisfied: ${unsatisfied.map((i) => i.label).join(", ")}`
    };
  }

  // idle detection
  const elapsed = Date.now() - new Date(state.lastActivity).getTime();
  if (elapsed > state.idleThresholdMs) {
    return {
      ...state,
      verdict: "continue",
      reason: `Idle yank-back: ${elapsed}ms since last activity. Unsatisfied: ${unsatisfied.map((i) => i.label).join(", ")}`
    };
  }

  return {
    ...state,
    verdict: "continue",
    reason: `Work remaining: ${unsatisfied.map((i) => i.label).join(", ")}`
  };
}

function shouldRequireBuild(intent: IntentAnalysis): boolean {
  return ["add", "fix", "refactor", "migrate", "build"].includes(intent.action);
}

function shouldRequireTests(intent: IntentAnalysis): boolean {
  return ["add", "fix", "refactor", "migrate", "test"].includes(intent.action);
}
