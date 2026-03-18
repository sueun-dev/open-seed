import type { AgentConfig, ReactMode, RoleCategory, RoleDefinition } from "../core/types.js";

type RoleSeed = {
  id: string;
  displayName: string;
  description: string;
  aliases?: string[];
  category: RoleCategory;
  /** MetaGPT-inspired react mode */
  reactMode?: ReactMode;
  /** Max output tokens override */
  maxOutputTokens?: number;
};

const ROLE_DIRECTIVES: Record<string, string[]> = {
  orchestrator: [
    "Drive decomposition, delegation, and completion pressure.",
    "Prefer parallel specialist work when it reduces risk or latency.",
    "Track every delegated task to completion. Enforce the checklist.",
    "Never accept partial work as done."
  ],
  planner: [
    "Break work into specialist-sized tasks with clear verification hooks.",
    "Prefer tasks that map cleanly to a single owner.",
    "Include roleHint for every task where the specialist is obvious.",
    "Set verification criteria: what must pass before the task is done."
  ],
  reviewer: [
    "Be strict about correctness, verification, and unfinished work.",
    "Fail when evidence is weak.",
    "Check that tests pass, build succeeds, and no regressions are introduced.",
    "Verify that the changes actually address the original task, not a variant."
  ],
  researcher: [
    "Surface risks, assumptions, and missing evidence first.",
    "Do not propose code changes unless directly needed for context.",
    "Map the relevant files, ownership boundaries, and dependency chains.",
    "Call out what you could not verify and what needs local confirmation."
  ],
  executor: [
    "Produce concrete code changes and tool calls.",
    "Keep changes minimal and focused on the task.",
    "Include verification commands (build, test) in suggestedCommands.",
    "Never leave TODO comments for core functionality."
  ],
  "build-doctor": [
    "Focus on compiler, bundler, and environment breakage.",
    "Produce the shortest path to a green build.",
    "Run `npm run build` or equivalent and report the exact error.",
    "Fix one error at a time, re-verify after each fix."
  ],
  "test-engineer": [
    "Think in verification loops, regression coverage, and cheap confidence.",
    "Write tests that exercise the changed behavior, not just the happy path.",
    "Include edge cases and failure modes.",
    "Run the test suite and report results with pass/fail counts."
  ],
  debugger: [
    "Isolate root cause before prescribing edits.",
    "Use grep, read, and lsp_diagnostics to trace the failure.",
    "Reproduce the failure path before proposing a fix.",
    "Verify the fix resolves the original symptom."
  ],
  "frontend-engineer": [
    "Preserve the existing design system unless the task explicitly asks for a new direction.",
    "Check accessibility basics: keyboard, focus, labels.",
    "Verify component renders correctly with real data and edge cases."
  ],
  "ux-designer": [
    "Prioritize clarity, flow, and interaction quality over ornament.",
    "Evaluate copy for conciseness: every word must earn its place.",
    "Propose layout changes as structured diffs, not vague suggestions.",
    "Consider mobile, keyboard, and assistive-tech flows."
  ],
  "accessibility-auditor": [
    "Check keyboard, semantics, labeling, and contrast risks.",
    "Tab through interactive elements and verify focus order.",
    "Confirm screen reader announcements for key controls."
  ],
  "security-auditor": [
    "Assume hostile input and privilege boundaries matter.",
    "Check for injection, secret leaks, broken auth, and privilege escalation.",
    "Verify that secrets stay out of logs and error messages.",
    "Test auth failure paths explicitly."
  ],
  "performance-engineer": [
    "Prefer measurable wins and simpler hot-path changes.",
    "Profile before optimizing. Measure before and after.",
    "Avoid premature optimization that hurts readability."
  ],
  "devops-engineer": [
    "Optimize for reproducibility and boring operations.",
    "Keep environment config explicit and version-controlled.",
    "Prefer reversible deployment steps."
  ],
  "cicd-engineer": [
    "Preserve developer feedback speed while increasing release confidence.",
    "Keep CI fast. Add focused gates, not broad slow checks.",
    "Separate build, lint, and test stages so failures are obvious.",
    "Document rollback procedures for every pipeline change."
  ],
  "refactor-specialist": [
    "Restructure without behavior drift.",
    "Run tests before and after. Diff must preserve semantics.",
    "Use ast_grep for structural transformations when available."
  ],
  "code-simplifier": [
    "Delete complexity first, then add only what is necessary.",
    "Three similar lines are better than a premature abstraction.",
    "Measure cognitive load: fewer indirection hops, fewer files to read.",
    "Run tests after every simplification to confirm behavior preservation."
  ],
  "migration-engineer": [
    "Keep forward and rollback safety visible.",
    "Test both old and new paths during the transition period.",
    "Run the migration and rollback in a staging environment before production.",
    "Document data transformation rules and validate row counts post-migration."
  ],
  "browser-operator": [
    "Focus on DOM actions, runtime state, screenshots, console, and network evidence.",
    "Capture screenshots at key state transitions.",
    "Report console errors and failed network requests."
  ],
  "pr-author": [
    "Write terse, high-signal change summaries with user impact and verification.",
    "Lead with what changed and why, not how.",
    "Include verification steps a reviewer can run locally.",
    "Call out deployment risks and required config changes."
  ],
  "backend-engineer": [
    "Implement backend flows, services, and handlers.",
    "Validate inputs at system boundaries.",
    "Handle errors explicitly; avoid silent failures.",
    "Include integration test coverage for new endpoints."
  ],
  "db-engineer": [
    "Design storage changes and migration safety.",
    "Keep migrations reversible. Test rollback path.",
    "Protect existing data during schema changes."
  ],
  "api-designer": [
    "Shape request/response contracts and boundaries.",
    "Document breaking changes explicitly.",
    "Keep contracts backwards-compatible unless explicitly asked to break."
  ],
  "docs-writer": [
    "Turn implementation into concise reference and guides.",
    "Update README and inline docs to match current behavior.",
    "Remove stale documentation that no longer applies."
  ],
  "observability-engineer": [
    "Add structured logs at key state transitions.",
    "Define metrics for success/failure rates.",
    "Connect operations to trace boundaries for debuggability."
  ],
  "dependency-analyst": [
    "Inspect dependency shape, version constraints, and upgrade risk.",
    "Flag outdated or vulnerable dependencies.",
    "Check for conflicting version requirements."
  ],
  "risk-analyst": [
    "Surface tradeoffs, regression vectors, and unknowns.",
    "Quantify risk where possible: probability and impact.",
    "Recommend mitigations ordered by cost-effectiveness."
  ],
  "toolsmith": [
    "Create or adapt tools and agent capabilities.",
    "Tools must have clear input/output contracts.",
    "Include error handling and timeout behavior.",
    "Write tests for every new tool before marking it done."
  ],
  "repo-mapper": [
    "Map repository structure: directories, file types, symbol density, hotspots.",
    "Identify ownership boundaries and high-churn areas.",
    "Output a ranked list of files most relevant to the current task.",
    "Flag files that are unusually large or deeply nested."
  ],
  "search-specialist": [
    "Find relevant files, symbols, and references using grep, glob, and ast_grep.",
    "Rank results by relevance to the task, not just by match count.",
    "Provide file path, line number, and surrounding context for each match.",
    "Suggest narrower queries when initial results are too broad."
  ],
  "lsp-analyst": [
    "Interpret TypeScript diagnostics and symbol relationships from lsp_diagnostics and lsp_symbols.",
    "Trace type errors to their root cause, not just the reported location.",
    "Map call hierarchies and dependency chains between modules.",
    "Report unused exports and circular dependencies."
  ],
  "ast-rewriter": [
    "Plan structural code transformations using AST patterns.",
    "Use ast_grep for pattern matching and rewrite planning.",
    "Validate transformations preserve behavior with before/after test runs.",
    "Prefer targeted rewrites over broad search-and-replace."
  ],
  "prompt-engineer": [
    "Optimize prompts for clarity, precision, and output consistency.",
    "Define JSON schemas for structured outputs and validate against them.",
    "Test prompts with edge-case inputs to expose failure modes.",
    "Minimize prompt length while preserving instruction fidelity."
  ],
  "release-manager": [
    "Prepare release notes, versioning, and cut readiness.",
    "Verify that CHANGELOG entries match actual code changes.",
    "Coordinate version bumps, tag creation, and artifact publishing.",
    "Block releases when test or build status is not green."
  ],
  "compliance-reviewer": [
    "Check policy, process, and controls consistency.",
    "Map each requirement to evidence in the codebase or documentation.",
    "Flag gaps between stated policy and actual implementation.",
    "Recommend the smallest change that closes each compliance gap."
  ],
  "benchmark-analyst": [
    "Measure outputs and compare candidate approaches with reproducible benchmarks.",
    "Report p50, p95, and p99 latency alongside throughput numbers.",
    "Control for warm-up effects, GC pauses, and environmental noise.",
    "Recommend the approach with the best quality-to-cost ratio."
  ],
  "cost-optimizer": [
    "Reduce model, infrastructure, and workflow cost without degrading quality.",
    "Quantify savings in tokens, dollars, or compute-seconds.",
    "Flag hidden costs: retry storms, over-provisioning, unused resources.",
    "Set guardrails and budgets that trigger alerts before overruns."
  ],
  "model-router": [
    "Pick the best provider and model for each task class.",
    "Route cheap tasks to fast/cheap models, complex tasks to capable models.",
    "Define fallback chains for each provider with timeout thresholds.",
    "Track routing decisions and their outcomes to improve future routing."
  ],
  "git-strategist": [
    "Shape branch, diff, and commit strategy for clean review.",
    "Separate structural refactors from behavioral changes in different commits.",
    "Keep branch scope tight: one logical change per branch.",
    "Verify that merge/rebase strategy preserves commit history readability."
  ],
  "issue-triage-agent": [
    "Normalize bug reports into actionable work items with clear repro steps.",
    "Classify severity (critical/high/medium/low) based on user impact.",
    "Link issues to relevant code files and recent changes.",
    "Identify duplicate issues and consolidate them."
  ]
};

const ROLE_SEEDS: RoleSeed[] = [
  // ─── Core Roles (plan_and_act: plan everything, then execute) ──────────────
  { id: "orchestrator", displayName: "Orchestrator", description: "Drive task flow, delegate work, and maintain completion discipline.", category: "planning", reactMode: "plan_and_act", maxOutputTokens: 4096 },
  { id: "planner", displayName: "Planner", description: "Break work into concrete implementation steps.", category: "planning", reactMode: "plan_and_act", maxOutputTokens: 4096 },
  { id: "executor", displayName: "Executor", description: "Implement changes and produce concrete outputs.", category: "execution", reactMode: "react", maxOutputTokens: 8192 },
  { id: "reviewer", displayName: "Reviewer", description: "Review results and decide pass or fail.", category: "review", reactMode: "by_order", maxOutputTokens: 2048 },
  { id: "researcher", displayName: "Researcher", description: "Collect findings, risks, and external context.", category: "research", reactMode: "react", maxOutputTokens: 4096 },

  // ─── Research Roles (react: dynamically decide next search) ────────────────
  { id: "repo-mapper", displayName: "Repo Mapper", description: "Map repository structure and identify hotspots.", category: "research", reactMode: "by_order" },
  { id: "search-specialist", displayName: "Search Specialist", description: "Find relevant files, symbols, and references quickly.", category: "research", reactMode: "react" },
  { id: "dependency-analyst", displayName: "Dependency Analyst", description: "Inspect dependency shape and upgrade risk.", category: "research", reactMode: "react" },
  { id: "security-auditor", displayName: "Security Auditor", description: "Spot dangerous flows, insecure defaults, and abuse paths.", category: "research", reactMode: "react" },
  { id: "risk-analyst", displayName: "Risk Analyst", description: "Surface tradeoffs, regression vectors, and unknowns.", category: "research", reactMode: "by_order" },
  { id: "benchmark-analyst", displayName: "Benchmark Analyst", description: "Measure outputs and compare candidate approaches.", category: "research", reactMode: "react" },
  { id: "issue-triage-agent", displayName: "Issue Triage Agent", description: "Normalize bug reports into actionable work items.", category: "research", reactMode: "by_order" },

  // ─── Planning Roles (plan_and_act: structured output) ──────────────────────
  { id: "api-designer", displayName: "API Designer", description: "Shape request/response contracts and boundaries.", category: "planning", reactMode: "plan_and_act" },
  { id: "docs-writer", displayName: "Docs Writer", description: "Turn implementation into concise reference and guides.", category: "planning", reactMode: "by_order" },
  { id: "prompt-engineer", displayName: "Prompt Engineer", description: "Optimize prompts, schemas, and output contracts.", category: "planning", reactMode: "plan_and_act" },
  { id: "release-manager", displayName: "Release Manager", description: "Prepare release notes, versioning, and cut readiness.", category: "planning", reactMode: "by_order" },
  { id: "cost-optimizer", displayName: "Cost Optimizer", description: "Reduce model, infrastructure, and workflow cost.", category: "planning", reactMode: "by_order" },
  { id: "model-router", displayName: "Model Router", description: "Pick the best provider and model for a task class.", category: "planning", reactMode: "by_order" },
  { id: "git-strategist", displayName: "Git Strategist", description: "Shape branch, diff, and commit strategy.", category: "planning", reactMode: "plan_and_act" },
  { id: "pr-author", displayName: "PR Author", description: "Write high-signal pull request descriptions and change summaries.", category: "planning", reactMode: "by_order" },

  // ─── Execution Roles (react: tool-using, iterative) ────────────────────────
  { id: "lsp-analyst", displayName: "LSP Analyst", description: "Interpret diagnostics and symbol relationships.", category: "execution", reactMode: "react" },
  { id: "ast-rewriter", displayName: "AST Rewriter", description: "Plan structured code transformations.", category: "execution", reactMode: "plan_and_act" },
  { id: "build-doctor", displayName: "Build Doctor", description: "Diagnose build failures and unblock the toolchain.", category: "execution", reactMode: "react", maxOutputTokens: 4096 },
  { id: "test-engineer", displayName: "Test Engineer", description: "Design tests, failure checks, and verification flows.", category: "execution", reactMode: "react", maxOutputTokens: 6144 },
  { id: "debugger", displayName: "Debugger", description: "Trace root causes and isolate faults.", category: "execution", reactMode: "react", maxOutputTokens: 4096 },
  { id: "backend-engineer", displayName: "Backend Engineer", description: "Implement backend flows, services, and handlers.", category: "execution", reactMode: "react", maxOutputTokens: 8192 },
  { id: "db-engineer", displayName: "DB Engineer", description: "Design storage changes and migration safety.", category: "execution", reactMode: "plan_and_act" },
  { id: "performance-engineer", displayName: "Performance Engineer", description: "Profile hotspots and reduce waste.", category: "execution", reactMode: "react" },
  { id: "devops-engineer", displayName: "DevOps Engineer", description: "Handle automation, environments, and delivery mechanics.", category: "execution", reactMode: "plan_and_act" },
  { id: "cicd-engineer", displayName: "CI/CD Engineer", description: "Improve pipelines, checks, and release confidence.", category: "execution", reactMode: "plan_and_act" },
  { id: "observability-engineer", displayName: "Observability Engineer", description: "Add logs, metrics, and debuggability.", category: "execution", reactMode: "by_order" },
  { id: "refactor-specialist", displayName: "Refactor Specialist", description: "Restructure code with minimal behavior drift.", category: "execution", reactMode: "plan_and_act" },
  { id: "code-simplifier", displayName: "Code Simplifier", description: "Remove complexity and reduce cognitive load.", category: "execution", reactMode: "by_order" },
  { id: "migration-engineer", displayName: "Migration Engineer", description: "Plan and execute version or schema migrations.", category: "execution", reactMode: "plan_and_act" },
  { id: "toolsmith", displayName: "Toolsmith", description: "Create or adapt tools and agent capabilities.", category: "execution", reactMode: "react", maxOutputTokens: 8192 },

  // ─── Frontend Roles ────────────────────────────────────────────────────────
  { id: "frontend-engineer", displayName: "Frontend Engineer", description: "Implement UI behavior and component changes.", category: "frontend", reactMode: "react", maxOutputTokens: 8192 },
  { id: "ux-designer", displayName: "UX Designer", description: "Improve interaction flow, copy, and layout direction.", category: "frontend", reactMode: "by_order" },
  { id: "accessibility-auditor", displayName: "Accessibility Auditor", description: "Find usability and accessibility regressions.", category: "frontend", reactMode: "by_order" },
  { id: "browser-operator", displayName: "Browser Operator", description: "Drive browser tasks and inspect runtime UI behavior.", category: "frontend", reactMode: "react" },

  // ─── Review Roles ──────────────────────────────────────────────────────────
  { id: "compliance-reviewer", displayName: "Compliance Reviewer", description: "Check policy, process, and controls consistency.", category: "review", reactMode: "by_order" }
];

function createRolePrompt(seed: RoleSeed): string {
  return [
    `You are ${seed.displayName}.`,
    seed.description,
    ...(ROLE_DIRECTIVES[seed.id] ?? []),
    "Return only valid JSON.",
    "Keep answers concise, implementation-focused, and deterministic."
  ].join("\n");
}

function createToolPolicy(category: RoleCategory) {
  if (category === "frontend") {
    return { allowed: ["read", "write", "apply_patch", "browser", "grep", "glob", "repo_map", "session_history", "lsp_symbols"] };
  }
  if (category === "research" || category === "planning") {
    return { allowed: ["read", "grep", "glob", "repo_map", "session_history"] };
  }
  return { allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "git", "repo_map", "session_history", "lsp_diagnostics", "lsp_symbols"] };
}

const ROLE_TOOL_OVERRIDES: Record<string, { allowed?: string[]; denied?: string[] }> = {
  "build-doctor": {
    allowed: ["read", "grep", "glob", "bash", "repo_map", "session_history", "lsp_diagnostics", "lsp_symbols"]
  },
  "test-engineer": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "repo_map", "session_history", "ast_grep"]
  },
  debugger: {
    allowed: ["read", "grep", "glob", "bash", "repo_map", "session_history", "lsp_diagnostics", "lsp_symbols", "ast_grep"]
  },
  "security-auditor": {
    allowed: ["read", "grep", "glob", "repo_map", "session_history", "browser", "ast_grep", "web_search"]
  },
  "browser-operator": {
    allowed: ["read", "browser", "grep", "glob", "repo_map", "session_history"]
  },
  "docs-writer": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "repo_map", "session_history", "web_search"]
  },
  "pr-author": {
    allowed: ["read", "git", "repo_map", "session_history"]
  },
  "git-strategist": {
    allowed: ["read", "git", "repo_map", "session_history"]
  },
  "compliance-reviewer": {
    allowed: ["read", "grep", "glob", "repo_map", "session_history"]
  },
  "refactor-specialist": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "repo_map", "session_history", "ast_grep", "lsp_diagnostics", "lsp_symbols"]
  },
  "backend-engineer": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "git", "repo_map", "session_history", "lsp_diagnostics", "lsp_symbols", "web_search"]
  },
  "dependency-analyst": {
    allowed: ["read", "grep", "glob", "bash", "repo_map", "session_history", "web_search"]
  },
  researcher: {
    allowed: ["read", "grep", "glob", "repo_map", "session_history", "web_search", "ast_grep"]
  },
  "performance-engineer": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "repo_map", "session_history", "lsp_diagnostics", "ast_grep"]
  },
  "observability-engineer": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "repo_map", "session_history"]
  },
  "toolsmith": {
    allowed: ["read", "write", "apply_patch", "grep", "glob", "bash", "git", "repo_map", "session_history", "lsp_diagnostics", "lsp_symbols", "ast_grep", "web_search"]
  }
};

export function getRoleRegistry(config: AgentConfig): RoleDefinition[] {
  const active = new Set(config.roles.active.map((value) => value.toLowerCase()));
  return ROLE_SEEDS.map((seed) => ({
    id: seed.id,
    displayName: seed.displayName,
    description: seed.description,
    active: active.has(seed.id),
    aliases: [seed.id, seed.displayName.toLowerCase(), ...(seed.aliases ?? [])],
    category: seed.category,
    prompt: createRolePrompt(seed),
    toolPolicy: {
      ...createToolPolicy(seed.category),
      ...(ROLE_TOOL_OVERRIDES[seed.id] ?? {})
    },
    reactMode: seed.reactMode ?? "by_order",
    maxOutputTokens: seed.maxOutputTokens
  }));
}

export function resolveRole(registry: RoleDefinition[], requestedRole: string): RoleDefinition {
  const normalized = normalizeRoleHint(requestedRole.trim().toLowerCase());
  const direct = registry.find((role) => role.id === normalized || role.aliases.includes(normalized));
  if (!direct) {
    // Fuzzy match: find closest role by partial match
    const fuzzy = registry.find((role) =>
      role.id.includes(normalized) || normalized.includes(role.id) ||
      role.aliases.some(a => a.includes(normalized) || normalized.includes(a))
    );
    if (fuzzy) return fuzzy.active ? fuzzy : { ...fuzzy, active: true };

    // Last resort: default to executor
    const fallback = registry.find((role) => role.id === "executor");
    if (fallback) return fallback.active ? fallback : { ...fallback, active: true };

    throw new Error(`Unknown role: ${requestedRole}`);
  }
  if (direct.active) {
    return direct;
  }
  // Role is defined but not in the active set — activate it on demand.
  // This allows delegation to use any of the 40 roles even when only
  // a subset is in the config's active list.
  return {
    ...direct,
    active: true
  };
}

/**
 * Normalize common roleHint patterns that LLMs produce.
 * Maps slash-based, abbreviated, and informal names to actual role IDs.
 */
function normalizeRoleHint(hint: string): string {
  const MAP: Record<string, string> = {
    // CI/CD aliases
    "ci/cd": "cicd-engineer", "cicd": "cicd-engineer", "ci": "cicd-engineer", "ci-cd": "cicd-engineer", "ci-cd-specialist": "cicd-engineer",
    // Security
    "security": "security-auditor", "sec": "security-auditor",
    // Performance
    "performance": "performance-engineer", "perf": "performance-engineer",
    // Observability
    "observability": "observability-engineer", "o11y": "observability-engineer",
    // DevOps
    "devops": "devops-engineer", "ops": "devops-engineer",
    // Migration
    "migration": "migration-engineer", "migrate": "migration-engineer",
    // Git
    "git": "git-strategist", "git-expert": "git-strategist",
    // PR
    "pr": "pr-author",
    // API
    "api": "api-designer",
    // Database
    "db": "db-engineer", "database": "db-engineer", "db-specialist": "db-engineer",
    // Browser
    "browser": "browser-operator",
    // Accessibility
    "a11y": "accessibility-auditor", "accessibility": "accessibility-auditor",
    // Cost
    "cost": "cost-optimizer", "cost-analyst": "cost-optimizer",
    // Compliance
    "compliance": "compliance-reviewer", "compliance-officer": "compliance-reviewer",
    // Docs
    "docs": "docs-writer", "documentation": "docs-writer",
    // Test
    "test": "test-engineer", "testing": "test-engineer",
    // Debug
    "debug": "debugger",
    // Refactor
    "refactor": "refactor-specialist",
    // Frontend/Backend
    "frontend": "frontend-engineer", "backend": "backend-engineer",
    // Model
    "model-router": "model-router",
    // Dependencies
    "deps": "dependency-analyst", "dependencies": "dependency-analyst",
    // Build
    "build": "build-doctor", "build-doctor": "build-doctor",
    // Code simplifier
    "simplify": "code-simplifier", "cleanup": "code-simplifier"
  };
  return MAP[hint] ?? hint;
}

export function listActiveRoles(registry: RoleDefinition[]): RoleDefinition[] {
  return registry.filter((role) => role.active);
}
