// ── Core Types ──────────────────────────────────────────────

export interface ProjectAnalysis {
  root: string;
  name: string;
  techStack: TechStack;
  commands: CommandMap;
  structure: DirectoryStructure;
  existingConfigs: ExistingConfig[];
  monorepo: MonorepoInfo | null;
  curationNeeded: CurationItem[];
}

export interface TechStack {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  nodeVersion: string | null;
  runtime: string | null;
  linter: LinterInfo | null;
  formatter: string | null;
  testRunner: string | null;
  buildTool: string | null;
  database: string | null;
  orm: string | null;
  cicd: string | null;
}

export interface LinterInfo {
  name: string;
  configFile: string;
}

export interface CommandMap {
  install: string | null;
  build: string | null;
  dev: string | null;
  test: string | null;
  lint: string | null;
  typecheck: string | null;
  format: string | null;
  e2e: string | null;
  migrate: string | null;
  [key: string]: string | null | undefined;
}

export interface DirectoryStructure {
  topLevel: string[];
  notable: Record<string, string>;
  sourceDir: string | null;
}

export interface ExistingConfig {
  type: string;
  path: string;
}

export interface MonorepoInfo {
  tool: string; // turborepo, nx, lerna, pnpm workspaces
  packages: PackageInfo[];
}

export interface PackageInfo {
  name: string;
  path: string;
  description: string;
}

export interface CurationItem {
  id: string;
  category: "judgment" | "architecture" | "context" | "persona" | "pattern";
  question: string;
  suggestions: string[];
  required: boolean;
  answer?: string;
}

// ── Generation Output ───────────────────────────────────────

export interface HarnessOutput {
  agentsMd: string;
  globalAgentsMd: string;
  configToml: string;
  docsStructure: DocsFile[];
  subAgentsMd: SubAgentsMd[];
  claudeMdSymlink: boolean;
}

export interface DocsFile {
  path: string;
  content: string;
}

export interface SubAgentsMd {
  path: string;
  content: string;
}

// ── Phase 3: Orchestrator ───────────────────────────────────

export interface OrchestratorConfig {
  phases: PhaseConfig[];
  contextFiles: string[];
  verificationCommands: string[];
}

export interface PhaseConfig {
  name: string;
  description: string;
  contextFiles: string[];
  commands: string[];
}
