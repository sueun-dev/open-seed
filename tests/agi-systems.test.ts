/**
 * Tests for all AGI autonomy systems added from research repos.
 */

import { describe, it, expect } from "vitest";

import { createCircuitBreaker, canExecute, recordSuccess, recordFailure, getBackoffDelay } from "../src/orchestration/circuit-breaker.js";
import { generateStrategies, scoreAttempt, selectBestAttempt } from "../src/orchestration/strategy-branching.js";
import { calculateConfidence, estimateTaskClarity, estimateCodebaseFamiliarity } from "../src/orchestration/confidence-engine.js";
import { createDegradationState, updateDegradation, shouldSkipStep, getAlternativeTool, getDegradedPromptStrategy } from "../src/orchestration/graceful-degradation.js";
import { checkFilesForErrors, formatErrorsForPrompt } from "../src/orchestration/live-error-monitor.js";
import { needsInterview, generateInterviewQuestions } from "../src/orchestration/interview-mode.js";
import { needsDebate, selectDebateParticipants } from "../src/orchestration/debate-mode.js";
import { runPrChecks, formatPrAnalysis } from "../src/orchestration/pr-checks.js";
import { discoverRequirements, formatDiscoveryForUser } from "../src/orchestration/prompt-discovery.js";
import { generateBlueprint, formatBlueprintSummary } from "../src/orchestration/blueprint.js";
import { createSchedulerState, recordRateLimit, isRateLimited, getBestAvailableProvider } from "../src/orchestration/rate-limit-scheduler.js";
import { truncateToolOutput, detectEmptyResponse, guardExistingFileWrite, handleAnthropicContextLimit, recoverFromEditError, shouldRetryDelegation, enforceTodoContinuation, truncateLabel } from "../src/orchestration/omo-hooks-full.js";
import { getActiveSkills, buildSkillContext, getAllSkills } from "../src/orchestration/builtin-skills.js";
import { getEnabledMcps, listAllMcps } from "../src/mcp/builtin-mcps.js";
import { TaskStore } from "../src/tools/omo-tools.js";
import { analyzeIntent } from "../src/orchestration/intent-gate.js";

describe("Circuit Breaker", () => {
  it("starts closed and allows execution", () => {
    const cb = createCircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(canExecute(cb)).toBe(true);
  });

  it("opens after threshold failures", () => {
    const cb = createCircuitBreaker({ failureThreshold: 2 });
    recordFailure(cb);
    expect(cb.state).toBe("closed");
    recordFailure(cb);
    expect(cb.state).toBe("open");
    expect(canExecute(cb)).toBe(false);
  });

  it("transitions to half-open after reset timeout", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
    recordFailure(cb);
    expect(cb.state).toBe("open");
    expect(canExecute(cb)).toBe(true); // timeout=0, so immediately half-open
    expect(cb.state).toBe("half-open");
  });

  it("closes after successful half-open calls", () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0, halfOpenSuccessThreshold: 1 });
    recordFailure(cb);
    canExecute(cb); // triggers half-open
    recordSuccess(cb);
    expect(cb.state).toBe("closed");
  });

  it("calculates exponential backoff", () => {
    expect(getBackoffDelay(0, 1000, 60000, false)).toBe(1000);
    expect(getBackoffDelay(1, 1000, 60000, false)).toBe(2000);
    expect(getBackoffDelay(2, 1000, 60000, false)).toBe(4000);
    expect(getBackoffDelay(10, 1000, 60000, false)).toBe(60000); // capped
  });
});

describe("Strategy Branching", () => {
  it("generates strategies based on context", () => {
    const strategies = generateStrategies("build a todo app", { hasTests: true, isLargeCodebase: true, complexity: "complex" });
    expect(strategies.length).toBeGreaterThanOrEqual(3);
    expect(strategies.some(s => s.id === "direct")).toBe(true);
    expect(strategies.some(s => s.id === "tdd")).toBe(true);
    expect(strategies.some(s => s.id === "research-first")).toBe(true);
  });

  it("scores attempts correctly", () => {
    const pass = { strategyId: "a", success: true, output: "done", score: 0, verificationPassed: true, costTokens: 1000, durationMs: 5000, errors: [] };
    const fail = { strategyId: "b", success: false, output: "", score: 0, verificationPassed: false, costTokens: 0, durationMs: 1000, errors: ["error"] };
    expect(scoreAttempt(pass)).toBeGreaterThan(scoreAttempt(fail));
  });

  it("selects the best attempt", () => {
    const attempts = [
      { strategyId: "a", success: true, output: "good", score: 0, verificationPassed: true, costTokens: 1000, durationMs: 5000, errors: [] },
      { strategyId: "b", success: true, output: "ok", score: 0, verificationPassed: false, costTokens: 500, durationMs: 3000, errors: ["minor"] },
    ];
    const best = selectBestAttempt(attempts);
    expect(best?.strategyId).toBe("a");
  });
});

describe("Confidence Engine", () => {
  it("gives high confidence for clear simple tasks", () => {
    const score = calculateConfidence({
      taskClarity: 0.9, codebaseFamiliarity: 0.8, riskLevel: "low",
      hasTests: true, hasExistingPatterns: true, previousSuccessRate: 0.9,
      toolsAvailable: true, scopeSize: "single-file"
    });
    expect(score.value).toBeGreaterThan(0.7);
    expect(score.recommendation).toBe("execute");
  });

  it("gives low confidence for vague risky tasks", () => {
    const score = calculateConfidence({
      taskClarity: 0.2, codebaseFamiliarity: 0.1, riskLevel: "high",
      hasTests: false, hasExistingPatterns: false, previousSuccessRate: 0.2,
      toolsAvailable: true, scopeSize: "repo-wide"
    });
    expect(score.value).toBeLessThan(0.4);
    expect(["ask-human", "try-alternative"]).toContain(score.recommendation);
  });

  it("estimates task clarity from text", () => {
    expect(estimateTaskClarity("fix the bug in src/auth.ts function validateToken")).toBeGreaterThan(0.5);
    expect(estimateTaskClarity("improve things somehow")).toBeLessThan(0.5);
  });
});

describe("Graceful Degradation", () => {
  it("starts at full level", () => {
    const state = createDegradationState(100000);
    expect(state.level).toBe("full");
  });

  it("degrades on high token usage", () => {
    const state = createDegradationState(100000);
    const updated = updateDegradation(state, { tokenUsedPct: 90, elapsedMs: 1000 });
    expect(updated.level).toBe("emergency");
  });

  it("skips non-critical steps in degraded mode", () => {
    const state = createDegradationState(100000);
    state.level = "minimal";
    expect(shouldSkipStep(state, "documentation").skip).toBe(true);
    expect(shouldSkipStep(state, "execution").skip).toBe(false);
  });

  it("suggests alternative tools", () => {
    expect(getAlternativeTool("lsp_diagnostics")).toBe("bash");
    expect(getAlternativeTool("ast_grep")).toBe("grep");
    expect(getAlternativeTool("read")).toBeNull();
  });

  it("adjusts prompt strategy per level", () => {
    expect(getDegradedPromptStrategy("full").maxOutputTokens).toBe(8192);
    expect(getDegradedPromptStrategy("emergency").maxOutputTokens).toBe(1024);
  });
});

describe("OMO Hooks Full", () => {
  it("truncates long tool output", () => {
    const long = "x".repeat(10000);
    const result = truncateToolOutput(long);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(long.length);
  });

  it("detects empty responses", () => {
    expect(detectEmptyResponse("").isEmpty).toBe(true);
    expect(detectEmptyResponse("I'm sorry, I cannot").isEmpty).toBe(true);
    expect(detectEmptyResponse("Here is the implementation...").isEmpty).toBe(false);
  });

  it("guards file writes without prior read", () => {
    const read = new Set<string>();
    expect(guardExistingFileWrite("foo.ts", read).allowed).toBe(false);
    read.add("foo.ts");
    expect(guardExistingFileWrite("foo.ts", read).allowed).toBe(true);
  });

  it("handles Anthropic context limit errors", () => {
    expect(handleAnthropicContextLimit("context_length exceeded").shouldRetry).toBe(true);
    expect(handleAnthropicContextLimit("unknown error").shouldRetry).toBe(false);
  });

  it("recovers from edit errors", () => {
    const r = recoverFromEditError("old_string not found", "foo.ts");
    expect(r.strategy).toBe("re-read-and-retry");
  });

  it("decides delegation retry", () => {
    expect(shouldRetryDelegation("rate_limit", 1, 3).retry).toBe(true);
    expect(shouldRetryDelegation("unknown", 3, 3).retry).toBe(false);
  });

  it("enforces todo continuation", () => {
    const r = enforceTodoContinuation("task completed, all done!", ["fix the tests"]);
    expect(r.shouldYank).toBe(true);
  });

  it("truncates labels", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("x".repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});

describe("Rate Limit Scheduler", () => {
  it("records and checks rate limits", () => {
    const state = createSchedulerState();
    expect(isRateLimited(state, "openai").limited).toBe(false);
    recordRateLimit(state, "openai", 1000);
    expect(isRateLimited(state, "openai").limited).toBe(true);
  });

  it("finds best available provider", () => {
    const state = createSchedulerState();
    recordRateLimit(state, "openai", 60000);
    expect(getBestAvailableProvider(state, ["openai", "anthropic"])).toBe("anthropic");
  });
});

describe("Interview Mode", () => {
  it("detects when interview is needed", () => {
    // analyzeIntent imported at top level
    expect(needsInterview("migrate the entire database to PostgreSQL", analyzeIntent("migrate the entire database"))).toBe(true);
    expect(needsInterview("fix typo in readme", analyzeIntent("fix typo in readme"))).toBe(false);
  });

  it("generates relevant questions", () => {
    // analyzeIntent imported at top level
    const questions = generateInterviewQuestions("build a REST API with auth", analyzeIntent("build a REST API"), { hasTests: true, hasCi: false, languages: ["typescript"], frameworks: ["express"] });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.some(q => q.category === "scope")).toBe(true);
  });
});

describe("Debate Mode", () => {
  it("detects when debate is needed", () => {
    expect(needsDebate("choose between React and Vue for the frontend")).toBe(true);
    expect(needsDebate("fix the typo")).toBe(false);
  });

  it("selects relevant participants", () => {
    const participants = selectDebateParticipants("should we use PostgreSQL or MongoDB for the database?");
    expect(participants).toContain("planner");
    expect(participants).toContain("db-engineer");
  });
});

describe("PR Checks", () => {
  it("detects security issues in diffs", () => {
    const diff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,4 @@
+const API_KEY = "sk-abc123def456ghi789";
 export const config = {};
`;
    const result = runPrChecks(diff);
    expect(result.checks.some(c => c.checkName === "security-scan" && !c.passed)).toBe(true);
  });
});

describe("Built-in Skills", () => {
  it("detects active skills from task", () => {
    const skills = getActiveSkills("write E2E tests using playwright for the login page");
    expect(skills.some(s => s.name === "playwright")).toBe(true);
    expect(skills.some(s => s.name === "testing")).toBe(true);
  });

  it("builds skill context", () => {
    const skills = getActiveSkills("fix the git merge conflict");
    const ctx = buildSkillContext(skills);
    expect(ctx).toContain("Git Master");
  });

  it("has 6 built-in skills", () => {
    expect(getAllSkills().length).toBe(6);
  });
});

describe("Built-in MCPs", () => {
  it("lists enabled MCPs", () => {
    const mcps = getEnabledMcps();
    expect(mcps.length).toBeGreaterThanOrEqual(3);
    expect(mcps.some(m => m.name === "websearch")).toBe(true);
  });

  it("lists all MCPs with env status", () => {
    const all = listAllMcps();
    expect(all.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Task Store", () => {
  it("creates and lists tasks", () => {
    const store = new TaskStore();
    const task = store.create({ title: "Test task", priority: "high" });
    expect(task.id).toMatch(/^task-/);
    expect(store.list().length).toBe(1);
    expect(store.get(task.id)?.title).toBe("Test task");
  });

  it("updates task status", () => {
    const store = new TaskStore();
    const task = store.create({ title: "Do thing" });
    store.update(task.id, { status: "completed" });
    expect(store.get(task.id)?.status).toBe("completed");
    expect(store.get(task.id)?.completedAt).toBeDefined();
  });

  it("tracks progress", () => {
    const store = new TaskStore();
    store.create({ title: "A" });
    store.create({ title: "B" });
    const c = store.create({ title: "C" });
    store.update(c.id, { status: "completed" });
    const progress = store.getProgress();
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
    expect(progress.percent).toBe(33);
  });
});

describe("Prompt Discovery", () => {
  it("discovers requirements from a simple prompt", () => {
    const result = discoverRequirements("Todo 앱 만들어줘");
    expect(result.appCategory).not.toBe("unknown");
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it("formats discovery for user", () => {
    const result = discoverRequirements("실시간 채팅 앱");
    const formatted = formatDiscoveryForUser(result);
    expect(formatted).toContain("분석 결과");
  });
});

describe("Blueprint", () => {
  it("generates a complete blueprint", () => {
    const discovery = discoverRequirements("Todo 앱 만들어줘");
    const blueprint = generateBlueprint(discovery, []);
    expect(blueprint.totalFiles).toBeGreaterThan(0);
    expect(blueprint.totalTasks).toBeGreaterThan(0);
    expect(blueprint.phases.length).toBeGreaterThan(0);
    expect(blueprint.schema.length).toBeGreaterThan(0);
  });
});
