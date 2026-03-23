import type { PlannerArtifact, ResearchArtifact } from "../core/types.js";

export interface ClarificationRequest {
  required: boolean;
  reason: string;
  message: string;
  summary: string;
  groups: Array<{
    id: string;
    label: string;
    selectionMode: "single" | "multi";
    options: Array<{
      id: string;
      label: string;
      detail: string;
      promptFragment: string;
      recommended?: boolean;
    }>;
  }>;
}

export interface AnalyzeArtifact {
  summary: string;
  intent: string;
  explicitRequirements: string[];
  implicitRequirements: string[];
  risks: string[];
  assumptions: string[];
  missingInfo: string[];
  repoAssessment: string[];
  recommendedMvp: string[];
  techOptions: string[];
  nextQuestions: string[];
  complexity: "simple" | "moderate" | "complex" | "massive";
  clarificationRequired: boolean;
  clarificationRequest?: ClarificationRequest;
}

function compactString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function dedupe(items: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const clean = compactString(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupe(value.map((item) => (typeof item === "string" ? item : null)));
  }
  if (typeof value === "string") {
    return dedupe(
      value
        .split(/\n|[;•]/)
        .map((item) => item.replace(/^[-*]\s*/, "").trim())
    );
  }
  return [];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates = [
    trimmed,
    ...Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)).map((match) => match[1] ?? ""),
  ];

  const objectLike = trimmed.match(/\{[\s\S]*\}/);
  if (objectLike) {
    candidates.push(objectLike[0]);
  }

  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed candidates and keep trying.
    }
  }

  return null;
}

export function extractOriginalTaskFromPrompt(prompt: string): string {
  const match = prompt.match(/## Original Task(?: \(NEVER FORGET THIS\))?\n([\s\S]*?)(?=\n##\s+|$)/);
  const raw = match?.[1]?.trim() ?? prompt.trim();
  return raw.replace(/^\*\*?/, "").replace(/\*\*?$/, "").replace(/^"|"$/g, "").trim();
}

function extractRoleSection(text: string, role: string): string | null {
  const pattern = new RegExp(`##\\s+${role}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function normalizeComplexity(value: unknown): "simple" | "moderate" | "complex" | "massive" {
  if (value === "simple" || value === "moderate" || value === "complex" || value === "massive") {
    return value;
  }
  if (value === "enterprise") return "massive";
  return "moderate";
}

function hasResolvedClarification(task: string): boolean {
  return /\[Clarification Selections\]/i.test(task)
    || /Treat the following as confirmed requirements(?: and preferred defaults)?:/i.test(task);
}

function toTechOptions(stack: Record<string, string>): string[] {
  return dedupe(Object.entries(stack).map(([key, value]) => `${key}: ${compactString(value)}`));
}

function looksLikeAnalyzeArtifact(value: Record<string, unknown>): boolean {
  return typeof value.summary === "string"
    && typeof value.intent === "string"
    && Array.isArray(value.explicitRequirements)
    && Array.isArray(value.risks)
    && Array.isArray(value.nextQuestions);
}

function parseRenderedAnalyzeArtifact(text: string, task: string): AnalyzeArtifact | null {
  const section = text.match(/## Analyze Artifact\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!section) return null;

  const source: Record<string, unknown> = {};
  let currentListKey = "";
  const listMap = new Map([
    ["### Explicit Requirements", "explicitRequirements"],
    ["### Implicit Requirements", "implicitRequirements"],
    ["### Risks", "risks"],
    ["### Assumptions", "assumptions"],
    ["### Missing Info", "missingInfo"],
    ["### Repo Assessment", "repoAssessment"],
    ["### Recommended MVP", "recommendedMvp"],
    ["### Tech Options", "techOptions"],
    ["### Next Questions", "nextQuestions"],
  ]);

  for (const line of section[1].split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith("Summary:")) {
      source.summary = trimmedLine.slice("Summary:".length).trim();
      currentListKey = "";
      continue;
    }
    if (trimmedLine.startsWith("Intent:")) {
      source.intent = trimmedLine.slice("Intent:".length).trim();
      currentListKey = "";
      continue;
    }
    if (trimmedLine.startsWith("Complexity:")) {
      source.complexity = trimmedLine.slice("Complexity:".length).trim().toLowerCase();
      currentListKey = "";
      continue;
    }
    if (trimmedLine.startsWith("Clarification Required:")) {
      source.clarificationRequired = /yes|true/i.test(trimmedLine.slice("Clarification Required:".length));
      currentListKey = "";
      continue;
    }
    const mapped = listMap.get(trimmedLine);
    if (mapped) {
      currentListKey = mapped;
      source[currentListKey] = [];
      continue;
    }
    if (trimmedLine.startsWith("- ") && currentListKey) {
      (source[currentListKey] as string[]).push(trimmedLine.slice(2).trim());
    }
  }

  return normalizeAnalyzeArtifact({ task, source });
}

export function normalizeAnalyzeArtifact(params: {
  task: string;
  planner?: PlannerArtifact | null;
  research?: ResearchArtifact | null;
  source?: Record<string, unknown> | null;
  preserveSource?: boolean;
}): AnalyzeArtifact {
  const clarifiedTask = hasResolvedClarification(params.task);
  const planner = params.planner ?? null;
  const research = params.research ?? null;
  const source = params.source ?? null;
  const preserveSource = params.preserveSource ?? false;

  const sourceExplicitRequirements = asStringArray(source?.explicitRequirements);
  const sourceImplicitRequirements = asStringArray(source?.implicitRequirements);
  const sourceRisks = asStringArray(source?.risks);
  const sourceAssumptions = asStringArray(source?.assumptions);
  const sourceMissingInfo = asStringArray(source?.missingInfo);
  const sourceRepoAssessment = asStringArray(source?.repoAssessment);
  const sourceRecommendedMvp = asStringArray(source?.recommendedMvp);
  const sourceTechOptions = asStringArray(source?.techOptions);
  const sourceNextQuestions = asStringArray(source?.nextQuestions);

  const explicitRequirements = preserveSource
    ? sourceExplicitRequirements
    : dedupe([
      ...sourceExplicitRequirements,
      ...(planner?.tasks.map((task) => task.title) ?? []),
      planner?.summary ?? null,
      research?.summary ?? null,
      params.task,
    ]);

  const implicitRequirements = dedupe(sourceImplicitRequirements);

  const risks = preserveSource
    ? sourceRisks
    : dedupe([
      ...sourceRisks,
      ...(research?.risks ?? []),
    ]);

  const assumptions = dedupe(sourceAssumptions);

  const missingInfo = dedupe(sourceMissingInfo);
  const nextQuestions = dedupe(sourceNextQuestions);

  const repoAssessment = preserveSource
    ? sourceRepoAssessment
    : dedupe([
      ...sourceRepoAssessment,
      ...(research?.findings ?? []),
      planner?.summary ? `Planner focus: ${planner.summary}` : null,
    ]);

  const recommendedMvp = preserveSource
    ? sourceRecommendedMvp
    : dedupe([
      ...sourceRecommendedMvp,
      ...(planner?.tasks ?? []).slice(0, 8).map((task) => task.title),
    ]);

  const techOptions = dedupe(sourceTechOptions);

  const summary = compactString(
    typeof source?.summary === "string"
      ? source.summary
      : planner?.summary || research?.summary || params.task
  ) || params.task;

  const intent = compactString(
    typeof source?.intent === "string" ? source.intent : params.task
  ) || params.task;

  // Check planner output for clarificationRequest (AI decides if clarification is needed)
  const plannerCR = (planner as unknown as Record<string, unknown>)?.clarificationRequest;
  const sourceCR = source?.clarificationRequest;
  const clarificationRequest = (plannerCR && typeof plannerCR === "object" && (plannerCR as Record<string, unknown>).required === true)
    ? plannerCR as unknown as ClarificationRequest
    : (sourceCR && typeof sourceCR === "object" && (sourceCR as Record<string, unknown>).required === true)
      ? sourceCR as unknown as ClarificationRequest
      : undefined;

  const clarificationRequired = clarificationRequest?.required === true
    || (typeof source?.clarificationRequired === "boolean"
      ? source.clarificationRequired
      : false);

  return {
    summary,
    intent,
    explicitRequirements,
    implicitRequirements,
    risks,
    assumptions,
    missingInfo,
    repoAssessment,
    recommendedMvp,
    techOptions,
    nextQuestions,
    complexity: normalizeComplexity(source?.complexity ?? "moderate"),
    clarificationRequired,
    clarificationRequest,
  };
}

export function extractAnalyzeArtifactFromText(task: string, text: string): AnalyzeArtifact | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const directObject = parseJsonObject(trimmed);
  if (directObject && looksLikeAnalyzeArtifact(directObject)) {
    return normalizeAnalyzeArtifact({ task, source: directObject, preserveSource: true });
  }

  const renderedArtifact = parseRenderedAnalyzeArtifact(trimmed, task);
  if (renderedArtifact) {
    return renderedArtifact;
  }

  const plannerText = extractRoleSection(trimmed, "planner");
  const researcherText = extractRoleSection(trimmed, "researcher");
  const plannerObject = plannerText ? parseJsonObject(plannerText) : null;
  const researcherObject = researcherText ? parseJsonObject(researcherText) : null;

  if (plannerObject || researcherObject || directObject) {
    return normalizeAnalyzeArtifact({
      task,
      planner: plannerObject as unknown as PlannerArtifact | null,
      research: researcherObject as unknown as ResearchArtifact | null,
      source: directObject
    });
  }

  return normalizeAnalyzeArtifact({
    task,
    source: {
      summary: trimmed,
      repoAssessment: [trimmed]
    }
  });
}

export function extractAnalyzeArtifactFromEngineResult(params: {
  task: string;
  outputs: Array<{ role: string; output: unknown }>;
}): AnalyzeArtifact {
  let planner: PlannerArtifact | null = null;
  let research: ResearchArtifact | null = null;
  let source: Record<string, unknown> | null = null;

  for (const item of params.outputs) {
    if (!item.output || typeof item.output !== "object") continue;
    const record = item.output as Record<string, unknown>;
    if (!source && looksLikeAnalyzeArtifact(record)) {
      source = record;
    }
    if (item.role === "planner") {
      planner = record as unknown as PlannerArtifact;
    } else if (item.role === "researcher") {
      research = record as unknown as ResearchArtifact;
    }
  }

  return normalizeAnalyzeArtifact({
    task: params.task,
    planner,
    research,
    source,
    preserveSource: Boolean(source),
  });
}

export function renderAnalyzeArtifact(artifact: AnalyzeArtifact): string {
  const sections: string[] = [];
  sections.push("## Analyze Artifact");
  sections.push(`Summary: ${artifact.summary}`);
  sections.push(`Intent: ${artifact.intent}`);
  sections.push(`Complexity: ${artifact.complexity}`);
  sections.push(`Clarification Required: ${artifact.clarificationRequired ? "yes" : "no"}`);

  const appendList = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    sections.push(`${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
  };

  appendList("### Explicit Requirements", artifact.explicitRequirements);
  appendList("### Implicit Requirements", artifact.implicitRequirements);
  appendList("### Risks", artifact.risks);
  appendList("### Assumptions", artifact.assumptions);
  appendList("### Missing Info", artifact.missingInfo);
  appendList("### Repo Assessment", artifact.repoAssessment);
  appendList("### Recommended MVP", artifact.recommendedMvp);
  appendList("### Tech Options", artifact.techOptions);
  appendList("### Next Questions", artifact.nextQuestions);
  sections.push(`### Structured Data
\`\`\`json
${JSON.stringify(artifact, null, 2)}
\`\`\``);

  return sections.join("\n\n");
}
