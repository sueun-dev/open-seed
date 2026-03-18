/**
 * OMO Hooks — All oh-my-openagent features, built-in by default.
 * No setup needed. Everything runs automatically.
 *
 * Extracted from: oh-my-openagent/src/hooks/
 */

// ─── Think Mode (Claude extended thinking auto-switch) ──────────────────────

export interface ThinkModeState {
  enabled: boolean;
  taskComplexity: "low" | "medium" | "high";
  autoSwitch: boolean;
}

export function detectThinkMode(task: string): ThinkModeState {
  const lower = task.toLowerCase();
  const complexSignals = /architect|redesign|migrate|refactor.*entire|system.*design|from.*scratch/i;
  const mediumSignals = /implement|build|create.*with|add.*feature|fix.*bug/i;

  const complexity = complexSignals.test(lower) ? "high"
    : mediumSignals.test(lower) ? "medium"
      : "low";

  return {
    enabled: complexity === "high",
    taskComplexity: complexity,
    autoSwitch: true
  };
}

export function getThinkingBudget(state: ThinkModeState): number {
  switch (state.taskComplexity) {
    case "high": return 16384;
    case "medium": return 8192;
    case "low": return 4096;
  }
}

// ─── Anthropic Effort Level ─────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high";

export function selectEffort(task: string, roundNumber: number): EffortLevel {
  // First round: always high effort for planning
  if (roundNumber <= 1) return "high";
  // Simple tasks after first round: medium
  const isSimple = task.split(/\s+/).length < 15;
  if (isSimple) return "medium";
  // Complex tasks: stay high
  return "high";
}

// ─── Context Window Monitor ─────────────────────────────────────────────────

export interface ContextMonitorState {
  estimatedTokens: number;
  maxTokens: number;
  warningThreshold: number;
  criticalThreshold: number;
  compactionCount: number;
}

export function createContextMonitor(maxTokens: number): ContextMonitorState {
  return {
    estimatedTokens: 0,
    maxTokens,
    warningThreshold: maxTokens * 0.65,
    criticalThreshold: maxTokens * 0.80,
    compactionCount: 0
  };
}

export function updateContextUsage(state: ContextMonitorState, tokens: number): ContextMonitorState {
  return { ...state, estimatedTokens: state.estimatedTokens + tokens };
}

export function getContextStatus(state: ContextMonitorState): "ok" | "warning" | "critical" {
  if (state.estimatedTokens >= state.criticalThreshold) return "critical";
  if (state.estimatedTokens >= state.warningThreshold) return "warning";
  return "ok";
}

export function buildContextWarning(state: ContextMonitorState): string | null {
  const status = getContextStatus(state);
  if (status === "ok") return null;
  const pct = Math.round((state.estimatedTokens / state.maxTokens) * 100);
  if (status === "critical") {
    return `[CRITICAL] Context window ${pct}% full (${state.estimatedTokens}/${state.maxTokens} tokens). Compaction needed immediately.`;
  }
  return `[WARNING] Context window ${pct}% full. Consider reducing context or completing current task.`;
}

// ─── Session Recovery ───────────────────────────────────────────────────────

export interface RecoveryState {
  sessionId: string;
  lastPhase: string;
  lastRound: number;
  modifiedFiles: string[];
  pendingTasks: string[];
  timestamp: string;
}

export function buildRecoveryContext(state: RecoveryState): string {
  return [
    "## Session Recovery",
    `Recovering from interrupted session: ${state.sessionId}`,
    `Last phase: ${state.lastPhase}, Round: ${state.lastRound}`,
    state.modifiedFiles.length > 0 ? `Modified files: ${state.modifiedFiles.join(", ")}` : "",
    state.pendingTasks.length > 0 ? `Pending tasks:\n${state.pendingTasks.map(t => `- ${t}`).join("\n")}` : "",
    "",
    "Read modified files to verify their current state before continuing."
  ].filter(Boolean).join("\n");
}

// ─── Keyword Detector (auto-skill loading) ──────────────────────────────────

export interface KeywordRule {
  keywords: string[];
  skill: string;
  description: string;
}

const DEFAULT_KEYWORD_RULES: KeywordRule[] = [
  { keywords: ["oauth", "auth", "login", "jwt", "token"], skill: "security", description: "Security-sensitive operations" },
  { keywords: ["database", "migration", "schema", "sql"], skill: "database", description: "Database operations" },
  { keywords: ["deploy", "ci", "cd", "pipeline", "docker"], skill: "devops", description: "DevOps operations" },
  { keywords: ["test", "spec", "coverage", "jest", "vitest"], skill: "testing", description: "Testing operations" },
  { keywords: ["css", "style", "layout", "responsive", "ui"], skill: "frontend", description: "Frontend styling" },
  { keywords: ["api", "endpoint", "rest", "graphql", "route"], skill: "api", description: "API design" },
  { keywords: ["performance", "optimize", "cache", "speed"], skill: "performance", description: "Performance optimization" },
  { keywords: ["git", "branch", "merge", "rebase", "commit"], skill: "git", description: "Git operations" },
];

export function detectKeywords(task: string, rules: KeywordRule[] = DEFAULT_KEYWORD_RULES): KeywordRule[] {
  const lower = task.toLowerCase();
  return rules.filter(rule => rule.keywords.some(kw => lower.includes(kw)));
}

export function buildKeywordContext(matchedRules: KeywordRule[]): string {
  if (matchedRules.length === 0) return "";
  return [
    "## Auto-detected Skills",
    ...matchedRules.map(r => `- **${r.skill}**: ${r.description} (triggered by: ${r.keywords.join(", ")})`),
    "",
    "Apply these specialized skills to the task."
  ].join("\n");
}

// ─── Background Notification ────────────────────────────────────────────────

export interface BackgroundTask {
  id: string;
  description: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  result?: string;
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();

  register(id: string, description: string): void {
    this.tasks.set(id, { id, description, startedAt: Date.now(), status: "running" });
  }

  complete(id: string, result?: string): void {
    const task = this.tasks.get(id);
    if (task) { task.status = "completed"; task.result = result; }
  }

  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (task) { task.status = "failed"; task.result = error; }
  }

  getRunning(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === "running");
  }

  getCompleted(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status !== "running");
  }

  buildNotification(): string {
    const completed = this.getCompleted();
    if (completed.length === 0) return "";
    return completed.map(t =>
      `[${t.status.toUpperCase()}] ${t.description}${t.result ? `: ${t.result.slice(0, 200)}` : ""}`
    ).join("\n");
  }
}

// ─── Task Reminder ──────────────────────────────────────────────────────────

export function buildTaskReminder(tasks: Array<{ content: string; status: string }>): string {
  const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "blocked");
  if (incomplete.length === 0) return "";
  return [
    "## Task Reminder — Incomplete Work",
    ...incomplete.map(t => `- [${t.status === "in_progress" ? "►" : " "}] ${t.content}`),
    "",
    "Complete these before finishing. Mark each done as you go."
  ].join("\n");
}

// ─── Task Resume Info ───────────────────────────────────────────────────────

export function buildResumeInfo(sessionId: string, lastTask: string, lastStatus: string, modifiedFiles: string[]): string {
  return [
    "## Resuming Previous Session",
    `Session: ${sessionId}`,
    `Last task: ${lastTask}`,
    `Last status: ${lastStatus}`,
    modifiedFiles.length > 0 ? `Files modified: ${modifiedFiles.join(", ")}` : "",
    "",
    "Verify modified files are in correct state before continuing."
  ].filter(Boolean).join("\n");
}

// ─── Atlas (Project Structure Map) ──────────────────────────────────────────

export interface ProjectMap {
  rootFiles: string[];
  directories: string[];
  languages: Record<string, number>;
  frameworks: string[];
  hasTests: boolean;
  hasCI: boolean;
  packageManager: string | null;
}

export function buildAtlasContext(map: ProjectMap): string {
  const lines = ["## Project Atlas"];
  lines.push(`Languages: ${Object.entries(map.languages).sort(([,a],[,b]) => b - a).map(([l,c]) => `${l}(${c})`).join(", ")}`);
  if (map.frameworks.length > 0) lines.push(`Frameworks: ${map.frameworks.join(", ")}`);
  if (map.packageManager) lines.push(`Package manager: ${map.packageManager}`);
  lines.push(`Tests: ${map.hasTests ? "yes" : "no"}, CI: ${map.hasCI ? "yes" : "no"}`);
  lines.push(`Directories: ${map.directories.slice(0, 10).join(", ")}`);
  return lines.join("\n");
}

// ─── Start Work Hook ────────────────────────────────────────────────────────

export function buildStartWorkChecklist(task: string): string[] {
  const checks: string[] = [];
  checks.push("Verify working directory is correct");
  if (/git|commit|push|branch/i.test(task)) {
    checks.push("Check git status for uncommitted changes");
    checks.push("Verify current branch");
  }
  if (/test|spec/i.test(task)) {
    checks.push("Run existing tests to establish baseline");
  }
  if (/deploy|production/i.test(task)) {
    checks.push("Verify target environment");
    checks.push("Check for required credentials");
  }
  return checks;
}

// ─── Stop Continuation Guard ────────────────────────────────────────────────

export function shouldStop(roundNumber: number, maxRounds: number, lastVerdict: string, consecutiveFailures: number): { stop: boolean; reason?: string } {
  if (roundNumber >= maxRounds) return { stop: true, reason: `Max rounds (${maxRounds}) reached` };
  if (consecutiveFailures >= 5) return { stop: true, reason: `${consecutiveFailures} consecutive failures` };
  if (lastVerdict === "pass") return { stop: true, reason: "Review passed" };
  return { stop: false };
}

// ─── Look-At Tool (view specific lines) ─────────────────────────────────────

export function extractLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).map((line, i) => `${start + i + 1} | ${line}`).join("\n");
}
