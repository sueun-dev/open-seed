import type {
  PlannerTask,
  SpecialistArtifact,
  RoleCategory,
  RoleDefinition,
  SpecialistContractKind
} from "../core/types.js";
import { resolveRole } from "../roles/registry.js";
import {
  artifactDetails,
  buildSpecialistContractInstructions,
  getSpecialistContractKind,
  mergeSpecialistArtifact,
  type DelegationMerge
} from "./contracts.js";

type RoleRule = {
  roleId: string;
  category: RoleCategory;
  patterns: RegExp[];
};

export interface DelegationAssignment {
  role: RoleDefinition;
  task: PlannerTask;
}

export interface DelegationNote {
  roleId: string;
  displayName: string;
  taskId: string;
  taskTitle: string;
  category: RoleCategory;
  contractKind: SpecialistContractKind;
  summary: string;
  details: string[];
}

export interface DelegationOutcome {
  assignment: DelegationAssignment;
  artifact: SpecialistArtifact;
  note: DelegationNote;
}

const ROLE_RULES: RoleRule[] = [
  { roleId: "repo-mapper", category: "research", patterns: [/repo map|repository structure|hotspot|surface area/i] },
  { roleId: "search-specialist", category: "research", patterns: [/search|find files|references|grep|locate/i] },
  { roleId: "dependency-analyst", category: "research", patterns: [/dependenc|package|upgrade|version|library/i] },
  { roleId: "security-auditor", category: "research", patterns: [/security|auth|permission|injection|secret|oauth|token/i] },
  { roleId: "risk-analyst", category: "research", patterns: [/risk|regression|tradeoff|unknown/i] },
  { roleId: "benchmark-analyst", category: "research", patterns: [/benchmark|measure|compare|latency|throughput/i] },
  { roleId: "issue-triage-agent", category: "research", patterns: [/triage|bug report|repro|issue/i] },
  { roleId: "api-designer", category: "planning", patterns: [/api|contract|schema|endpoint|interface/i] },
  { roleId: "docs-writer", category: "planning", patterns: [/docs|documentation|readme|guide|explain/i] },
  { roleId: "prompt-engineer", category: "planning", patterns: [/prompt|schema|json output|instruction/i] },
  { roleId: "release-manager", category: "planning", patterns: [/release|version|ship|cut|changelog/i] },
  { roleId: "cost-optimizer", category: "planning", patterns: [/cost|cheap|budget|token usage/i] },
  { roleId: "model-router", category: "planning", patterns: [/provider|model|route|fallback/i] },
  { roleId: "git-strategist", category: "planning", patterns: [/git|branch|commit|rebase|diff/i] },
  { roleId: "pr-author", category: "planning", patterns: [/pull request|pr |pr$|summary|release notes/i] },
  { roleId: "lsp-analyst", category: "execution", patterns: [/lsp|symbol|definition|references|diagnostic/i] },
  { roleId: "ast-rewriter", category: "execution", patterns: [/ast|codemod|rewrite|transform/i] },
  { roleId: "build-doctor", category: "execution", patterns: [/build|compile|typecheck|tsc|bundle/i] },
  { roleId: "test-engineer", category: "execution", patterns: [/test|verification|assert|coverage/i] },
  { roleId: "debugger", category: "execution", patterns: [/debug|root cause|trace|fault|fix failure/i] },
  { roleId: "backend-engineer", category: "execution", patterns: [/backend|server|handler|service|route/i] },
  { roleId: "db-engineer", category: "execution", patterns: [/db|database|sql|migration|schema/i] },
  { roleId: "performance-engineer", category: "execution", patterns: [/performance|optimi[sz]e|memory|cpu|speed/i] },
  { roleId: "devops-engineer", category: "execution", patterns: [/infra|environment|deploy|ops|docker/i] },
  { roleId: "cicd-engineer", category: "execution", patterns: [/ci|cd|pipeline|workflow|github actions/i] },
  { roleId: "observability-engineer", category: "execution", patterns: [/logging|metrics|trace|observability|telemetry/i] },
  { roleId: "refactor-specialist", category: "execution", patterns: [/refactor|restructure|extract|cleanup/i] },
  { roleId: "code-simplifier", category: "execution", patterns: [/simplify|reduce complexity|cleaner|smaller/i] },
  { roleId: "migration-engineer", category: "execution", patterns: [/migrat|upgrade path|rollout/i] },
  { roleId: "toolsmith", category: "execution", patterns: [/tool|runtime|adapter|integration|automation/i] },
  { roleId: "frontend-engineer", category: "frontend", patterns: [/frontend|ui|component|layout|visual|css/i] },
  { roleId: "ux-designer", category: "frontend", patterns: [/ux|copy|flow|interaction|experience/i] },
  { roleId: "accessibility-auditor", category: "frontend", patterns: [/a11y|accessibility|keyboard|screen reader|contrast/i] },
  { roleId: "browser-operator", category: "frontend", patterns: [/browser|screenshot|dom|console|network/i] },
  { roleId: "compliance-reviewer", category: "review", patterns: [/compliance|policy|control|governance/i] }
];

type RootInferenceRule = {
  roleId: string;
  category: RoleCategory;
  title: string;
  patterns: RegExp[];
};

const ROOT_INFERENCE_RULES: RootInferenceRule[] = [
  { roleId: "security-auditor", category: "research", title: "Audit auth, token, and security boundaries", patterns: [/\b(auth|oauth|token|secret|security|permission|injection)\b/i] },
  { roleId: "performance-engineer", category: "execution", title: "Profile and optimize the hot path", patterns: [/\b(performance|latency|throughput|slow|speed|memory|cpu)\b/i] },
  { roleId: "observability-engineer", category: "execution", title: "Add logs, metrics, and traceability", patterns: [/\b(observability|telemetry|metrics|logging|trace)\b/i] },
  { roleId: "devops-engineer", category: "execution", title: "Harden environment and deployment mechanics", patterns: [/\b(deploy|infra|docker|kubernetes|ops|environment)\b/i] },
  { roleId: "cicd-engineer", category: "execution", title: "Improve pipeline and release automation", patterns: [/\b(ci|cd|pipeline|workflow|github actions)\b/i] },
  { roleId: "migration-engineer", category: "execution", title: "Plan and execute the migration safely", patterns: [/\b(migrate|migration|upgrade path|rollout|backfill)\b/i] },
  { roleId: "git-strategist", category: "planning", title: "Shape branch, diff, and commit strategy", patterns: [/\b(git|branch|commit|rebase|diff)\b/i] },
  { roleId: "pr-author", category: "planning", title: "Prepare pull request summary and rollout notes", patterns: [/\b(pull request|release notes|change summary|pr\b)\b/i] },
  { roleId: "api-designer", category: "planning", title: "Design the API contract and boundaries", patterns: [/\b(api|endpoint|schema|contract|interface)\b/i] },
  { roleId: "db-engineer", category: "execution", title: "Handle database and schema work", patterns: [/\b(database|db|sql|query|schema)\b/i] },
  { roleId: "browser-operator", category: "frontend", title: "Inspect and drive the browser runtime", patterns: [/\b(browser|screenshot|dom|console|network)\b/i] },
  { roleId: "accessibility-auditor", category: "frontend", title: "Audit accessibility and keyboard flow", patterns: [/\b(a11y|accessibility|screen reader|contrast|keyboard)\b/i] },
  { roleId: "cost-optimizer", category: "planning", title: "Reduce provider and runtime cost", patterns: [/\b(cost|budget|cheap|token usage)\b/i] },
  { roleId: "model-router", category: "planning", title: "Refine model and provider routing", patterns: [/\b(provider|model|routing|fallback|failover)\b/i] },
  { roleId: "compliance-reviewer", category: "review", title: "Check policy and compliance constraints", patterns: [/\b(compliance|policy|governance|control)\b/i] }
];

function getCategoryFallback(category: RoleCategory): string {
  switch (category) {
    case "planning":
      return "docs-writer";
    case "research":
      return "search-specialist";
    case "execution":
      return "toolsmith";
    case "frontend":
      return "browser-operator";
    case "review":
      return "compliance-reviewer";
  }
}

export function chooseRoleIdForTask(task: PlannerTask): string {
  if (task.roleHint) {
    return task.roleHint;
  }
  const title = task.title.trim();
  for (const rule of ROLE_RULES) {
    if (rule.category !== task.category) {
      continue;
    }
    if (rule.patterns.some((pattern) => pattern.test(title))) {
      return rule.roleId;
    }
  }
  return getCategoryFallback(task.category);
}

export function selectDelegationAssignments(params: {
  tasks: PlannerTask[];
  registry: RoleDefinition[];
  limit: number;
}): DelegationAssignment[] {
  const assignments: DelegationAssignment[] = [];
  const seenRoleIds = new Set<string>();
  const rankedTasks = [...params.tasks].sort((left, right) => scoreTask(right) - scoreTask(left));
  for (const task of rankedTasks) {
    if (assignments.length >= params.limit) {
      break;
    }
    const roleId = chooseRoleIdForTask(task);
    if (seenRoleIds.has(roleId)) {
      continue;
    }
    assignments.push({
      task,
      role: resolveRole(params.registry, roleId)
    });
    seenRoleIds.add(roleId);
  }
  return assignments;
}

export function augmentPlannerTasks(rootTask: string, tasks: PlannerTask[]): PlannerTask[] {
  const merged = [...tasks];
  const seenKeys = new Set(tasks.map((task) => createTaskKey(task)));

  for (const rule of ROOT_INFERENCE_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(rootTask))) {
      continue;
    }
    const inferredTask: PlannerTask = {
      id: `infer-${rule.roleId}`,
      title: rule.title,
      category: rule.category,
      roleHint: rule.roleId
    };
    const key = createTaskKey(inferredTask);
    if (seenKeys.has(key)) {
      continue;
    }
    merged.push(inferredTask);
    seenKeys.add(key);
  }

  return merged;
}

function scoreTask(task: PlannerTask): number {
  const title = task.title.toLowerCase();
  let score = 0;
  if (task.roleHint) {
    score += 10;
  }
  if (title.startsWith("inspect relevant files for:")) {
    score -= 60;
  }
  switch (task.category) {
    case "execution":
      score += 80;
      break;
    case "frontend":
      score += 70;
      break;
    case "planning":
      score += 65;
      break;
    case "research":
      score += 50;
      break;
    case "review":
      score += 10;
      break;
  }
  if (/build|typecheck|compile|test|docs|migration|release|performance|security/i.test(task.title)) {
    score += 10;
  }
  return score;
}

export function buildDelegationPrompt(params: {
  rootTask: string;
  assignment: DelegationAssignment;
  plannerSummary: string;
  researchSummary?: string;
  context: string;
  repoSummary: string;
}): string {
  return [
    params.context,
    `Root task: ${params.rootTask}`,
    `Delegated specialist task: ${params.assignment.task.title}`,
    `Planner summary: ${params.plannerSummary}`,
    params.researchSummary ? `Research summary: ${params.researchSummary}` : "",
    `Specialist role: ${params.assignment.role.displayName}`,
    `Specialist contract kind: ${getSpecialistContractKind(params.assignment.role)}`,
    "Repository summary:",
    params.repoSummary,
    "",
    "Produce a focused contribution from your specialist perspective.",
    "Keep the output scoped to the delegated task.",
    buildSpecialistContractInstructions(params.assignment.role)
  ].filter(Boolean).join("\n");
}

export function summarizeDelegationArtifacts(outcomes: DelegationOutcome[]): string {
  if (outcomes.length === 0) {
    return "";
  }
  const notes = outcomes.map((outcome) => outcome.note);
  const merged = mergeDelegationOutcomes(outcomes);
  return [
    "Specialist context:",
    ...notes.map((note) => {
      const detailText = note.details.length > 0 ? ` Details: ${note.details.join(" | ")}` : "";
      return `- ${note.displayName} [${note.contractKind}] on "${note.taskTitle}": ${note.summary}.${detailText}`;
    }),
    ...renderDelegationMergeSections(merged)
  ].join("\n");
}

export function createDelegationNote(params: {
  assignment: DelegationAssignment;
  artifact: SpecialistArtifact;
}): DelegationNote {
  return {
    roleId: params.assignment.role.id,
    displayName: params.assignment.role.displayName,
    taskId: params.assignment.task.id,
    taskTitle: params.assignment.task.title,
    category: params.assignment.task.category,
    contractKind: params.artifact.kind,
    summary: params.artifact.summary,
    details: artifactDetails(params.artifact).slice(0, 6)
  };
}

export function mergeDelegationOutcomes(outcomes: DelegationOutcome[]): DelegationMerge {
  const merged: DelegationMerge = {
    implementation: [],
    verification: [],
    risks: [],
    delivery: []
  };

  for (const outcome of outcomes) {
    const contribution = mergeSpecialistArtifact(outcome.artifact);
    merged.implementation.push(...contribution.implementation);
    merged.verification.push(...contribution.verification);
    merged.risks.push(...contribution.risks);
    merged.delivery.push(...contribution.delivery);
  }

  return {
    implementation: dedupeStrings(merged.implementation),
    verification: dedupeStrings(merged.verification),
    risks: dedupeStrings(merged.risks),
    delivery: dedupeStrings(merged.delivery)
  };
}

function renderDelegationMergeSections(merged: DelegationMerge): string[] {
  const lines: string[] = [];
  appendSection(lines, "Implementation guidance", merged.implementation);
  appendSection(lines, "Verification guidance", merged.verification);
  appendSection(lines, "Risk controls", merged.risks);
  appendSection(lines, "Delivery guidance", merged.delivery);
  return lines;
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  entries.forEach((entry) => {
    lines.push(`- ${entry}`);
  });
}

function dedupeStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
}

function createTaskKey(task: PlannerTask): string {
  return `${task.category}:${task.roleHint ?? ""}:${task.title.trim().toLowerCase()}`;
}
