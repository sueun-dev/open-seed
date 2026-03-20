/**
 * Graceful Degradation — never crash, always make progress.
 *
 * When resources run out (tokens, time, API quota), degrade gracefully:
 * 1. Token limit → compress context, reduce detail
 * 2. Time limit → skip non-critical steps
 * 3. Tool failure → try alternative tool or skip
 * 4. Provider failure → fall back to cheaper model
 * 5. Budget exceeded → switch to most cost-effective path
 *
 * Source: Plandex context management + standard resilience patterns
 */

export type DegradationLevel = "full" | "reduced" | "minimal" | "emergency";

export interface DegradationState {
  level: DegradationLevel;
  reason: string;
  tokenBudgetRemaining: number;
  timeBudgetRemaining: number;
  failedTools: string[];
  failedProviders: string[];
  skippedSteps: string[];
  activeSince: number;
}

export interface DegradationPolicy {
  /** Token usage % that triggers reduced mode */
  tokenWarningPct: number;
  /** Token usage % that triggers minimal mode */
  tokenCriticalPct: number;
  /** Time budget in ms before degradation */
  timeBudgetMs: number;
  /** Max consecutive tool failures before degradation */
  maxToolFailures: number;
  /** Steps that can be skipped in reduced mode */
  skippableSteps: string[];
  /** Steps that can NEVER be skipped */
  criticalSteps: string[];
}

const DEFAULT_POLICY: DegradationPolicy = {
  tokenWarningPct: 65,
  tokenCriticalPct: 85,
  timeBudgetMs: 300000, // 5 minutes
  maxToolFailures: 3,
  skippableSteps: [
    "code-simplification",
    "documentation",
    "performance-optimization",
    "accessibility-audit",
    "style-formatting",
    "comment-checking",
    "design-reference-loading",
  ],
  criticalSteps: [
    "intent-analysis",
    "execution",
    "verification",
    "error-recovery",
  ]
};

export function createDegradationState(
  tokenBudget: number,
  timeBudgetMs?: number
): DegradationState {
  return {
    level: "full",
    reason: "",
    tokenBudgetRemaining: tokenBudget,
    timeBudgetRemaining: timeBudgetMs ?? DEFAULT_POLICY.timeBudgetMs,
    failedTools: [],
    failedProviders: [],
    skippedSteps: [],
    activeSince: Date.now()
  };
}

/**
 * Update degradation state based on current conditions.
 */
export function updateDegradation(
  state: DegradationState,
  conditions: {
    tokenUsedPct: number;
    elapsedMs: number;
    toolFailure?: string;
    providerFailure?: string;
  },
  policy: DegradationPolicy = DEFAULT_POLICY
): DegradationState {
  const updated = { ...state };

  // Track failures
  if (conditions.toolFailure && !updated.failedTools.includes(conditions.toolFailure)) {
    updated.failedTools.push(conditions.toolFailure);
  }
  if (conditions.providerFailure && !updated.failedProviders.includes(conditions.providerFailure)) {
    updated.failedProviders.push(conditions.providerFailure);
  }

  // Update time remaining
  updated.timeBudgetRemaining = Math.max(0, policy.timeBudgetMs - conditions.elapsedMs);

  // Determine level
  const prevLevel = updated.level;

  if (
    conditions.tokenUsedPct >= policy.tokenCriticalPct ||
    updated.timeBudgetRemaining <= 0 ||
    updated.failedTools.length >= policy.maxToolFailures + 2
  ) {
    updated.level = "emergency";
    updated.reason = conditions.tokenUsedPct >= policy.tokenCriticalPct
      ? `Token usage at ${Math.round(conditions.tokenUsedPct)}%`
      : updated.timeBudgetRemaining <= 0
        ? "Time budget exhausted"
        : `${updated.failedTools.length} tool failures`;
  } else if (
    conditions.tokenUsedPct >= policy.tokenWarningPct ||
    updated.timeBudgetRemaining < policy.timeBudgetMs * 0.3 ||
    updated.failedTools.length >= policy.maxToolFailures
  ) {
    updated.level = "minimal";
    updated.reason = "Resource constraints detected";
  } else if (
    conditions.tokenUsedPct >= policy.tokenWarningPct * 0.8 ||
    updated.failedProviders.length > 0
  ) {
    updated.level = "reduced";
    updated.reason = "Operating in reduced mode";
  } else {
    updated.level = "full";
    updated.reason = "";
  }

  return updated;
}

/**
 * Should a step be skipped given current degradation level?
 */
export function shouldSkipStep(
  state: DegradationState,
  stepName: string,
  policy: DegradationPolicy = DEFAULT_POLICY
): { skip: boolean; reason: string } {
  // Critical steps NEVER skip
  if (policy.criticalSteps.includes(stepName)) {
    return { skip: false, reason: "" };
  }

  // In full mode, nothing skipped
  if (state.level === "full") {
    return { skip: false, reason: "" };
  }

  // In emergency, skip everything skippable
  if (state.level === "emergency") {
    if (policy.skippableSteps.includes(stepName)) {
      state.skippedSteps.push(stepName);
      return { skip: true, reason: `Emergency mode: ${state.reason}` };
    }
  }

  // In minimal/reduced, skip low-priority skippables
  if (state.level === "minimal" || state.level === "reduced") {
    if (policy.skippableSteps.includes(stepName)) {
      state.skippedSteps.push(stepName);
      return { skip: true, reason: `${state.level} mode: ${state.reason}` };
    }
  }

  return { skip: false, reason: "" };
}

/**
 * Get alternative tool when one fails.
 */
export function getAlternativeTool(failedTool: string): string | null {
  const alternatives: Record<string, string> = {
    "lsp_diagnostics": "bash",      // fallback: npx tsc --noEmit
    "lsp_symbols": "grep",          // fallback: grep for definitions
    "ast_grep": "grep",             // fallback: regex search
    "browser": "bash",              // fallback: curl
    "web_search": "bash",           // fallback: curl search engine
    "apply_patch": "write",         // fallback: full file write
    "interactive_bash": "bash",     // fallback: regular bash
  };
  return alternatives[failedTool] ?? null;
}

/**
 * Get alternative prompt strategy for degraded mode.
 */
export function getDegradedPromptStrategy(level: DegradationLevel): {
  maxOutputTokens: number;
  contextReduction: number;
  instructions: string;
} {
  switch (level) {
    case "full":
      return { maxOutputTokens: 8192, contextReduction: 1.0, instructions: "" };
    case "reduced":
      return {
        maxOutputTokens: 4096,
        contextReduction: 0.7,
        instructions: "Be concise. Focus on the core task. Skip nice-to-haves."
      };
    case "minimal":
      return {
        maxOutputTokens: 2048,
        contextReduction: 0.4,
        instructions: "MINIMAL mode. Only essential changes. No refactoring. No docs. No tests unless critical."
      };
    case "emergency":
      return {
        maxOutputTokens: 1024,
        contextReduction: 0.2,
        instructions: "EMERGENCY. Make ONE essential change. No explanations. Just the fix."
      };
  }
}

export function formatDegradationStatus(state: DegradationState): string {
  if (state.level === "full") return "";
  const lines = [`## ⚠️ Degradation: ${state.level.toUpperCase()}`];
  if (state.reason) lines.push(`Reason: ${state.reason}`);
  if (state.failedTools.length > 0) lines.push(`Failed tools: ${state.failedTools.join(", ")}`);
  if (state.skippedSteps.length > 0) lines.push(`Skipped: ${state.skippedSteps.join(", ")}`);
  return lines.join("\n");
}
