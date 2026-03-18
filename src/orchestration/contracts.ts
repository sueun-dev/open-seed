import type {
  AccessibilityArtifact,
  ApiArtifact,
  BrowserArtifact,
  BuildArtifact,
  CiCdArtifact,
  ComplianceArtifact,
  CostArtifact,
  DatabaseArtifact,
  DevOpsArtifact,
  DocumentationArtifact,
  ExecutorArtifact,
  GitArtifact,
  MigrationArtifact,
  ModelRoutingArtifact,
  ObservabilityArtifact,
  PerformanceArtifact,
  PlanningNoteArtifact,
  PrArtifact,
  ResearchNoteArtifact,
  RoleDefinition,
  SecurityArtifact,
  SpecialistArtifact,
  SpecialistContractKind,
  TestArtifact,
  ToolBearingArtifact,
  ToolCall
} from "../core/types.js";

export interface DelegationMerge {
  implementation: string[];
  verification: string[];
  risks: string[];
  delivery: string[];
}

type ContractDefinition<T extends SpecialistArtifact = SpecialistArtifact> = {
  kind: SpecialistContractKind;
  schema: string;
  normalize: (raw: unknown) => T;
  details: (artifact: any) => string[];
  merge: (artifact: any) => DelegationMerge;
  createMock: (prompt: string, toolCalls: ToolCall[]) => T;
};

const ROLE_KIND_OVERRIDES: Record<string, SpecialistContractKind> = {
  "docs-writer": "documentation-plan",
  "build-doctor": "build-plan",
  "test-engineer": "test-plan",
  "security-auditor": "security-review",
  "performance-engineer": "performance-plan",
  "observability-engineer": "observability-plan",
  "devops-engineer": "devops-plan",
  "cicd-engineer": "cicd-plan",
  "migration-engineer": "migration-plan",
  "git-strategist": "git-plan",
  "pr-author": "pr-plan",
  "api-designer": "api-plan",
  "db-engineer": "db-plan",
  "browser-operator": "browser-report",
  "accessibility-auditor": "accessibility-report",
  "cost-optimizer": "cost-plan",
  "model-router": "model-routing-plan",
  "compliance-reviewer": "compliance-review"
};

function fallbackKindForCategory(role: Pick<RoleDefinition, "category">): SpecialistContractKind {
  switch (role.category) {
    case "planning":
      return "planning-note";
    case "research":
      return "research-note";
    case "execution":
      return "execution";
    case "frontend":
      return "browser-report";
    case "review":
      return "compliance-review";
  }
}

export function getSpecialistContractKind(role: Pick<RoleDefinition, "id" | "category">): SpecialistContractKind {
  return ROLE_KIND_OVERRIDES[role.id] ?? fallbackKindForCategory(role);
}

export function buildSpecialistContractInstructions(role: Pick<RoleDefinition, "id" | "category">): string {
  return `Return JSON: ${CONTRACT_DEFINITIONS[getSpecialistContractKind(role)].schema}`;
}

export function normalizeSpecialistArtifact(role: Pick<RoleDefinition, "id" | "category">, raw: unknown): SpecialistArtifact {
  return CONTRACT_DEFINITIONS[getSpecialistContractKind(role)].normalize(raw);
}

export function createMockSpecialistArtifact(params: {
  roleId: string;
  category: RoleDefinition["category"];
  prompt: string;
  toolCalls?: ToolCall[];
}): SpecialistArtifact {
  const role = { id: params.roleId, category: params.category };
  return CONTRACT_DEFINITIONS[getSpecialistContractKind(role)].createMock(
    params.prompt,
    params.toolCalls ?? []
  );
}

export function artifactDetails(artifact: SpecialistArtifact): string[] {
  return CONTRACT_DEFINITIONS[artifact.kind].details(artifact as never);
}

export function mergeSpecialistArtifact(artifact: SpecialistArtifact): DelegationMerge {
  return CONTRACT_DEFINITIONS[artifact.kind].merge(artifact as never);
}

export function isToolBearingArtifact(artifact: unknown): artifact is ToolBearingArtifact {
  return typeof artifact === "object"
    && artifact !== null
    && ("toolCalls" in artifact || "suggestedCommands" in artifact || "toolResults" in artifact);
}

function createEmptyMerge(): DelegationMerge {
  return {
    implementation: [],
    verification: [],
    risks: [],
    delivery: []
  };
}

function mergeFromFields(fields: Partial<DelegationMerge>): DelegationMerge {
  return {
    ...createEmptyMerge(),
    ...fields
  };
}

function asObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const calls = value
    .map((entry) => asObject(entry))
    .filter((entry) => typeof entry.name === "string" && typeof entry.reason === "string")
    .map((entry) => ({
      name: entry.name as ToolCall["name"],
      reason: entry.reason as string,
      input: asObject(entry.input)
    }));
  return calls.length > 0 ? calls : undefined;
}

function toolFields(raw: Record<string, unknown>): Pick<ToolBearingArtifact, "summary" | "suggestedCommands" | "toolCalls"> {
  return {
    summary: asString(raw.summary, "Produced a specialist artifact."),
    suggestedCommands: asStringArray(raw.suggestedCommands),
    toolCalls: asToolCalls(raw.toolCalls)
  };
}

function focusFromPrompt(prompt: string): string {
  return prompt.match(/(?:Root task|Task|Delegated specialist task):\s*(.+)$/m)?.[1]
    ?? prompt.split("\n").find((line) => line.trim().length > 0)
    ?? "the delegated task";
}

function mockSuggestedCommands(prompt: string): string[] {
  const focus = focusFromPrompt(prompt);
  const commands: string[] = [];
  if (/\bnpm test\b|\btest\b/i.test(focus)) {
    commands.push("npm test");
  }
  if (/\bnpm run build\b|\bbuild\b|\btypecheck\b|\btsc\b/i.test(focus)) {
    commands.push("npm run build");
  }
  return commands;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
}

const CONTRACT_DEFINITIONS: Record<SpecialistContractKind, ContractDefinition> = {
  execution: {
    kind: "execution",
    schema: "{\"kind\":\"execution\",\"summary\":string,\"changes\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: ExecutorArtifact = {
        kind: "execution",
        summary: base.summary,
        changes: asStringArray(value.changes),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.changes, ...(artifact.suggestedCommands ?? [])].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.changes,
        verification: artifact.suggestedCommands ?? []
      });
    },
    createMock(prompt, toolCalls) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "execution",
        summary: `Prepared implementation work for ${focus}`,
        changes: [
          `Scoped the main implementation path for ${focus}`,
          toolCalls.length > 0 ? "Prepared concrete tool calls for execution" : "Outlined the concrete code changes first"
        ],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "planning-note": {
    kind: "planning-note",
    schema: "{\"kind\":\"planning-note\",\"summary\":string,\"decisions\":string[],\"deliverables\":string[],\"openQuestions\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: PlanningNoteArtifact = {
        kind: "planning-note",
        summary: base.summary,
        decisions: asStringArray(value.decisions),
        deliverables: asStringArray(value.deliverables),
        openQuestions: asStringArray(value.openQuestions),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.decisions, ...artifact.deliverables, ...artifact.openQuestions].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.decisions,
        delivery: artifact.deliverables,
        risks: artifact.openQuestions,
        verification: artifact.suggestedCommands ?? []
      });
    },
    createMock(prompt, toolCalls) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "planning-note",
        summary: `Framed the planning decisions for ${focus}`,
        decisions: ["Clarified ownership boundaries", "Split the task into reviewable slices"],
        deliverables: ["Implementation checklist", "Verification checklist"],
        openQuestions: ["Confirm edge cases before shipping"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "research-note": {
    kind: "research-note",
    schema: "{\"kind\":\"research-note\",\"summary\":string,\"findings\":string[],\"risks\":string[],\"openQuestions\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: ResearchNoteArtifact = {
        kind: "research-note",
        summary: asString(value.summary, "Prepared the research brief."),
        findings: asStringArray(value.findings),
        risks: asStringArray(value.risks),
        openQuestions: asStringArray(value.openQuestions)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.findings, ...artifact.risks, ...artifact.openQuestions].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.findings,
        risks: dedupe([...artifact.risks, ...artifact.openQuestions])
      });
    },
    createMock(prompt) {
      return {
        kind: "research-note",
        summary: `Prepared the research brief for ${focusFromPrompt(prompt)}`,
        findings: ["Mapped the most relevant files and ownership boundaries"],
        risks: ["Some assumptions still depend on local verification"],
        openQuestions: ["Confirm the exact failure mode before broadening the fix"]
      };
    }
  },
  "documentation-plan": {
    kind: "documentation-plan",
    schema: "{\"kind\":\"documentation-plan\",\"summary\":string,\"audience\":string[],\"docChanges\":string[],\"deliverables\":string[],\"followUp\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: DocumentationArtifact = {
        kind: "documentation-plan",
        summary: base.summary,
        audience: asStringArray(value.audience),
        docChanges: asStringArray(value.docChanges),
        deliverables: asStringArray(value.deliverables),
        followUp: asStringArray(value.followUp),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.docChanges, ...artifact.deliverables, ...artifact.followUp].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.docChanges,
        delivery: artifact.deliverables,
        verification: artifact.suggestedCommands ?? [],
        risks: artifact.followUp
      });
    },
    createMock(prompt, toolCalls) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "documentation-plan",
        summary: `Prepared the docs update plan for ${focus}`,
        audience: ["Developers using the CLI", "Reviewers validating the change"],
        docChanges: ["Update README examples", "Document the new specialist workflow"],
        deliverables: ["README diff summary", "User-facing behavior notes"],
        followUp: ["Call out any new environment prerequisites"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "build-plan": {
    kind: "build-plan",
    schema: "{\"kind\":\"build-plan\",\"summary\":string,\"failures\":string[],\"fixes\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: BuildArtifact = {
        kind: "build-plan",
        summary: base.summary,
        failures: asStringArray(value.failures),
        fixes: asStringArray(value.fixes),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.failures, ...artifact.fixes, ...artifact.verification].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.fixes,
        risks: artifact.failures,
        verification: dedupe([...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "build-plan",
        summary: `Mapped the shortest path to a green build for ${focus}`,
        failures: ["Current build and typecheck path are not yet trusted"],
        fixes: ["Repair the failing module or export path", "Keep the fix constrained to the broken surface"],
        verification: ["Run npm run build", "Run the relevant typecheck command"],
        suggestedCommands: dedupe(["npm run build", ...mockSuggestedCommands(prompt)]),
        toolCalls
      };
    }
  },
  "test-plan": {
    kind: "test-plan",
    schema: "{\"kind\":\"test-plan\",\"summary\":string,\"coverage\":string[],\"scenarios\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: TestArtifact = {
        kind: "test-plan",
        summary: base.summary,
        coverage: asStringArray(value.coverage),
        scenarios: asStringArray(value.scenarios),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.coverage, ...artifact.scenarios, ...artifact.verification].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.coverage,
        verification: dedupe([...artifact.scenarios, ...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "test-plan",
        summary: `Defined the verification loop for ${focusFromPrompt(prompt)}`,
        coverage: ["Add focused regression coverage", "Keep the fixture close to the changed behavior"],
        scenarios: ["Exercise the happy path", "Exercise the failure path"],
        verification: ["Run npm test", "Confirm the regression stays fixed"],
        suggestedCommands: dedupe(["npm test", ...mockSuggestedCommands(prompt)]),
        toolCalls
      };
    }
  },
  "security-review": {
    kind: "security-review",
    schema: "{\"kind\":\"security-review\",\"summary\":string,\"findings\":string[],\"risks\":string[],\"controls\":string[],\"verification\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: SecurityArtifact = {
        kind: "security-review",
        summary: asString(value.summary, "Completed a security review."),
        findings: asStringArray(value.findings),
        risks: asStringArray(value.risks),
        controls: asStringArray(value.controls),
        verification: asStringArray(value.verification)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.findings, ...artifact.risks, ...artifact.controls].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.controls,
        risks: dedupe([...artifact.findings, ...artifact.risks]),
        verification: artifact.verification
      });
    },
    createMock(prompt) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "security-review",
        summary: `Reviewed the security boundaries for ${focus}`,
        findings: ["Auth and token handling need explicit boundary checks"],
        risks: ["Leaking secrets or elevating privileges through weak defaults"],
        controls: ["Validate auth inputs", "Avoid logging raw secrets", "Make privileged actions explicit"],
        verification: ["Exercise auth failure paths", "Confirm secrets stay out of logs"]
      };
    }
  },
  "performance-plan": {
    kind: "performance-plan",
    schema: "{\"kind\":\"performance-plan\",\"summary\":string,\"hotspots\":string[],\"optimizations\":string[],\"benchmarks\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: PerformanceArtifact = {
        kind: "performance-plan",
        summary: base.summary,
        hotspots: asStringArray(value.hotspots),
        optimizations: asStringArray(value.optimizations),
        benchmarks: asStringArray(value.benchmarks),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.hotspots, ...artifact.optimizations, ...artifact.benchmarks].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.optimizations,
        risks: artifact.hotspots,
        verification: dedupe([...artifact.benchmarks, ...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "performance-plan",
        summary: `Isolated performance work for ${focusFromPrompt(prompt)}`,
        hotspots: ["The hot path should avoid unnecessary work and allocations"],
        optimizations: ["Measure first, then remove repeated work on the hot path"],
        benchmarks: ["Capture before/after latency", "Record the affected workflow timing"],
        verification: ["Confirm behavior is unchanged after optimization"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "observability-plan": {
    kind: "observability-plan",
    schema: "{\"kind\":\"observability-plan\",\"summary\":string,\"logs\":string[],\"metrics\":string[],\"traces\":string[],\"alerts\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: ObservabilityArtifact = {
        kind: "observability-plan",
        summary: base.summary,
        logs: asStringArray(value.logs),
        metrics: asStringArray(value.metrics),
        traces: asStringArray(value.traces),
        alerts: asStringArray(value.alerts),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.logs, ...artifact.metrics, ...artifact.traces, ...artifact.alerts].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.logs, ...artifact.metrics, ...artifact.traces]),
        verification: dedupe([...artifact.alerts, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "observability-plan",
        summary: `Prepared observability additions for ${focusFromPrompt(prompt)}`,
        logs: ["Log the key state transition with stable fields"],
        metrics: ["Count success and failure outcomes"],
        traces: ["Connect the operation to a trace/span boundary"],
        alerts: ["Define a signal for regressions or error spikes"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "devops-plan": {
    kind: "devops-plan",
    schema: "{\"kind\":\"devops-plan\",\"summary\":string,\"infrastructureChanges\":string[],\"rollout\":string[],\"safeguards\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: DevOpsArtifact = {
        kind: "devops-plan",
        summary: base.summary,
        infrastructureChanges: asStringArray(value.infrastructureChanges),
        rollout: asStringArray(value.rollout),
        safeguards: asStringArray(value.safeguards),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.infrastructureChanges, ...artifact.rollout, ...artifact.safeguards].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.infrastructureChanges, ...artifact.safeguards]),
        delivery: artifact.rollout,
        verification: dedupe([...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "devops-plan",
        summary: `Prepared the delivery mechanics for ${focusFromPrompt(prompt)}`,
        infrastructureChanges: ["Keep the environment config explicit and reproducible"],
        rollout: ["Roll out behind a safe sequence", "Prefer a reversible deployment step"],
        safeguards: ["Preserve defaults that keep local development boring"],
        verification: ["Smoke the changed environment path"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "cicd-plan": {
    kind: "cicd-plan",
    schema: "{\"kind\":\"cicd-plan\",\"summary\":string,\"pipelineChanges\":string[],\"checks\":string[],\"releaseSteps\":string[],\"rollback\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: CiCdArtifact = {
        kind: "cicd-plan",
        summary: base.summary,
        pipelineChanges: asStringArray(value.pipelineChanges),
        checks: asStringArray(value.checks),
        releaseSteps: asStringArray(value.releaseSteps),
        rollback: asStringArray(value.rollback),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.pipelineChanges, ...artifact.checks, ...artifact.releaseSteps].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.pipelineChanges, ...artifact.checks]),
        delivery: dedupe([...artifact.releaseSteps, ...artifact.rollback]),
        verification: artifact.suggestedCommands ?? []
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "cicd-plan",
        summary: `Prepared the CI/CD hardening plan for ${focusFromPrompt(prompt)}`,
        pipelineChanges: ["Add a focused build and test gate", "Keep the signal fast for contributors"],
        checks: ["Run the relevant verification steps in CI"],
        releaseSteps: ["Document the release path that uses the new checks"],
        rollback: ["Keep the previous workflow available until confidence is high"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "migration-plan": {
    kind: "migration-plan",
    schema: "{\"kind\":\"migration-plan\",\"summary\":string,\"phases\":string[],\"compatibility\":string[],\"rollback\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: MigrationArtifact = {
        kind: "migration-plan",
        summary: base.summary,
        phases: asStringArray(value.phases),
        compatibility: asStringArray(value.compatibility),
        rollback: asStringArray(value.rollback),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.phases, ...artifact.compatibility, ...artifact.rollback].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.phases, ...artifact.compatibility]),
        delivery: artifact.rollback,
        verification: dedupe([...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "migration-plan",
        summary: `Prepared the migration path for ${focusFromPrompt(prompt)}`,
        phases: ["Introduce the new path in parallel", "Shift traffic or callers gradually"],
        compatibility: ["Keep old and new shapes compatible during rollout"],
        rollback: ["Define the rollback trigger and reversal steps"],
        verification: ["Validate old and new flows before cutover"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "git-plan": {
    kind: "git-plan",
    schema: "{\"kind\":\"git-plan\",\"summary\":string,\"branchStrategy\":string[],\"commitPlan\":string[],\"diffFocus\":string[],\"risks\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: GitArtifact = {
        kind: "git-plan",
        summary: asString(value.summary, "Prepared the git strategy."),
        branchStrategy: asStringArray(value.branchStrategy),
        commitPlan: asStringArray(value.commitPlan),
        diffFocus: asStringArray(value.diffFocus),
        risks: asStringArray(value.risks)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.branchStrategy, ...artifact.commitPlan, ...artifact.diffFocus].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        delivery: dedupe([...artifact.branchStrategy, ...artifact.commitPlan, ...artifact.diffFocus]),
        risks: artifact.risks
      });
    },
    createMock(prompt) {
      return {
        kind: "git-plan",
        summary: `Prepared the git strategy for ${focusFromPrompt(prompt)}`,
        branchStrategy: ["Keep the branch focused on one logical change"],
        commitPlan: ["Separate structural changes from behavioral changes"],
        diffFocus: ["Keep review scope tight around the touched workflow"],
        risks: ["Avoid mixing unrelated cleanup into the same diff"]
      };
    }
  },
  "pr-plan": {
    kind: "pr-plan",
    schema: "{\"kind\":\"pr-plan\",\"summary\":string,\"title\":string,\"highlights\":string[],\"rolloutNotes\":string[],\"verification\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: PrArtifact = {
        kind: "pr-plan",
        summary: asString(value.summary, "Prepared the PR summary."),
        title: asString(value.title, "Summarize the change"),
        highlights: asStringArray(value.highlights),
        rolloutNotes: asStringArray(value.rolloutNotes),
        verification: asStringArray(value.verification)
      };
      return artifact;
    },
    details(artifact) {
      return [artifact.title, ...artifact.highlights, ...artifact.rolloutNotes].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        delivery: dedupe([artifact.title, ...artifact.highlights, ...artifact.rolloutNotes]),
        verification: artifact.verification
      });
    },
    createMock(prompt) {
      const focus = focusFromPrompt(prompt);
      return {
        kind: "pr-plan",
        summary: `Prepared the pull request summary for ${focus}`,
        title: "Summarize the specialist-driven implementation",
        highlights: ["Explain what changed", "Explain why the change is safe"],
        rolloutNotes: ["Call out operator impact and follow-up checks"],
        verification: mockSuggestedCommands(prompt)
      };
    }
  },
  "api-plan": {
    kind: "api-plan",
    schema: "{\"kind\":\"api-plan\",\"summary\":string,\"endpoints\":string[],\"schemaChanges\":string[],\"invariants\":string[],\"openQuestions\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: ApiArtifact = {
        kind: "api-plan",
        summary: asString(value.summary, "Prepared the API contract."),
        endpoints: asStringArray(value.endpoints),
        schemaChanges: asStringArray(value.schemaChanges),
        invariants: asStringArray(value.invariants),
        openQuestions: asStringArray(value.openQuestions)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.endpoints, ...artifact.schemaChanges, ...artifact.invariants].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.endpoints, ...artifact.schemaChanges, ...artifact.invariants]),
        risks: artifact.openQuestions
      });
    },
    createMock(prompt) {
      return {
        kind: "api-plan",
        summary: `Prepared the API boundary for ${focusFromPrompt(prompt)}`,
        endpoints: ["Define the affected endpoint or handler boundary"],
        schemaChanges: ["Document request and response changes explicitly"],
        invariants: ["Keep compatibility and validation rules explicit"],
        openQuestions: ["Confirm downstream consumers before finalizing the shape"]
      };
    }
  },
  "db-plan": {
    kind: "db-plan",
    schema: "{\"kind\":\"db-plan\",\"summary\":string,\"schemaChanges\":string[],\"migrationSteps\":string[],\"dataRisks\":string[],\"verification\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: DatabaseArtifact = {
        kind: "db-plan",
        summary: base.summary,
        schemaChanges: asStringArray(value.schemaChanges),
        migrationSteps: asStringArray(value.migrationSteps),
        dataRisks: asStringArray(value.dataRisks),
        verification: asStringArray(value.verification),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.schemaChanges, ...artifact.migrationSteps, ...artifact.dataRisks].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.schemaChanges, ...artifact.migrationSteps]),
        risks: artifact.dataRisks,
        verification: dedupe([...artifact.verification, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "db-plan",
        summary: `Prepared the database work for ${focusFromPrompt(prompt)}`,
        schemaChanges: ["Keep the schema change as small and reversible as possible"],
        migrationSteps: ["Apply schema changes before relying on the new shape"],
        dataRisks: ["Protect existing rows during migration and rollback"],
        verification: ["Validate reads and writes across the boundary"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "browser-report": {
    kind: "browser-report",
    schema: "{\"kind\":\"browser-report\",\"summary\":string,\"flows\":string[],\"consoleFindings\":string[],\"networkFindings\":string[],\"screenshots\":string[],\"suggestedCommands\":string[],\"toolCalls\":[{\"name\":string,\"reason\":string,\"input\":object}]}",
    normalize(raw) {
      const value = asObject(raw);
      const base = toolFields(value);
      const artifact: BrowserArtifact = {
        kind: "browser-report",
        summary: base.summary,
        flows: asStringArray(value.flows),
        consoleFindings: asStringArray(value.consoleFindings),
        networkFindings: asStringArray(value.networkFindings),
        screenshots: asStringArray(value.screenshots),
        suggestedCommands: base.suggestedCommands,
        toolCalls: base.toolCalls
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.flows, ...artifact.consoleFindings, ...artifact.networkFindings].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.flows,
        risks: dedupe([...artifact.consoleFindings, ...artifact.networkFindings]),
        verification: dedupe([...artifact.screenshots, ...(artifact.suggestedCommands ?? [])])
      });
    },
    createMock(prompt, toolCalls) {
      return {
        kind: "browser-report",
        summary: `Prepared the browser/runtime inspection for ${focusFromPrompt(prompt)}`,
        flows: ["Check the primary UI flow end to end"],
        consoleFindings: ["Capture console errors or warnings during the flow"],
        networkFindings: ["Capture failed or unexpected network requests"],
        screenshots: ["Take a screenshot at the key state transition"],
        suggestedCommands: mockSuggestedCommands(prompt),
        toolCalls
      };
    }
  },
  "accessibility-report": {
    kind: "accessibility-report",
    schema: "{\"kind\":\"accessibility-report\",\"summary\":string,\"issues\":string[],\"keyboardFlow\":string[],\"screenReader\":string[],\"fixes\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: AccessibilityArtifact = {
        kind: "accessibility-report",
        summary: asString(value.summary, "Completed the accessibility review."),
        issues: asStringArray(value.issues),
        keyboardFlow: asStringArray(value.keyboardFlow),
        screenReader: asStringArray(value.screenReader),
        fixes: asStringArray(value.fixes)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.issues, ...artifact.keyboardFlow, ...artifact.fixes].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.fixes,
        risks: artifact.issues,
        verification: dedupe([...artifact.keyboardFlow, ...artifact.screenReader])
      });
    },
    createMock(prompt) {
      return {
        kind: "accessibility-report",
        summary: `Reviewed accessibility risks for ${focusFromPrompt(prompt)}`,
        issues: ["Keyboard and labeling regressions should be checked explicitly"],
        keyboardFlow: ["Tab through the main interactive elements"],
        screenReader: ["Confirm the key control names are announced correctly"],
        fixes: ["Add semantic labels and preserve focus order"]
      };
    }
  },
  "cost-plan": {
    kind: "cost-plan",
    schema: "{\"kind\":\"cost-plan\",\"summary\":string,\"savings\":string[],\"tradeoffs\":string[],\"guardrails\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: CostArtifact = {
        kind: "cost-plan",
        summary: asString(value.summary, "Prepared the cost plan."),
        savings: asStringArray(value.savings),
        tradeoffs: asStringArray(value.tradeoffs),
        guardrails: asStringArray(value.guardrails)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.savings, ...artifact.tradeoffs, ...artifact.guardrails].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.savings,
        risks: artifact.tradeoffs,
        delivery: artifact.guardrails
      });
    },
    createMock(prompt) {
      return {
        kind: "cost-plan",
        summary: `Prepared the cost controls for ${focusFromPrompt(prompt)}`,
        savings: ["Prefer the cheaper path when quality is unchanged"],
        tradeoffs: ["Avoid savings that hide failures or slow contributors down"],
        guardrails: ["Track token, runtime, or infrastructure usage with a visible budget"]
      };
    }
  },
  "model-routing-plan": {
    kind: "model-routing-plan",
    schema: "{\"kind\":\"model-routing-plan\",\"summary\":string,\"routingChanges\":string[],\"fallbackRules\":string[],\"budgets\":string[],\"metrics\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: ModelRoutingArtifact = {
        kind: "model-routing-plan",
        summary: asString(value.summary, "Prepared the model routing plan."),
        routingChanges: asStringArray(value.routingChanges),
        fallbackRules: asStringArray(value.fallbackRules),
        budgets: asStringArray(value.budgets),
        metrics: asStringArray(value.metrics)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.routingChanges, ...artifact.fallbackRules, ...artifact.budgets].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: dedupe([...artifact.routingChanges, ...artifact.fallbackRules]),
        delivery: artifact.budgets,
        verification: artifact.metrics
      });
    },
    createMock(prompt) {
      return {
        kind: "model-routing-plan",
        summary: `Prepared the provider routing changes for ${focusFromPrompt(prompt)}`,
        routingChanges: ["Route work to the provider that fits the task class"],
        fallbackRules: ["Keep a deterministic fallback path when the preferred provider fails"],
        budgets: ["Set per-task budget expectations"],
        metrics: ["Track fallback rate and latency by task class"]
      };
    }
  },
  "compliance-review": {
    kind: "compliance-review",
    schema: "{\"kind\":\"compliance-review\",\"summary\":string,\"controls\":string[],\"gaps\":string[],\"evidence\":string[],\"followUp\":string[]}",
    normalize(raw) {
      const value = asObject(raw);
      const artifact: ComplianceArtifact = {
        kind: "compliance-review",
        summary: asString(value.summary, "Completed the compliance review."),
        controls: asStringArray(value.controls),
        gaps: asStringArray(value.gaps),
        evidence: asStringArray(value.evidence),
        followUp: asStringArray(value.followUp)
      };
      return artifact;
    },
    details(artifact) {
      return [...artifact.controls, ...artifact.gaps, ...artifact.followUp].slice(0, 6);
    },
    merge(artifact) {
      return mergeFromFields({
        implementation: artifact.controls,
        risks: artifact.gaps,
        verification: artifact.evidence,
        delivery: artifact.followUp
      });
    },
    createMock(prompt) {
      return {
        kind: "compliance-review",
        summary: `Prepared the compliance check for ${focusFromPrompt(prompt)}`,
        controls: ["Record the required controls near the affected workflow"],
        gaps: ["Missing evidence or undocumented process steps should block sign-off"],
        evidence: ["Keep proof of verification alongside the change"],
        followUp: ["Document any manual control that remains outside automation"]
      };
    }
  }
};
