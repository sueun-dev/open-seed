/**
 * Sisyphus-Level AGI Features.
 *
 * Inspired by oh-my-openagent's Sisyphus orchestrator:
 * - Codebase Assessment (Phase 1): classify maturity before implementing
 * - Intent Verbalization: articulate what user wants before routing
 * - Structured Delegation (6-section): prevent rogue subagent behavior
 * - Evidence Requirements: no task complete without proof
 * - Oracle Escalation: consult strategic advisor after failures
 * - Sandbox Execution Signaling: Codex-style environment detection
 */

import type { IntentAnalysis } from "./intent-gate.js";
import type { RoleDefinition, PlannerTask } from "../core/types.js";

// ─── Codebase Assessment (Phase 1) ──────────────────────────────────────────

export type CodebaseMaturity = "disciplined" | "transitional" | "legacy" | "greenfield";

export interface CodebaseAssessment {
  maturity: CodebaseMaturity;
  confidence: number;
  patterns: {
    hasLinter: boolean;
    hasFormatter: boolean;
    hasTypeConfig: boolean;
    hasTests: boolean;
    hasCi: boolean;
    primaryLanguage: string;
    packageManager: string | null;
    testFramework: string | null;
    buildTool: string | null;
  };
  conventions: string[];
  warnings: string[];
}

export function assessCodebase(files: string[], configContents: Record<string, string>): CodebaseAssessment {
  const patterns = {
    hasLinter: hasAny(files, [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs", "biome.json", ".pylintrc", "ruff.toml"]),
    hasFormatter: hasAny(files, [".prettierrc", ".prettierrc.json", "prettier.config.js", "biome.json", ".editorconfig", "rustfmt.toml"]),
    hasTypeConfig: hasAny(files, ["tsconfig.json", "jsconfig.json", "mypy.ini", "pyproject.toml"]),
    hasTests: hasAny(files, ["vitest.config.ts", "jest.config.js", "jest.config.ts", "pytest.ini"]) || files.some((f) => /\.(test|spec)\.(ts|js|py|rs)$/.test(f)),
    hasCi: files.some((f) => f.includes(".github/workflows/") || f.includes(".gitlab-ci")),
    primaryLanguage: detectLanguage(files),
    packageManager: detectPkgMgr(files),
    testFramework: detectTests(files, configContents),
    buildTool: detectBuild(files, configContents)
  };

  const score = (patterns.hasLinter ? 2 : 0) + (patterns.hasFormatter ? 2 : 0) +
    (patterns.hasTypeConfig ? 2 : 0) + (patterns.hasTests ? 3 : 0) + (patterns.hasCi ? 1 : 0);

  const maturity: CodebaseMaturity = files.length < 5 ? "greenfield" : score >= 8 ? "disciplined" : score >= 4 ? "transitional" : "legacy";

  const conventions: string[] = [];
  const warnings: string[] = [];

  if (patterns.hasTypeConfig) conventions.push("TypeScript strict mode — maintain type safety");
  if (patterns.hasLinter) conventions.push("Linter configured — follow existing lint rules");
  if (patterns.hasFormatter) conventions.push("Formatter configured — don't manually format");
  if (patterns.hasTests) conventions.push(`Test framework: ${patterns.testFramework ?? "unknown"} — write tests for new code`);
  if (!patterns.hasLinter && maturity !== "greenfield") warnings.push("No linter — be careful with code style");
  if (!patterns.hasTests && maturity !== "greenfield") warnings.push("No tests — consider adding tests");
  if (maturity === "legacy") warnings.push("Legacy codebase — match existing patterns, avoid new conventions");

  return { maturity, confidence: Math.min(1, score / 10), patterns, conventions, warnings };
}

// ─── Intent Verbalization ────────────────────────────────────────────────────

export interface VerbalizedIntent {
  surfaceRequest: string;
  trueIntent: string;
  routingDecision: string;
  category: "research" | "implementation" | "investigation" | "evaluation" | "fix" | "open-ended";
  delegation: "direct" | "delegate" | "explore-first";
}

export function verbalizeIntent(task: string, intent: IntentAnalysis): VerbalizedIntent {
  const surfaceRequest = task.slice(0, 200);

  let category: VerbalizedIntent["category"];
  let delegation: VerbalizedIntent["delegation"];
  let trueIntent: string;
  let routingDecision: string;

  switch (intent.action) {
    case "investigate":
    case "review":
      category = "investigation";
      delegation = "explore-first";
      trueIntent = `User wants to understand something. Actual need: deep exploration of ${intent.scope} scope.`;
      routingDecision = "Fire Explore + Librarian agents in parallel, then synthesize findings.";
      break;
    case "fix":
      category = "fix";
      delegation = intent.scope === "single-file" ? "direct" : "explore-first";
      trueIntent = `User has a bug/error to fix. Risk: ${intent.risk}. Must verify fix with tests.`;
      routingDecision = intent.scope === "single-file"
        ? "Direct fix — locate error, patch, verify."
        : "Explore first to understand scope, then fix with verification.";
      break;
    case "add":
    case "build":
      category = "implementation";
      delegation = intent.scope === "single-file" ? "direct" : "delegate";
      trueIntent = `User wants new functionality. Scope: ${intent.scope}. Must follow existing patterns.`;
      routingDecision = intent.scope === "single-file"
        ? "Direct implementation with verification."
        : "Plan first, delegate specialist tasks, verify integration.";
      break;
    case "refactor":
    case "optimize":
      category = "evaluation";
      delegation = "explore-first";
      trueIntent = `User wants improvement without behavior change. Must preserve existing functionality.`;
      routingDecision = "Explore current state, plan changes, implement with before/after verification.";
      break;
    case "document":
      category = "research";
      delegation = "direct";
      trueIntent = `User wants documentation. Must accurately reflect current behavior.`;
      routingDecision = "Read current implementation, then write docs.";
      break;
    default:
      category = "open-ended";
      delegation = intent.skipDelegation ? "direct" : "delegate";
      trueIntent = `General request. Need to assess scope and determine approach.`;
      routingDecision = "Analyze task, determine if simple (direct) or complex (delegate).";
  }

  return { surfaceRequest, trueIntent, routingDecision, category, delegation };
}

// ─── Structured Delegation Format (6-section) ────────────────────────────────

export interface StructuredDelegation {
  task: string;
  expectedOutcome: string;
  requiredTools: string[];
  mustDo: string[];
  mustNotDo: string[];
  context: string;
}

export function buildStructuredDelegationPrompt(delegation: StructuredDelegation): string {
  return [
    `## TASK`,
    delegation.task,
    "",
    `## EXPECTED OUTCOME`,
    delegation.expectedOutcome,
    "",
    `## REQUIRED TOOLS`,
    delegation.requiredTools.map((t) => `- ${t}`).join("\n"),
    "",
    `## MUST DO`,
    delegation.mustDo.map((m) => `- ${m}`).join("\n"),
    "",
    `## MUST NOT DO`,
    delegation.mustNotDo.map((m) => `- ${m}`).join("\n"),
    "",
    `## CONTEXT`,
    delegation.context
  ].join("\n");
}

export function createStructuredDelegation(
  task: PlannerTask,
  role: RoleDefinition,
  rootTask: string,
  repoSummary: string
): StructuredDelegation {
  return {
    task: task.title,
    expectedOutcome: `Complete the task: "${task.title}". Produce a structured artifact with concrete results.`,
    requiredTools: role.toolPolicy.allowed,
    mustDo: [
      "Read all relevant files before making changes",
      "Verify changes with appropriate build/test commands",
      "Return valid JSON matching the specialist contract schema",
      "Include specific file paths and line numbers in findings"
    ],
    mustNotDo: [
      "Do NOT modify files outside the task scope",
      "Do NOT leave TODO/FIXME comments for core functionality",
      "Do NOT introduce new dependencies without justification",
      "Do NOT skip verification steps"
    ],
    context: [
      `Root task: ${rootTask}`,
      `Specialist role: ${role.displayName} (${role.id})`,
      `Category: ${task.category}`,
      `Repository:`,
      repoSummary.slice(0, 2000)
    ].join("\n")
  };
}

// ─── Evidence Requirements ───────────────────────────────────────────────────

export interface EvidenceRequirement {
  type: "diagnostics-clean" | "build-pass" | "test-pass" | "delegation-verified" | "file-read";
  description: string;
  satisfied: boolean;
  evidence?: string;
}

export function createEvidenceRequirements(intent: IntentAnalysis): EvidenceRequirement[] {
  const reqs: EvidenceRequirement[] = [];

  if (["add", "fix", "refactor", "build", "migrate"].includes(intent.action)) {
    reqs.push({ type: "diagnostics-clean", description: "LSP diagnostics clean on changed files", satisfied: false });
  }
  if (["add", "build", "migrate"].includes(intent.action)) {
    reqs.push({ type: "build-pass", description: "Build exits with code 0", satisfied: false });
  }
  if (["add", "fix", "refactor", "test", "migrate"].includes(intent.action)) {
    reqs.push({ type: "test-pass", description: "Test suite passes", satisfied: false });
  }

  return reqs;
}

export function updateEvidence(reqs: EvidenceRequirement[], output: string): EvidenceRequirement[] {
  return reqs.map((req) => {
    if (req.satisfied) return req;
    switch (req.type) {
      case "diagnostics-clean":
        if (/0 errors|no diagnostics|diagnostics.*clean/i.test(output))
          return { ...req, satisfied: true, evidence: "0 errors" };
        break;
      case "build-pass":
        if (/build.*success|compiled successfully|exit code 0/i.test(output))
          return { ...req, satisfied: true, evidence: "Build passed" };
        break;
      case "test-pass":
        if (/tests? (pass|succeed|green|all \d+ passed)|\d+ passed,?\s*0 fail/i.test(output))
          return { ...req, satisfied: true, evidence: "Tests passed" };
        break;
      case "delegation-verified":
        if (/delegation.*complet|artifact.*received/i.test(output))
          return { ...req, satisfied: true, evidence: "Delegation complete" };
        break;
    }
    return req;
  });
}

export function allEvidenceSatisfied(reqs: EvidenceRequirement[]): boolean {
  return reqs.every((r) => r.satisfied);
}

// ─── Oracle Escalation ───────────────────────────────────────────────────────

export interface OracleEscalation {
  shouldEscalate: boolean;
  reason: string;
  consecutiveFailures: number;
}

export function checkOracleEscalation(consecutiveFailures: number, maxBeforeEscalation = 2): OracleEscalation {
  if (consecutiveFailures >= maxBeforeEscalation) {
    return {
      shouldEscalate: true,
      reason: `${consecutiveFailures} consecutive failures — consulting Oracle for strategic guidance`,
      consecutiveFailures
    };
  }
  return { shouldEscalate: false, reason: "", consecutiveFailures };
}

export function buildOraclePrompt(task: string, failureHistory: string[], currentState: string): string {
  return [
    "You are Oracle — a strategic advisor. You NEVER write code.",
    "",
    "The agent has failed multiple times on this task. Analyze the situation and provide guidance.",
    "",
    `Task: ${task}`,
    "",
    "Failure history:",
    ...failureHistory.map((f, i) => `${i + 1}. ${f}`),
    "",
    `Current state: ${currentState}`,
    "",
    "Return JSON:",
    '{',
    '  "bottomLine": "2-3 sentence diagnosis",',
    '  "actionPlan": ["Step 1", "Step 2", ...],',
    '  "effort": "quick|short|medium|large",',
    '  "risks": ["Risk 1", ...],',
    '  "shouldAbandon": false,',
    '  "alternativeApproach": "..."',
    '}'
  ].join("\n");
}

// ─── Sandbox Execution Signaling (Codex-style) ──────────────────────────────

export interface SandboxEnvironment {
  isSandboxed: boolean;
  networkDisabled: boolean;
  signalEnv: Record<string, string>;
}

export function createSandboxEnvironment(enabled: boolean): SandboxEnvironment {
  if (!enabled) {
    return { isSandboxed: false, networkDisabled: false, signalEnv: {} };
  }

  return {
    isSandboxed: true,
    networkDisabled: true,
    signalEnv: {
      AGENT40_SANDBOX: "1",
      AGENT40_SANDBOX_NETWORK_DISABLED: "1",
      // Codex compatibility
      CODEX_SANDBOX: "agent40",
      CODEX_SANDBOX_NETWORK_DISABLED: "1"
    }
  };
}

export function isSandboxed(): boolean {
  return process.env.AGENT40_SANDBOX === "1" || process.env.CODEX_SANDBOX !== undefined;
}

export function isNetworkDisabled(): boolean {
  return process.env.AGENT40_SANDBOX_NETWORK_DISABLED === "1" || process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasAny(files: string[], names: string[]): boolean {
  return names.some((n) => files.some((f) => f.endsWith(n) || f.includes(n)));
}

function detectLanguage(files: string[]): string {
  const c: Record<string, number> = {};
  for (const f of files) {
    const ext = f.split(".").pop() ?? "";
    if (["ts", "tsx"].includes(ext)) c.typescript = (c.typescript ?? 0) + 1;
    else if (["js", "jsx", "mjs"].includes(ext)) c.javascript = (c.javascript ?? 0) + 1;
    else if (ext === "py") c.python = (c.python ?? 0) + 1;
    else if (ext === "rs") c.rust = (c.rust ?? 0) + 1;
    else if (ext === "go") c.go = (c.go ?? 0) + 1;
  }
  return Object.entries(c).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "unknown";
}

function detectPkgMgr(files: string[]): string | null {
  if (files.some((f) => f.endsWith("pnpm-lock.yaml"))) return "pnpm";
  if (files.some((f) => f.endsWith("yarn.lock"))) return "yarn";
  if (files.some((f) => f.endsWith("bun.lockb"))) return "bun";
  if (files.some((f) => f.endsWith("package-lock.json"))) return "npm";
  if (files.some((f) => f.endsWith("Cargo.lock"))) return "cargo";
  if (files.some((f) => f.endsWith("go.sum"))) return "go";
  return null;
}

function detectTests(files: string[], configs: Record<string, string>): string | null {
  if (files.some((f) => f.includes("vitest"))) return "vitest";
  if (files.some((f) => f.includes("jest"))) return "jest";
  if (files.some((f) => f.endsWith("pytest.ini") || f.endsWith("conftest.py"))) return "pytest";
  if (configs["package.json"]?.includes('"vitest"')) return "vitest";
  if (configs["package.json"]?.includes('"jest"')) return "jest";
  return null;
}

function detectBuild(files: string[], configs: Record<string, string>): string | null {
  if (configs["package.json"]?.includes('"build"')) return "npm run build";
  if (files.some((f) => f.includes("webpack"))) return "webpack";
  if (files.some((f) => f.includes("vite"))) return "vite";
  if (files.some((f) => f.endsWith("Cargo.toml"))) return "cargo build";
  return null;
}
