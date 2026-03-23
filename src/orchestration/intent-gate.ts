/**
 * IntentGate: intent classification interface.
 *
 * Previously used regex to classify intent. Now returns safe defaults
 * and lets the AI ANALYZE step make all decisions. The types and interface
 * are preserved for backward compatibility with engine.ts, enforcer.ts, etc.
 */

import type { RoleCategory } from "../core/types.js";

export type IntentAction =
  | "build"
  | "fix"
  | "add"
  | "refactor"
  | "investigate"
  | "deploy"
  | "test"
  | "document"
  | "review"
  | "migrate"
  | "optimize"
  | "security-audit"
  | "general";

export type IntentScope = "single-file" | "module" | "cross-cutting" | "repo-wide";

export type IntentRisk = "low" | "medium" | "high";

export interface IntentAnalysis {
  action: IntentAction;
  scope: IntentScope;
  risk: IntentRisk;
  suggestedRoles: string[];
  constraints: string[];
  skipResearch: boolean;
  skipDelegation: boolean;
  maxReviewPasses: number;
  category: RoleCategory;
}

/**
 * Returns safe defaults — AI ANALYZE step makes the real decisions.
 * No regex, no hardcoded rules. The engine uses this for initial setup
 * (checkpoint decisions, review depth) before AI analysis runs.
 */
export function analyzeIntent(_task: string): IntentAnalysis {
  return {
    action: "general",
    scope: "module",
    risk: "medium",
    suggestedRoles: ["planner", "executor", "test-engineer"],
    constraints: [],
    skipResearch: false,
    skipDelegation: false,
    maxReviewPasses: 3,
    category: "execution"
  };
}
