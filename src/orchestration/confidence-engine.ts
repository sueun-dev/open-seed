/**
 * Confidence-Based Decision Engine — knows when to act vs when to ask.
 *
 * Tracks confidence in every decision:
 * - High confidence (>0.8) → execute autonomously
 * - Medium confidence (0.5-0.8) → execute but verify immediately
 * - Low confidence (<0.5) → ask human or try alternative
 *
 * Also learns from outcomes to improve future confidence estimates.
 *
 * Source: OpenHands + MetaGPT implicit patterns
 */

export interface ConfidenceScore {
  value: number;          // 0.0 - 1.0
  factors: ConfidenceFactor[];
  recommendation: "execute" | "execute-and-verify" | "ask-human" | "try-alternative";
}

export interface ConfidenceFactor {
  name: string;
  weight: number;
  score: number;
  reason: string;
}

export interface ConfidenceHistory {
  decisions: ConfidenceDecision[];
  accuracyRate: number;
  totalDecisions: number;
}

export interface ConfidenceDecision {
  taskHash: string;
  confidence: number;
  decision: string;
  wasCorrect: boolean | null;
  timestamp: number;
}

/**
 * Calculate confidence score for a task execution decision.
 */
export function calculateConfidence(params: {
  taskClarity: number;        // 0-1: how clear is the task?
  codebaseFamiliarity: number; // 0-1: how well do we know this codebase?
  riskLevel: "low" | "medium" | "high";
  hasTests: boolean;
  hasExistingPatterns: boolean;
  previousSuccessRate: number;  // 0-1: success rate on similar tasks
  toolsAvailable: boolean;
  scopeSize: "single-file" | "module" | "cross-cutting" | "repo-wide";
}): ConfidenceScore {
  const factors: ConfidenceFactor[] = [];

  // Task clarity
  factors.push({
    name: "task-clarity",
    weight: 0.25,
    score: params.taskClarity,
    reason: params.taskClarity > 0.7 ? "Task is clear" : "Task is ambiguous"
  });

  // Codebase familiarity
  factors.push({
    name: "codebase-familiarity",
    weight: 0.20,
    score: params.codebaseFamiliarity,
    reason: params.codebaseFamiliarity > 0.7 ? "Codebase well understood" : "Codebase unfamiliar"
  });

  // Risk level
  const riskScore = params.riskLevel === "low" ? 0.9 : params.riskLevel === "medium" ? 0.6 : 0.3;
  factors.push({
    name: "risk-level",
    weight: 0.20,
    score: riskScore,
    reason: `Risk: ${params.riskLevel}`
  });

  // Test safety net
  factors.push({
    name: "test-coverage",
    weight: 0.15,
    score: params.hasTests ? 0.8 : 0.3,
    reason: params.hasTests ? "Tests exist as safety net" : "No tests — can't verify"
  });

  // Scope
  const scopeScore = { "single-file": 0.9, "module": 0.7, "cross-cutting": 0.4, "repo-wide": 0.2 }[params.scopeSize];
  factors.push({
    name: "scope-size",
    weight: 0.10,
    score: scopeScore,
    reason: `Scope: ${params.scopeSize}`
  });

  // Track record
  factors.push({
    name: "previous-success",
    weight: 0.10,
    score: params.previousSuccessRate,
    reason: `Previous success rate: ${Math.round(params.previousSuccessRate * 100)}%`
  });

  // Calculate weighted average
  const value = factors.reduce((sum, f) => sum + f.weight * f.score, 0);

  // Determine recommendation
  let recommendation: ConfidenceScore["recommendation"];
  if (value >= 0.8) recommendation = "execute";
  else if (value >= 0.5) recommendation = "execute-and-verify";
  else if (value >= 0.3) recommendation = "try-alternative";
  else recommendation = "ask-human";

  return { value, factors, recommendation };
}

/**
 * Estimate task clarity from the prompt text.
 */
export function estimateTaskClarity(task: string): number {
  let clarity = 0.5;

  // Specific file references increase clarity
  if (/\b\w+\.(ts|js|py|go|rs|java|tsx|jsx)\b/.test(task)) clarity += 0.1;

  // Specific function/class names
  if (/\b(function|class|method|variable|import|export)\b/i.test(task)) clarity += 0.1;

  // Action verbs are clear
  if (/\b(add|fix|remove|rename|create|delete|update|refactor)\b/i.test(task)) clarity += 0.1;

  // Vague language reduces clarity
  if (/\b(improve|better|somehow|maybe|think|feel|try)\b/i.test(task)) clarity -= 0.15;

  // Very short tasks are ambiguous
  if (task.split(/\s+/).length < 5) clarity -= 0.1;

  // Long, detailed tasks are clearer
  if (task.split(/\s+/).length > 20) clarity += 0.1;

  return Math.max(0, Math.min(1, clarity));
}

/**
 * Estimate codebase familiarity based on available context.
 */
export function estimateCodebaseFamiliarity(params: {
  hasRepoMap: boolean;
  hasAgentsMd: boolean;
  hasMemory: boolean;
  learnedPatternCount: number;
  previousSessionCount: number;
}): number {
  let familiarity = 0.2;

  if (params.hasRepoMap) familiarity += 0.2;
  if (params.hasAgentsMd) familiarity += 0.15;
  if (params.hasMemory) familiarity += 0.15;
  if (params.learnedPatternCount > 5) familiarity += 0.15;
  if (params.previousSessionCount > 3) familiarity += 0.15;

  return Math.min(1, familiarity);
}

/**
 * Create confidence history tracker.
 */
export function createConfidenceHistory(): ConfidenceHistory {
  return { decisions: [], accuracyRate: 0, totalDecisions: 0 };
}

export function recordConfidenceDecision(history: ConfidenceHistory, decision: Omit<ConfidenceDecision, "timestamp">): void {
  history.decisions.push({ ...decision, timestamp: Date.now() });
  history.totalDecisions++;

  // Update accuracy
  const verified = history.decisions.filter(d => d.wasCorrect !== null);
  if (verified.length > 0) {
    history.accuracyRate = verified.filter(d => d.wasCorrect).length / verified.length;
  }
}

export function getSuccessRateForSimilarTasks(history: ConfidenceHistory): number {
  if (history.totalDecisions === 0) return 0.5; // Default 50% for new agents
  return history.accuracyRate;
}

export function formatConfidenceScore(score: ConfidenceScore): string {
  const pct = Math.round(score.value * 100);
  const emoji = score.recommendation === "execute" ? "🟢" :
    score.recommendation === "execute-and-verify" ? "🟡" :
    score.recommendation === "try-alternative" ? "🟠" : "🔴";

  const lines = [`${emoji} Confidence: ${pct}% → ${score.recommendation}`];
  for (const f of score.factors) {
    lines.push(`  ${f.name}: ${Math.round(f.score * 100)}% (${f.reason})`);
  }
  return lines.join("\n");
}
