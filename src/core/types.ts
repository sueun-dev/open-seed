// ──────────────────────────────────────────────────────────────────────────────
// agent40 core type system
// ──────────────────────────────────────────────────────────────────────────────

// ─── Provider ────────────────────────────────────────────────────────────────

export type ProviderId = "anthropic" | "openai" | "gemini" | "mock";

export interface ProviderConfig {
  enabled: boolean;
  apiKeyEnv: string;
  authMode?: "api_key" | "oauth";
  oauthTokenEnv?: string;
  defaultModel: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ProviderRequest {
  role: string;
  category: RoleCategory;
  systemPrompt: string;
  prompt: string;
  model?: string;
  responseFormat: "json" | "text";
  /** Max output tokens override (context-window aware) */
  maxTokens?: number;
  /** Native tool definitions for agentic loop */
  tools?: NativeToolDef[];
}

export interface NativeToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderInvokeOptions {
  onTextDelta?: (chunk: string, providerId: ProviderId) => void | Promise<void>;
}

export interface ProviderResponse {
  provider: ProviderId;
  model: string;
  text: string;
  /** Native tool calls returned by the provider (OpenAI function calling / Anthropic tool_use) */
  toolCalls?: NativeToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  metadata?: {
    attempts?: number;
    fallbackFrom?: ProviderId;
    streamed?: boolean;
    authMode?: "api_key" | "oauth";
    warnings?: string[];
    authSource?: "env" | "external";
  };
}

export interface ProviderAdapter {
  id: ProviderId;
  isConfigured(config: ProviderConfig | undefined): boolean;
  invoke(config: ProviderConfig | undefined, request: ProviderRequest, options?: ProviderInvokeOptions): Promise<ProviderResponse>;
}

// ─── Approval / Safety ───────────────────────────────────────────────────────

export type ApprovalAction =
  | "read"
  | "search"
  | "lsp_diagnostics"
  | "test_dry_run"
  | "write"
  | "edit"
  | "bash_side_effect"
  | "browser_submit"
  | "git_push";

export type ApprovalMode = "ask" | "auto";

export interface ApprovalDecision {
  action: ApprovalAction;
  mode: ApprovalMode;
  approved: boolean;
  reason: string;
}

export interface ApprovalPolicy {
  defaultMode: ApprovalMode;
  autoApprove: ApprovalAction[];
  requireApproval: ApprovalAction[];
}

// ─── Rules Engine (Cline-inspired) ──────────────────────────────────────────

export interface AgentRule {
  id: string;
  description: string;
  /** Glob patterns for files this rule applies to */
  filePatterns?: string[];
  /** Tool names this rule governs */
  toolNames?: string[];
  /** Shell command patterns this rule matches */
  commandPatterns?: string[];
  /** Override approval mode for matched actions */
  approvalOverride?: ApprovalMode | "block";
  /** Whether this rule is currently active */
  enabled: boolean;
}

// ─── Roles ───────────────────────────────────────────────────────────────────

export type RoleCategory =
  | "planning"
  | "research"
  | "execution"
  | "frontend"
  | "review";

/**
 * MetaGPT-inspired react mode for role execution.
 * - react: LLM decides next action after each step
 * - by_order: fixed sequence of actions
 * - plan_and_act: plan all actions first, then execute in order
 */
export type ReactMode = "react" | "by_order" | "plan_and_act";

/**
 * MetaGPT-inspired agent state machine.
 * Each role tracks which phase it's in.
 */
export type AgentPhase =
  | "idle"
  | "planning"
  | "executing"
  | "reviewing"
  | "waiting"  // waiting for human approval or external input
  | "done"
  | "failed";

export interface ToolPolicy {
  allowed: string[];
  denied?: string[];
}

export interface RoleDefinition {
  id: string;
  displayName: string;
  description: string;
  active: boolean;
  aliases: string[];
  category: RoleCategory;
  prompt: string;
  toolPolicy: ToolPolicy;
  /** How this role processes steps */
  reactMode?: ReactMode;
  /** Maximum output tokens for this role */
  maxOutputTokens?: number;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export type ToolName =
  | "read"
  | "write"
  | "apply_patch"
  | "grep"
  | "glob"
  | "bash"
  | "git"
  | "browser"
  | "lsp_diagnostics"
  | "lsp_symbols"
  | "repo_map"
  | "session_history"
  | "ast_grep"
  | "web_search"
  // OMO additional tools
  | "call_agent"
  | "look_at"
  | "interactive_bash"
  | "background_output"
  | "background_cancel"
  | "task_create"
  | "task_get"
  | "task_list"
  | "task_update";

/**
 * Goose-inspired tool definition with full JSON schema.
 * Each tool has a typed input/output contract.
 */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  approvalAction: ApprovalAction;
  sideEffect: boolean;
  /** JSON Schema for input validation */
  inputSchema?: Record<string, unknown>;
  /** Tool category for registry grouping */
  toolCategory?: "file" | "search" | "shell" | "browser" | "analysis" | "network";
}

export interface ToolCall {
  name: ToolName;
  reason: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolName;
  ok: boolean;
  reason: string;
  approval: ApprovalDecision;
  output?: unknown;
  error?: string;
  /** Duration in ms */
  durationMs?: number;
}

// ─── Event Stream (OpenHands-inspired) ───────────────────────────────────────

export type EventSource =
  | "engine"
  | "agent"
  | "tool"
  | "provider"
  | "user"
  | "system";

export type EventType =
  | "session.started"
  | "session.resumed"
  | "session.completed"
  | "session.checkpoint"
  | "phase.transition"
  | "task.created"
  | "task.completed"
  | "task.failed"
  | "delegation.started"
  | "delegation.completed"
  | "worker.spawned"
  | "worker.completed"
  | "tool.called"
  | "tool.stream"
  | "tool.completed"
  | "tool.retry"
  | "approval.requested"
  | "approval.resolved"
  | "provider.stream"
  | "provider.retry"
  | "provider.fallback"
  | "review.pass"
  | "review.fail"
  | "enforcer.checklist"
  | "sandbox.staged"
  | "sandbox.applied"
  | "sandbox.reverted"
  | "cost.update"
  | "rule.matched"
  | "rule.blocked"
  | "error.retriable"
  | "error.fatal"
  | "enforcer.stuck";

export interface AgentEvent {
  type: EventType;
  source: EventSource;
  at: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

/** Backward-compatible alias for existing code */
export interface JsonLineEvent {
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

// ─── Event Bus ───────────────────────────────────────────────────────────────

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

export interface EventBus {
  emit(event: AgentEvent): Promise<void>;
  on(type: EventType | "*", handler: EventHandler): void;
  off(type: EventType | "*", handler: EventHandler): void;
}

// ─── Diff Sandbox (Plandex-inspired) ────────────────────────────────────────

export interface StagedChange {
  path: string;
  originalContent: string | null; // null = new file
  stagedContent: string;
  diff: string;
  createdAt: string;
}

export interface DiffSandboxState {
  changes: Map<string, StagedChange>;
  applied: boolean;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  cwd: string;
  task: string;
  status: "running" | "completed" | "failed";
  phase?: AgentPhase;
  createdAt: string;
  updatedAt: string;
  resumedFrom?: string;
  tasks: TaskRecord[];
  lastReview?: ReviewResult;
  /** Token budget tracking */
  tokenBudget?: TokenBudget;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  role: string;
  category: RoleCategory;
  provider: ProviderId;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  transport: WorkerTransport;
  output?: unknown;
  createdAt: string;
  updatedAt: string;
  /** Retry count for SWE-Agent style error recovery */
  retries?: number;
}

export type WorkerTransport = "inline" | "subprocess" | "tmux";

export interface WorkerLease {
  id: string;
  role: string;
  transport: WorkerTransport;
  pid?: number;
  paneId?: string;
  startedAt: string;
}

// ─── Token Budget (context window management) ────────────────────────────────

export interface TokenBudget {
  maxTokens: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  estimatedPromptTokens: number;
  /** Threshold at which to start compacting context */
  compactionThreshold: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface RoutingPolicy {
  categories: Record<RoleCategory, ProviderId>;
}

export interface TeamConfig {
  maxWorkers: number;
  preferTmux: boolean;
}

export interface SessionConfig {
  localDirName: string;
  globalNamespace: string;
}

export interface BrowserConfig {
  enabled: boolean;
  headless: boolean;
  doctorSmokeTest?: boolean;
}

export interface BrowserCheckpoint {
  id: string;
  sessionId: string;
  sessionName: string;
  action: string;
  url: string;
  title: string;
  createdAt: string;
  screenshotPath?: string;
  consoleMessages?: string[];
  requests?: string[];
}

export interface LspConfig {
  enabled: boolean;
}

export interface RetryConfig {
  /** Max retries for retriable tool errors */
  maxToolRetries: number;
  /** Max retries for LLM format/parse errors */
  maxParseRetries: number;
  /** Retriable error patterns (regex strings) */
  retriablePatterns: string[];
}

export interface SandboxConfig {
  /** Enable diff sandbox for safe writes */
  enabled: boolean;
  /** Auto-apply after review passes */
  autoApplyOnPass: boolean;
}

export interface PromptTemplateConfig {
  /** Path to custom prompt templates directory */
  templateDir?: string;
  /** Override individual template strings */
  overrides?: Record<string, string>;
}

/** OMO-style tmux configuration */
export interface TmuxConfig {
  enabled: boolean;
  layout?: "main-vertical" | "tiled" | "even-horizontal";
  mainPaneSize?: number;
}

/** OMO-style disable lists — everything ON by default, disable explicitly */
export interface DisableLists {
  hooks?: string[];
  agents?: string[];
  tools?: string[];
  skills?: string[];
  mcps?: string[];
  commands?: string[];
}

/** Experimental features (opt-in) */
export interface ExperimentalConfig {
  taskSystem?: boolean;
  preemptiveCompaction?: boolean;
  safeHookCreation?: boolean;
  dynamicContextPruning?: boolean;
}

/** Notification config */
export interface NotificationConfig {
  enabled: boolean;
  /** Only notify for tasks longer than this (ms) */
  minDurationMs?: number;
}

export interface AgentConfig {
  providers: Record<Exclude<ProviderId, "mock">, ProviderConfig>;
  routing: RoutingPolicy;
  safety: ApprovalPolicy;
  team: TeamConfig;
  sessions: SessionConfig;
  browser: BrowserConfig;
  lsp: LspConfig;
  roles: {
    active: string[];
  };
  tools: {
    browser: boolean;
    lsp: boolean;
    hashEdit: boolean;
    repoMap: boolean;
    parallelReadMax: number;
  };
  /** SWE-Agent inspired retry configuration */
  retry: RetryConfig;
  /** Plandex-inspired diff sandbox */
  sandbox: SandboxConfig;
  /** SWE-Agent inspired prompt templates */
  prompts: PromptTemplateConfig;
  /** Cline-inspired rules */
  rules: AgentRule[];
  /** OMO-style tmux config */
  tmux?: TmuxConfig;
  /** OMO-style disable lists — everything ON by default */
  disabled?: DisableLists;
  /** Experimental features */
  experimental?: ExperimentalConfig;
  /** Desktop notification settings */
  notification?: NotificationConfig;
  /** Web search provider: exa | tavily */
  websearchProvider?: string;
  /** Background task concurrency per model */
  backgroundConcurrency?: number;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

export interface ReviewResult {
  verdict: "pass" | "fail";
  summary: string;
  followUp: string[];
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export type SpecialistContractKind =
  | "execution"
  | "planning-note"
  | "research-note"
  | "documentation-plan"
  | "build-plan"
  | "test-plan"
  | "security-review"
  | "performance-plan"
  | "observability-plan"
  | "devops-plan"
  | "cicd-plan"
  | "migration-plan"
  | "git-plan"
  | "pr-plan"
  | "api-plan"
  | "db-plan"
  | "browser-report"
  | "accessibility-report"
  | "cost-plan"
  | "model-routing-plan"
  | "compliance-review";

export interface ToolBearingArtifact {
  summary: string;
  suggestedCommands?: string[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface RepoMapEntry {
  path: string;
  kind: "file" | "directory";
  language: string;
  symbols: string[];
  lineCount: number;
}

export interface PlannerTask {
  id: string;
  title: string;
  category: RoleCategory;
  roleHint?: string;
  /** Explicit task dependencies for CrewAI-style DAG execution */
  dependsOn?: string[];
  /** Whether this task can run concurrently */
  async?: boolean;
}

export interface PlannerArtifact {
  summary: string;
  tasks: PlannerTask[];
}

export interface ExecutorArtifact extends ToolBearingArtifact {
  kind: "execution";
  changes: string[];
}

export interface PlanningNoteArtifact extends ToolBearingArtifact {
  kind: "planning-note";
  decisions: string[];
  deliverables: string[];
  openQuestions: string[];
}

export interface ResearchNoteArtifact {
  kind: "research-note";
  summary: string;
  findings: string[];
  risks: string[];
  openQuestions: string[];
}

export interface DocumentationArtifact extends ToolBearingArtifact {
  kind: "documentation-plan";
  audience: string[];
  docChanges: string[];
  deliverables: string[];
  followUp: string[];
}

export interface BuildArtifact extends ToolBearingArtifact {
  kind: "build-plan";
  failures: string[];
  fixes: string[];
  verification: string[];
}

export interface TestArtifact extends ToolBearingArtifact {
  kind: "test-plan";
  coverage: string[];
  scenarios: string[];
  verification: string[];
}

export interface SecurityArtifact {
  kind: "security-review";
  summary: string;
  findings: string[];
  risks: string[];
  controls: string[];
  verification: string[];
}

export interface PerformanceArtifact extends ToolBearingArtifact {
  kind: "performance-plan";
  hotspots: string[];
  optimizations: string[];
  benchmarks: string[];
  verification: string[];
}

export interface ObservabilityArtifact extends ToolBearingArtifact {
  kind: "observability-plan";
  logs: string[];
  metrics: string[];
  traces: string[];
  alerts: string[];
}

export interface DevOpsArtifact extends ToolBearingArtifact {
  kind: "devops-plan";
  infrastructureChanges: string[];
  rollout: string[];
  safeguards: string[];
  verification: string[];
}

export interface CiCdArtifact extends ToolBearingArtifact {
  kind: "cicd-plan";
  pipelineChanges: string[];
  checks: string[];
  releaseSteps: string[];
  rollback: string[];
}

export interface MigrationArtifact extends ToolBearingArtifact {
  kind: "migration-plan";
  phases: string[];
  compatibility: string[];
  rollback: string[];
  verification: string[];
}

export interface GitArtifact {
  kind: "git-plan";
  summary: string;
  branchStrategy: string[];
  commitPlan: string[];
  diffFocus: string[];
  risks: string[];
}

export interface PrArtifact {
  kind: "pr-plan";
  summary: string;
  title: string;
  highlights: string[];
  rolloutNotes: string[];
  verification: string[];
}

export interface ApiArtifact {
  kind: "api-plan";
  summary: string;
  endpoints: string[];
  schemaChanges: string[];
  invariants: string[];
  openQuestions: string[];
}

export interface DatabaseArtifact extends ToolBearingArtifact {
  kind: "db-plan";
  schemaChanges: string[];
  migrationSteps: string[];
  dataRisks: string[];
  verification: string[];
}

export interface BrowserArtifact extends ToolBearingArtifact {
  kind: "browser-report";
  flows: string[];
  consoleFindings: string[];
  networkFindings: string[];
  screenshots: string[];
}

export interface AccessibilityArtifact {
  kind: "accessibility-report";
  summary: string;
  issues: string[];
  keyboardFlow: string[];
  screenReader: string[];
  fixes: string[];
}

export interface CostArtifact {
  kind: "cost-plan";
  summary: string;
  savings: string[];
  tradeoffs: string[];
  guardrails: string[];
}

export interface ModelRoutingArtifact {
  kind: "model-routing-plan";
  summary: string;
  routingChanges: string[];
  fallbackRules: string[];
  budgets: string[];
  metrics: string[];
}

export interface ComplianceArtifact {
  kind: "compliance-review";
  summary: string;
  controls: string[];
  gaps: string[];
  evidence: string[];
  followUp: string[];
}

export interface ResearchArtifact {
  summary: string;
  findings: string[];
  risks: string[];
}

export type SpecialistArtifact =
  | ExecutorArtifact
  | PlanningNoteArtifact
  | ResearchNoteArtifact
  | DocumentationArtifact
  | BuildArtifact
  | TestArtifact
  | SecurityArtifact
  | PerformanceArtifact
  | ObservabilityArtifact
  | DevOpsArtifact
  | CiCdArtifact
  | MigrationArtifact
  | GitArtifact
  | PrArtifact
  | ApiArtifact
  | DatabaseArtifact
  | BrowserArtifact
  | AccessibilityArtifact
  | CostArtifact
  | ModelRoutingArtifact
  | ComplianceArtifact;

export type RoleArtifact =
  | PlannerArtifact
  | ResearchArtifact
  | ReviewResult
  | SpecialistArtifact;

// ─── One-Prompt-to-App (Full-Stack Orchestration) ────────────────────────────

export type CreateMode = "interactive" | "auto" | "dry-run";

export interface CreateOptions {
  prompt: string;
  mode: CreateMode;
  /** Override project directory */
  outputDir?: string;
  /** Skip interactive questions (use all defaults) */
  skipQuestions?: boolean;
  /** Max retries per build phase */
  maxRetries?: number;
  /** Run quality gate at the end */
  qualityGate?: boolean;
}

export interface CreateResult {
  projectDir: string;
  projectName: string;
  success: boolean;
  /** Total files created */
  filesCreated: number;
  /** Total build duration in ms */
  durationMs: number;
  /** Quality gate score (0-100) */
  qualityScore: number;
  /** Quality gate grade */
  qualityGrade: "A" | "B" | "C" | "D" | "F";
}
