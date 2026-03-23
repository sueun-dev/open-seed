import type { PlannerArtifact, ResearchArtifact } from "../core/types.js";
import type { AnalyzeArtifact } from "./analyze-artifact.js";

export interface DebateArtifact {
  summary: string;
  recommendedApproach: string;
  decisionDrivers: string[];
  alternativesConsidered: string[];
  tradeoffs: string[];
  risks: string[];
  openQuestions: string[];
  implementationPrinciples: string[];
  verificationStrategy: string[];
  designFocus: string[];
  readiness: "blocked" | "provisional" | "ready";
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

function splitSentences(text: string): string[] {
  return dedupe(
    text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
  );
}

function extractSection(text: string, heading: string): string | null {
  const pattern = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
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

function looksLikeDebateArtifact(value: Record<string, unknown>): boolean {
  return typeof value.summary === "string"
    && typeof value.recommendedApproach === "string"
    && Array.isArray(value.risks)
    && Array.isArray(value.designFocus);
}

function summarizeApproach(text: string, fallback: string): string {
  const sentences = splitSentences(text);
  return sentences[0] ?? fallback;
}

// No regex inference. AI decides all of these via its structured output.

function normalizeReadiness(value: unknown): "blocked" | "provisional" | "ready" | null {
  return value === "blocked" || value === "provisional" || value === "ready" ? value : null;
}

export function normalizeDebateArtifact(params: {
  task: string;
  analyzeArtifact?: AnalyzeArtifact | null;
  planner?: PlannerArtifact | null;
  research?: ResearchArtifact | null;
  source?: Record<string, unknown> | null;
  preserveSource?: boolean;
}): DebateArtifact {
  const analyzeArtifact = params.analyzeArtifact ?? null;
  const planner = params.planner ?? null;
  const research = params.research ?? null;
  const source = params.source ?? null;
  const preserveSource = params.preserveSource ?? false;

  const sourceRisks = asStringArray(source?.risks);
  const sourceOpenQuestions = asStringArray(source?.openQuestions);
  const sourceDesignFocus = asStringArray(source?.designFocus);
  const sourceDecisionDrivers = asStringArray(source?.decisionDrivers);
  const sourceAlternatives = asStringArray(source?.alternativesConsidered);
  const sourceTradeoffs = asStringArray(source?.tradeoffs);
  const sourceImplementationPrinciples = asStringArray(source?.implementationPrinciples);
  const sourceVerificationStrategy = asStringArray(source?.verificationStrategy);

  const summary = compactString(
    typeof source?.summary === "string"
      ? source.summary
      : planner?.summary || research?.summary || params.task
  ) || params.task;

  const recommendedApproach = compactString(
    typeof source?.recommendedApproach === "string"
      ? source.recommendedApproach
      : summarizeApproach(planner?.summary ?? research?.summary ?? "", summary)
  ) || summary;

  const risks = (preserveSource
    ? sourceRisks
    : dedupe([
      ...sourceRisks,
      ...research?.risks ?? [],
    ])).slice(0, 10);

  const openQuestions = (preserveSource
    ? sourceOpenQuestions
    : dedupe([
      ...sourceOpenQuestions,
      ...analyzeArtifact?.missingInfo ?? [],
    ])).slice(0, 10);

  const designFocus = (preserveSource
    ? sourceDesignFocus
    : dedupe([
      ...sourceDesignFocus,
      ...(planner?.tasks ?? []).map((task) => task.title),
    ])).slice(0, 12);

  const decisionDrivers = (preserveSource
    ? sourceDecisionDrivers
    : dedupe([
      ...sourceDecisionDrivers,
      ...splitSentences(summary),
      ...(research?.findings ?? []),
    ])).slice(0, 8);

  const alternativesConsidered = dedupe(sourceAlternatives).slice(0, 8);
  const tradeoffs = dedupe(sourceTradeoffs).slice(0, 8);
  const implementationPrinciples = dedupe(sourceImplementationPrinciples).slice(0, 8);
  const verificationStrategy = dedupe(sourceVerificationStrategy).slice(0, 8);

  return {
    summary,
    recommendedApproach,
    decisionDrivers,
    alternativesConsidered,
    tradeoffs,
    risks,
    openQuestions,
    implementationPrinciples,
    verificationStrategy,
    designFocus,
    // AI decides readiness. Default to "ready" if not specified.
    readiness: normalizeReadiness(source?.readiness) ?? "ready",
  };
}

export function extractDebateArtifactFromText(task: string, text: string, analyzeArtifact?: AnalyzeArtifact | null): DebateArtifact | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const directObject = parseJsonObject(trimmed);
  if (directObject && looksLikeDebateArtifact(directObject)) {
    return normalizeDebateArtifact({ task, analyzeArtifact, source: directObject, preserveSource: true });
  }

  const renderedSection = extractSection(trimmed, "Debate Artifact");
  if (renderedSection) {
    const source: Record<string, unknown> = {};
    let currentListKey = "";
    const listMap = new Map([
      ["### Decision Drivers", "decisionDrivers"],
      ["### Alternatives Considered", "alternativesConsidered"],
      ["### Tradeoffs", "tradeoffs"],
      ["### Risks", "risks"],
      ["### Open Questions", "openQuestions"],
      ["### Implementation Principles", "implementationPrinciples"],
      ["### Verification Strategy", "verificationStrategy"],
      ["### Design Focus", "designFocus"],
    ]);

    for (const line of renderedSection.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      if (trimmedLine.startsWith("Summary:")) {
        source.summary = trimmedLine.slice("Summary:".length).trim();
        currentListKey = "";
        continue;
      }
      if (trimmedLine.startsWith("Recommended Approach:")) {
        source.recommendedApproach = trimmedLine.slice("Recommended Approach:".length).trim();
        currentListKey = "";
        continue;
      }
      if (trimmedLine.startsWith("Readiness:")) {
        source.readiness = trimmedLine.slice("Readiness:".length).trim().toLowerCase();
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

    return normalizeDebateArtifact({ task, analyzeArtifact, source });
  }

  const plannerText = extractSection(trimmed, "planner");
  const researcherText = extractSection(trimmed, "researcher");
  const plannerObject = plannerText ? parseJsonObject(plannerText) : null;
  const researcherObject = researcherText ? parseJsonObject(researcherText) : null;

  if (plannerObject || researcherObject || directObject) {
    return normalizeDebateArtifact({
      task,
      analyzeArtifact,
      planner: plannerObject as unknown as PlannerArtifact | null,
      research: researcherObject as unknown as ResearchArtifact | null,
      source: directObject,
    });
  }

  return normalizeDebateArtifact({
    task,
    analyzeArtifact,
    source: { summary: trimmed },
  });
}

export function extractDebateArtifactFromEngineResult(params: {
  task: string;
  analyzeArtifact?: AnalyzeArtifact | null;
  outputs: Array<{ role: string; output: unknown }>;
}): DebateArtifact {
  let planner: PlannerArtifact | null = null;
  let research: ResearchArtifact | null = null;
  let source: Record<string, unknown> | null = null;

  for (const item of params.outputs) {
    if (!item.output || typeof item.output !== "object") continue;
    const record = item.output as Record<string, unknown>;
    if (!source && looksLikeDebateArtifact(record)) {
      source = record;
    }
    if (item.role === "planner") {
      planner = record as unknown as PlannerArtifact;
    } else if (item.role === "researcher") {
      research = record as unknown as ResearchArtifact;
    }
  }

  return normalizeDebateArtifact({
    task: params.task,
    analyzeArtifact: params.analyzeArtifact,
    planner,
    research,
    source,
    preserveSource: Boolean(source),
  });
}

export function renderDebateArtifact(artifact: DebateArtifact): string {
  const sections: string[] = [];
  sections.push("## Debate Artifact");
  sections.push(`Summary: ${artifact.summary}`);
  sections.push(`Recommended Approach: ${artifact.recommendedApproach}`);
  sections.push(`Readiness: ${artifact.readiness}`);

  const appendList = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    sections.push(`${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
  };

  appendList("### Decision Drivers", artifact.decisionDrivers);
  appendList("### Alternatives Considered", artifact.alternativesConsidered);
  appendList("### Tradeoffs", artifact.tradeoffs);
  appendList("### Risks", artifact.risks);
  appendList("### Open Questions", artifact.openQuestions);
  appendList("### Implementation Principles", artifact.implementationPrinciples);
  appendList("### Verification Strategy", artifact.verificationStrategy);
  appendList("### Design Focus", artifact.designFocus);
  sections.push(`### Structured Data
\`\`\`json
${JSON.stringify(artifact, null, 2)}
\`\`\``);

  return sections.join("\n\n");
}
