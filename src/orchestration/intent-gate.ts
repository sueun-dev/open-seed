/**
 * IntentGate: explicit intent classification before planning.
 *
 * Classifies the raw user task into a structured intent with:
 * - primary action type (build, fix, add, refactor, investigate, deploy, test, document, review)
 * - scope (single-file, module, cross-cutting, repo-wide)
 * - risk level (low, medium, high)
 * - suggested specialist roles to activate
 * - constraints extracted from the task text
 *
 * The engine uses the intent to skip unnecessary planning, activate the right
 * specialists, and set appropriate review depth.
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

interface ActionRule {
  action: IntentAction;
  patterns: RegExp[];
  defaultRisk: IntentRisk;
  roles: string[];
}

const ACTION_RULES: ActionRule[] = [
  // security-audit must come early: "check for XSS" is security, not review
  {
    action: "security-audit",
    patterns: [/\b(security|vulnerability|cve|injection|xss|csrf|auth\s*bypass|secret\s*leak)\b/i],
    defaultRisk: "high",
    roles: ["security-auditor"]
  },
  {
    action: "fix",
    patterns: [/\b(fix|bug|broken|crash|error|fail|regression|patch|hotfix)\b/i],
    defaultRisk: "medium",
    roles: ["debugger", "test-engineer"]
  },
  {
    action: "build",
    patterns: [/\b(build|compile|typecheck|tsc|bundle|webpack|vite|esbuild)\b/i],
    defaultRisk: "low",
    roles: ["build-doctor"]
  },
  {
    action: "test",
    patterns: [/\b(test|spec|coverage|assert|vitest|jest|pytest|e2e)\b/i],
    defaultRisk: "low",
    roles: ["test-engineer"]
  },
  {
    action: "refactor",
    patterns: [/\b(refactor|restructure|clean\s*up|simplify|extract|rename|move)\b/i],
    defaultRisk: "medium",
    roles: ["refactor-specialist", "code-simplifier", "test-engineer"]
  },
  {
    action: "add",
    patterns: [/\b(add|implement|create|new feature|introduce|wire up|integrate)\b/i],
    defaultRisk: "medium",
    roles: ["planner", "executor", "test-engineer"]
  },
  {
    action: "investigate",
    patterns: [/\b(investigate|research|why|root cause|trace|analyze|understand|explain)\b/i],
    defaultRisk: "low",
    roles: ["researcher", "debugger"]
  },
  {
    action: "deploy",
    patterns: [/\b(deploy|release|ship|publish|rollout|ci|cd|pipeline)\b/i],
    defaultRisk: "high",
    roles: ["devops-engineer", "cicd-engineer", "release-manager"]
  },
  {
    action: "document",
    patterns: [/\b(document|docs|readme|comment|explain|guide|jsdoc|tsdoc)\b/i],
    defaultRisk: "low",
    roles: ["docs-writer"]
  },
  {
    action: "review",
    patterns: [/\b(review|audit|inspect|verify|validate)\b/i],
    defaultRisk: "low",
    roles: ["reviewer", "compliance-reviewer"]
  },
  {
    action: "migrate",
    patterns: [/\b(migrate|migration|upgrade|convert|port|move to)\b/i],
    defaultRisk: "high",
    roles: ["migration-engineer", "test-engineer"]
  },
  {
    action: "optimize",
    patterns: [/\b(optimize|performance|speed|slow|fast|memory|cpu|latency)\b/i],
    defaultRisk: "medium",
    roles: ["performance-engineer", "benchmark-analyst"]
  },
];

const SCOPE_RULES: Array<{ scope: IntentScope; patterns: RegExp[] }> = [
  { scope: "single-file", patterns: [/\b(in|for)\s+(this|the)\s+file\b/i, /\b(single|one)\s+file\b/i, /\bfile\s+\S+\.\w+\b/i] },
  { scope: "repo-wide", patterns: [/\b(everywhere|all files|whole repo|entire project|repo.wide|project.wide|across the)\b/i] },
  { scope: "cross-cutting", patterns: [/\b(cross.cutting|multiple|several|all|every)\s+(module|component|service|file)/i] },
  { scope: "module", patterns: [/\b(module|component|package|service|folder|directory)\b/i] }
];

const CONSTRAINT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "no-breaking-changes", pattern: /\b(no breaking|without breaking|backward.compat|don'?t break)\b/i },
  { label: "keep-tests-green", pattern: /\b(tests?\s+(?:must|should)\s+pass|keep.*green|don'?t break tests)\b/i },
  { label: "minimize-diff", pattern: /\b(minimal|small|tight|focused)\s+(diff|change|patch)\b/i },
  { label: "preserve-api", pattern: /\b(preserve|keep|maintain)\s+(api|interface|contract)\b/i },
  { label: "no-new-deps", pattern: /\b(no new|avoid|don'?t add)\s+(dep|dependenc|package)\b/i },
  { label: "urgent", pattern: /\b(urgent|asap|immediately|right now|hotfix)\b/i }
];

export function analyzeIntent(task: string): IntentAnalysis {
  const action = classifyAction(task);
  const scope = classifyScope(task);
  const constraints = extractConstraints(task);
  const risk = computeRisk(action, scope, constraints);
  const suggestedRoles = collectSuggestedRoles(action, task);
  const category = intentToCategory(action);

  const isSimple = scope === "single-file" && risk === "low";
  const isInvestigation = action === "investigate" || action === "review";

  return {
    action,
    scope,
    risk,
    suggestedRoles,
    constraints,
    skipResearch: isSimple && !isInvestigation,
    skipDelegation: isSimple,
    maxReviewPasses: risk === "high" ? 4 : risk === "medium" ? 3 : 2,
    category
  };
}

function classifyAction(task: string): IntentAction {
  for (const rule of ACTION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(task))) {
      return rule.action;
    }
  }
  return "general";
}

function classifyScope(task: string): IntentScope {
  for (const rule of SCOPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(task))) {
      return rule.scope;
    }
  }
  // heuristic: long tasks tend to be broader
  if (task.length > 300) {
    return "cross-cutting";
  }
  return "module";
}

function extractConstraints(task: string): string[] {
  return CONSTRAINT_PATTERNS
    .filter((rule) => rule.pattern.test(task))
    .map((rule) => rule.label);
}

function computeRisk(action: IntentAction, scope: IntentScope, constraints: string[]): IntentRisk {
  const actionRule = ACTION_RULES.find((rule) => rule.action === action);
  let risk = actionRule?.defaultRisk ?? "medium";

  // scope escalation
  if (scope === "repo-wide" && risk === "low") {
    risk = "medium";
  }
  if (scope === "repo-wide" && risk === "medium") {
    risk = "high";
  }
  if (scope === "cross-cutting" && risk === "low") {
    risk = "medium";
  }

  // constraint escalation
  if (constraints.includes("urgent")) {
    risk = risk === "low" ? "medium" : risk;
  }

  return risk;
}

function collectSuggestedRoles(action: IntentAction, task: string): string[] {
  const roles = new Set<string>();

  // from action rule
  const actionRule = ACTION_RULES.find((rule) => rule.action === action);
  if (actionRule) {
    for (const role of actionRule.roles) {
      roles.add(role);
    }
  }

  // additional signals from task text
  if (/\b(security|auth|oauth|token|secret)\b/i.test(task)) {
    roles.add("security-auditor");
  }
  if (/\b(performance|latency|speed|memory)\b/i.test(task)) {
    roles.add("performance-engineer");
  }
  if (/\b(browser|ui|frontend|css|component)\b/i.test(task)) {
    roles.add("frontend-engineer");
  }
  if (/\b(api|endpoint|contract)\b/i.test(task)) {
    roles.add("api-designer");
  }
  if (/\b(database|db|sql|migration)\b/i.test(task)) {
    roles.add("db-engineer");
  }
  if (/\b(deploy|infra|docker|k8s)\b/i.test(task)) {
    roles.add("devops-engineer");
  }

  return Array.from(roles);
}

function intentToCategory(action: IntentAction): RoleCategory {
  switch (action) {
    case "investigate":
    case "security-audit":
      return "research";
    case "review":
      return "review";
    case "document":
      return "planning";
    case "deploy":
      return "planning";
    default:
      return "execution";
  }
}
