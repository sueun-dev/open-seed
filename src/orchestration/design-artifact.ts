import type { PlannerArtifact, ResearchArtifact } from "../core/types.js";
import type { AnalyzeArtifact } from "./analyze-artifact.js";
import type { DebateArtifact } from "./debate-artifact.js";

export type DesignLayer =
  | "scaffold"
  | "config"
  | "shared"
  | "frontend"
  | "backend"
  | "database"
  | "realtime"
  | "testing"
  | "docs";

export interface DesignFileSpec {
  path: string;
  purpose: string;
  layer: DesignLayer;
  owner: string;
  wave: number;
  dependsOn: string[];
}

export interface DesignWorkstream {
  id: string;
  title: string;
  owner: string;
  wave: number;
  focus: string;
  files: string[];
  deliverables: string[];
  dependsOn: string[];
  testTargets: string[];
}

export interface DesignBuildWave {
  wave: number;
  title: string;
  objective: string;
  workstreamIds: string[];
}

export interface DesignArtifact {
  summary: string;
  architecture: string[];
  directoryStructure: string[];
  fileManifest: DesignFileSpec[];
  workstreams: DesignWorkstream[];
  buildWaves: DesignBuildWave[];
  dependencyNotes: string[];
  contracts: string[];
  testPlan: string[];
  acceptanceChecks: string[];
  executionNotes: string[];
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

function extractSection(text: string, heading: string): string | null {
  const pattern = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function normalizeReadiness(value: unknown): "blocked" | "provisional" | "ready" | null {
  return value === "blocked" || value === "provisional" || value === "ready" ? value : null;
}

function normalizeWave(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function slugify(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function ownerForLayer(layer: DesignLayer): string {
  switch (layer) {
    case "scaffold":
    case "config":
      return "build-doctor";
    case "frontend":
      return "frontend-engineer";
    case "backend":
      return "backend-engineer";
    case "database":
      return "db-engineer";
    case "realtime":
      return "backend-engineer";
    case "testing":
      return "test-engineer";
    case "docs":
      return "docs-writer";
    default:
      return "executor";
  }
}

function waveForLayer(layer: DesignLayer): number {
  switch (layer) {
    case "scaffold":
    case "config":
    case "docs":
      return 1;
    case "shared":
    case "frontend":
    case "backend":
    case "database":
      return 2;
    case "realtime":
      return 3;
    case "testing":
      return 4;
    default:
      return 2;
  }
}

function inferLayerFromPath(filePath: string): DesignLayer {
  const normalized = filePath.toLowerCase();
  if (normalized === "package.json" || normalized === "pnpm-lock.yaml" || normalized === "package-lock.json") return "scaffold";
  if (normalized === "tsconfig.json" || normalized.includes("vite.config") || normalized.includes("eslint") || normalized.includes("vitest.config") || normalized.includes("playwright.config")) return "config";
  if (normalized.startsWith("tests/") || normalized.startsWith("test/")) return "testing";
  if (normalized.endsWith("readme.md") || normalized.startsWith("docs/")) return "docs";
  if (normalized.includes("/db/") || normalized.includes("schema") || normalized.includes("migration")) return "database";
  if (normalized.includes("socket") || normalized.includes("realtime") || normalized.includes("network") || normalized.includes("sync")) return "realtime";
  if (normalized.includes("server") || normalized.includes("api") || normalized.includes("route") || normalized.includes("service")) return "backend";
  if (normalized.includes("shared") || normalized.includes("types") || normalized.includes("state")) return "shared";
  if (normalized.endsWith(".tsx") || normalized.endsWith(".jsx") || normalized.includes("ui") || normalized.includes("component") || normalized.includes("app") || normalized.includes("game") || normalized.endsWith("index.html") || normalized.endsWith("styles.css")) return "frontend";
  return "shared";
}

// No regex. No hardcoded rules. All decisions come from AI (analyze/debate artifacts).
// buildDefaultFileManifest returns an empty array — the AI planner decides the file structure.

function buildDefaultFileManifest(): DesignFileSpec[] {
  return [];
}

function normalizeFileManifest(value: unknown, fallback: DesignFileSpec[]): DesignFileSpec[] {
  if (!Array.isArray(value) || value.length === 0) return fallback;

  const normalized: DesignFileSpec[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const filePath = compactString(record.path);
    if (!filePath) continue;
    const layer = (compactString(record.layer) as DesignLayer) || inferLayerFromPath(filePath);
    normalized.push({
      path: filePath,
      purpose: compactString(record.purpose) || compactString(record.description) || "Implementation file",
      layer,
      owner: compactString(record.owner) || ownerForLayer(layer),
      wave: normalizeWave(record.wave, waveForLayer(layer)),
      dependsOn: asStringArray(record.dependsOn),
    });
  }

  if (normalized.length === 0) return fallback;

  const seen = new Set<string>();
  return normalized.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

function deriveWorkstreams(fileManifest: DesignFileSpec[], source?: Record<string, unknown> | null): DesignWorkstream[] {
  if (Array.isArray(source?.workstreams) && source.workstreams.length > 0) {
    const normalized: DesignWorkstream[] = [];
    for (const entry of source.workstreams) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = compactString(record.id) || slugify(compactString(record.title), `ws-${normalized.length + 1}`);
      if (!id) continue;
      normalized.push({
        id,
        title: compactString(record.title) || id,
        owner: compactString(record.owner) || "executor",
        wave: normalizeWave(record.wave, 1),
        focus: compactString(record.focus) || compactString(record.summary) || "Implementation workstream",
        files: asStringArray(record.files),
        deliverables: asStringArray(record.deliverables),
        dependsOn: asStringArray(record.dependsOn),
        testTargets: asStringArray(record.testTargets),
      });
    }
    if (normalized.length > 0) return normalized;
  }

  const byLayer = new Map<DesignLayer, DesignFileSpec[]>();
  for (const file of fileManifest) {
    const current = byLayer.get(file.layer) ?? [];
    current.push(file);
    byLayer.set(file.layer, current);
  }

  const dependencyByLayer: Record<DesignLayer, string[]> = {
    scaffold: [],
    config: ["ws-scaffold"],
    shared: ["ws-scaffold", "ws-config"],
    frontend: ["ws-scaffold", "ws-config", "ws-shared"],
    backend: ["ws-scaffold", "ws-config", "ws-shared"],
    database: ["ws-scaffold", "ws-config", "ws-backend"],
    realtime: ["ws-frontend", "ws-backend"],
    testing: ["ws-frontend", "ws-backend", "ws-database", "ws-realtime"],
    docs: ["ws-scaffold"],
  };

  const titleByLayer: Record<DesignLayer, string> = {
    scaffold: "Project Scaffold",
    config: "Tooling & Config",
    shared: "Shared Domain Core",
    frontend: "Frontend Surface",
    backend: "Backend Services",
    database: "Database & Persistence",
    realtime: "Realtime Integration",
    testing: "Testing & Verification",
    docs: "Project Documentation",
  };

  const focusByLayer: Record<DesignLayer, string> = {
    scaffold: "Create the runnable project foundation, scripts, and package metadata.",
    config: "Lock down compiler, test, and lint configuration before implementation expands.",
    shared: "Define shared state, domain types, and cross-cutting primitives.",
    frontend: "Implement the user-facing runtime, UI flow, and interaction layer.",
    backend: "Implement server-side handlers, business rules, and service orchestration.",
    database: "Implement schema, storage contracts, and persistence boundaries.",
    realtime: "Implement synchronization channels and client/server event contracts.",
    testing: "Implement automated tests that prove the critical flows and guard regressions.",
    docs: "Document setup, scripts, and operational assumptions for the generated app.",
  };

  const layersInOrder: DesignLayer[] = ["scaffold", "config", "shared", "frontend", "backend", "database", "realtime", "testing", "docs"];

  return layersInOrder
    .filter((layer) => (byLayer.get(layer) ?? []).length > 0)
    .map((layer) => {
      const files = byLayer.get(layer) ?? [];
      const id = `ws-${layer}`;
      return {
        id,
        title: titleByLayer[layer],
        owner: ownerForLayer(layer),
        wave: Math.min(...files.map((file) => file.wave)),
        focus: focusByLayer[layer],
        files: files.map((file) => file.path),
        deliverables: files.map((file) => `${file.path}: ${file.purpose}`),
        dependsOn: dependencyByLayer[layer].filter((dependencyId) => dependencyId !== id && layersInOrder.some((candidate) => `ws-${candidate}` === dependencyId && (byLayer.get(candidate) ?? []).length > 0)),
        testTargets: files.filter((file) => file.layer === "testing").map((file) => file.path),
      };
    });
}

function deriveBuildWaves(workstreams: DesignWorkstream[], source?: Record<string, unknown> | null): DesignBuildWave[] {
  if (Array.isArray(source?.buildWaves) && source.buildWaves.length > 0) {
    const normalized: DesignBuildWave[] = [];
    for (const entry of source.buildWaves) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const workstreamIds = asStringArray(record.workstreamIds);
      if (workstreamIds.length === 0) continue;
      normalized.push({
        wave: normalizeWave(record.wave, normalized.length + 1),
        title: compactString(record.title) || `Build Wave ${normalized.length + 1}`,
        objective: compactString(record.objective) || compactString(record.summary) || "Deliver the assigned workstreams.",
        workstreamIds,
      });
    }
    if (normalized.length > 0) {
      return normalized.sort((left, right) => left.wave - right.wave);
    }
  }

  const grouped = new Map<number, DesignWorkstream[]>();
  for (const workstream of workstreams) {
    const current = grouped.get(workstream.wave) ?? [];
    current.push(workstream);
    grouped.set(workstream.wave, current);
  }

  return Array.from(grouped.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([wave, entries]) => ({
      wave,
      title: entries.map((entry) => entry.title).join(" + "),
      objective: entries.map((entry) => entry.focus).join(" "),
      workstreamIds: entries.map((entry) => entry.id),
    }));
}

function looksLikeDesignArtifact(value: Record<string, unknown>): boolean {
  return typeof value.summary === "string"
    && Array.isArray(value.fileManifest)
    && Array.isArray(value.workstreams)
    && Array.isArray(value.buildWaves);
}

function parseRenderedDesignArtifact(task: string, text: string, analyzeArtifact?: AnalyzeArtifact | null, debateArtifact?: DebateArtifact | null): DesignArtifact | null {
  const section = text.match(/## Design Artifact\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  if (!section) return null;

  const source: Record<string, unknown> = {};
  let currentListKey = "";
  const listMap = new Map([
    ["### Architecture", "architecture"],
    ["### Directory Structure", "directoryStructure"],
    ["### Dependency Notes", "dependencyNotes"],
    ["### Contracts", "contracts"],
    ["### Test Plan", "testPlan"],
    ["### Acceptance Checks", "acceptanceChecks"],
    ["### Execution Notes", "executionNotes"],
  ]);

  for (const line of section[1].split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith("Summary:")) {
      source.summary = trimmedLine.slice("Summary:".length).trim();
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

  return normalizeDesignArtifact({ task, analyzeArtifact, debateArtifact, source });
}

export function normalizeDesignArtifact(params: {
  task: string;
  analyzeArtifact?: AnalyzeArtifact | null;
  debateArtifact?: DebateArtifact | null;
  planner?: PlannerArtifact | null;
  research?: ResearchArtifact | null;
  source?: Record<string, unknown> | null;
  preserveSource?: boolean;
}): DesignArtifact {
  const analyzeArtifact = params.analyzeArtifact ?? null;
  const debateArtifact = params.debateArtifact ?? null;
  const planner = params.planner ?? null;
  const research = params.research ?? null;
  const source = params.source ?? null;
  const preserveSource = params.preserveSource ?? false;

  const fallbackManifest = buildDefaultFileManifest();
  const fileManifest = normalizeFileManifest(source?.fileManifest, fallbackManifest);
  const workstreams = deriveWorkstreams(fileManifest, source);
  const buildWaves = deriveBuildWaves(workstreams, source);
  const sourceDirectoryStructure = asStringArray(source?.directoryStructure).map((entry) => entry.replace(/\/+$/g, ""));
  const directoryStructure = (preserveSource
    ? sourceDirectoryStructure
    : dedupe([
      ...sourceDirectoryStructure,
      ...fileManifest.map((file) => {
        const parts = file.path.split("/");
        return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      }),
    ])).filter((entry) => entry !== ".");

  const sourceArchitecture = asStringArray(source?.architecture);
  const architecture = (preserveSource
    ? sourceArchitecture
    : dedupe([
      ...sourceArchitecture,
      debateArtifact?.recommendedApproach,
      ...(debateArtifact?.implementationPrinciples ?? []),
      ...(analyzeArtifact?.repoAssessment ?? []),
      planner?.summary,
      research?.summary,
    ])).slice(0, 10);

  const sourceDependencyNotes = asStringArray(source?.dependencyNotes);
  const dependencyNotes = (preserveSource
    ? sourceDependencyNotes
    : dedupe([
      ...sourceDependencyNotes,
      ...(analyzeArtifact?.techOptions ?? []),
      planner?.summary ? `Planner: ${planner.summary}` : null,
    ])).slice(0, 12);

  const sourceContracts = asStringArray(source?.contracts);
  const contracts = (preserveSource
    ? sourceContracts
    : dedupe([
      ...sourceContracts,
      fileManifest.some((file) => file.layer === "frontend") && fileManifest.some((file) => file.layer === "backend")
        ? "Client/server contract must stay aligned with the file manifest and typed request boundaries."
        : null,
      fileManifest.some((file) => file.layer === "database")
        ? "Persistence contract must match schema and service assumptions before integration work starts."
        : null,
      fileManifest.some((file) => file.layer === "realtime")
        ? "Realtime event payloads must remain deterministic across server and client handlers."
        : null,
    ])).slice(0, 10);

  const sourceTestPlan = asStringArray(source?.testPlan);
  const testPlan = (preserveSource
    ? sourceTestPlan
    : dedupe([
      ...sourceTestPlan,
      ...fileManifest.filter((file) => file.layer === "testing").map((file) => `${file.path}: ${file.purpose}`),
      ...(debateArtifact?.verificationStrategy ?? []),
    ])).slice(0, 12);

  const sourceAcceptanceChecks = asStringArray(source?.acceptanceChecks);
  const acceptanceChecks = (preserveSource
    ? sourceAcceptanceChecks
    : dedupe([
      ...sourceAcceptanceChecks,
      ...(analyzeArtifact?.nextQuestions.length === 0 ? ["npm test", "npm run build"] : ["npm test", "npm run build"]),
      fileManifest.some((file) => file.path === "package.json") ? "npm start" : null,
    ])).slice(0, 10);

  const sourceExecutionNotes = asStringArray(source?.executionNotes);
  const executionNotes = (preserveSource
    ? sourceExecutionNotes
    : dedupe([
      ...sourceExecutionNotes,
      ...(analyzeArtifact?.recommendedMvp ?? []),
      ...(debateArtifact?.tradeoffs ?? []),
      ...(debateArtifact?.designFocus ?? []),
    ])).slice(0, 12);

  const summary = compactString(
    typeof source?.summary === "string"
      ? source.summary
      : planner?.summary || research?.summary || debateArtifact?.summary || analyzeArtifact?.summary || params.task
  ) || params.task;

  // AI decides readiness. If source has it, use it. Otherwise default to "ready".
  const readiness = normalizeReadiness(source?.readiness) ?? "ready";

  return {
    summary,
    architecture,
    directoryStructure,
    fileManifest,
    workstreams,
    buildWaves,
    dependencyNotes,
    contracts,
    testPlan,
    acceptanceChecks,
    executionNotes,
    readiness,
  };
}

export function extractDesignArtifactFromText(task: string, text: string, analyzeArtifact?: AnalyzeArtifact | null, debateArtifact?: DebateArtifact | null): DesignArtifact | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const directObject = parseJsonObject(trimmed);
  if (directObject && looksLikeDesignArtifact(directObject)) {
    return normalizeDesignArtifact({ task, analyzeArtifact, debateArtifact, source: directObject, preserveSource: true });
  }

  const renderedArtifact = parseRenderedDesignArtifact(task, trimmed, analyzeArtifact, debateArtifact);
  if (renderedArtifact) {
    return renderedArtifact;
  }

  const plannerText = extractSection(trimmed, "planner");
  const researcherText = extractSection(trimmed, "researcher");
  const plannerObject = plannerText ? parseJsonObject(plannerText) : null;
  const researcherObject = researcherText ? parseJsonObject(researcherText) : null;

  if (plannerObject || researcherObject || directObject) {
    return normalizeDesignArtifact({
      task,
      analyzeArtifact,
      debateArtifact,
      planner: plannerObject as unknown as PlannerArtifact | null,
      research: researcherObject as unknown as ResearchArtifact | null,
      source: directObject,
    });
  }

  return normalizeDesignArtifact({
    task,
    analyzeArtifact,
    debateArtifact,
    source: { summary: trimmed },
  });
}

export function extractDesignArtifactFromEngineResult(params: {
  task: string;
  analyzeArtifact?: AnalyzeArtifact | null;
  debateArtifact?: DebateArtifact | null;
  outputs: Array<{ role: string; output: unknown }>;
}): DesignArtifact {
  let planner: PlannerArtifact | null = null;
  let research: ResearchArtifact | null = null;
  let source: Record<string, unknown> | null = null;

  for (const item of params.outputs) {
    if (!item.output || typeof item.output !== "object") continue;
    const record = item.output as Record<string, unknown>;
    if (!source && looksLikeDesignArtifact(record)) {
      source = record;
    }
    if (item.role === "planner") {
      planner = record as unknown as PlannerArtifact;
    } else if (item.role === "researcher") {
      research = record as unknown as ResearchArtifact;
    }
  }

  return normalizeDesignArtifact({
    task: params.task,
    analyzeArtifact: params.analyzeArtifact,
    debateArtifact: params.debateArtifact,
    planner,
    research,
    source,
    preserveSource: Boolean(source),
  });
}

export function renderDesignArtifact(artifact: DesignArtifact): string {
  const sections: string[] = [];
  sections.push("## Design Artifact");
  sections.push(`Summary: ${artifact.summary}`);
  sections.push(`Readiness: ${artifact.readiness}`);

  const appendList = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    sections.push(`${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
  };

  appendList("### Architecture", artifact.architecture);
  appendList("### Directory Structure", artifact.directoryStructure.map((entry) => `${entry}/`));
  if (artifact.fileManifest.length > 0) {
    sections.push(`### File Manifest\n${artifact.fileManifest.map((file) => `- ${file.path} [wave ${file.wave} / ${file.owner}] — ${file.purpose}`).join("\n")}`);
  }
  if (artifact.workstreams.length > 0) {
    sections.push(`### Workstreams\n${artifact.workstreams.map((workstream) => `- ${workstream.id} [wave ${workstream.wave} / ${workstream.owner}] ${workstream.title} — ${workstream.focus}`).join("\n")}`);
  }
  if (artifact.buildWaves.length > 0) {
    sections.push(`### Build Waves\n${artifact.buildWaves.map((wave) => `- Wave ${wave.wave}: ${wave.title} — ${wave.objective}`).join("\n")}`);
  }
  appendList("### Dependency Notes", artifact.dependencyNotes);
  appendList("### Contracts", artifact.contracts);
  appendList("### Test Plan", artifact.testPlan);
  appendList("### Acceptance Checks", artifact.acceptanceChecks);
  appendList("### Execution Notes", artifact.executionNotes);
  sections.push(`### Structured Data
\`\`\`json
${JSON.stringify(artifact, null, 2)}
\`\`\``);

  return sections.join("\n\n");
}
