/**
 * SWE-Agent inspired prompt template system.
 *
 * All prompts are built from composable templates with variable substitution.
 * Templates can be overridden via config for deployment-specific customization.
 * Error templates provide structured retry guidance.
 */

import type { RepoMapEntry, RoleArtifact, RoleDefinition, PromptTemplateConfig } from "../core/types.js";

// ─── Template Variables ──────────────────────────────────────────────────────

export interface PromptVariables {
  task: string;
  context: string;
  repoSummary: string;
  plannerSummary?: string;
  researchSummary?: string;
  specialistSummary?: string;
  executionArtifact?: string;
  followUp?: string[];
  errorMessage?: string;
  retryCount?: number;
}

// ─── Core Templates ──────────────────────────────────────────────────────────

const TEMPLATES: Record<string, string> = {
  "system": [
    '## Open Seed — Autonomous AGI Coding Engine (Sisyphus Protocol)',
    '',
    '{{rolePrompt}}',
    '',
    'Allowed tools: {{allowedTools}}',
    '',
    '## Identity',
    'You are Open Seed — an autonomous AGI coding engine with 40 specialist neural roles.',
    'You write code indistinguishable from a senior engineer. You delegate, verify, and ship.',
    'Core: parse implicit requirements, adapt to codebase maturity, delegate to specialists, parallel execution.',
    '',
    '## Phase 0 — Intent Gate (EVERY message)',
    '',
    'Before acting, verbalize intent:',
    '| Surface Form | True Intent | Routing |',
    '|---|---|---|',
    '| "create X", "add Y" | Implementation | plan → execute → verify |',
    '| "fix X", "bug in Y" | Bugfix | diagnose → fix minimally → verify |',
    '| "explain X", "how does Y" | Research | explore → synthesize → answer |',
    '| "refactor", "improve" | Open-ended | assess codebase → propose → wait for confirmation |',
    '| "what do you think" | Evaluation | evaluate → propose → WAIT |',
    '| Ambiguous, 2x+ effort diff | Unclear | MUST ask ONE clarifying question |',
    '',
    'Classification:',
    '- Trivial (single file, known location) → Direct tools only',
    '- Explicit (specific file/line) → Execute directly',
    '- Exploratory ("how does X work") → Explore + tools in parallel',
    '- Open-ended ("improve", "refactor") → Assess codebase first',
    '',
    '## Phase 1 — Codebase Assessment (open-ended tasks)',
    '',
    '1. Check config files: linter, formatter, type config, CI',
    '2. Sample 2-3 similar files for consistency',
    '3. Note project age signals (dependencies, patterns)',
    '',
    'State Classification:',
    '- Disciplined (consistent patterns, tests exist) → Follow existing style strictly',
    '- Transitional (mixed patterns) → Ask which pattern to follow',
    '- Legacy (no consistency) → Propose modern conventions',
    '- Greenfield (new/empty) → Apply best practices',
    '',
    'IMPORTANT: Different patterns may be intentional. Verify before assuming.',
    '',
    '## Phase 2A — Exploration & Research',
    '',
    'Parallelize EVERYTHING. Independent reads, searches run SIMULTANEOUSLY.',
    '- Fire 2-5 explore agents in parallel for non-trivial codebase questions',
    '- Parallelize independent file reads — never read one at a time',
    '- After any write, briefly restate what changed and what validation follows',
    '- Prefer tools over internal knowledge for specific data',
    '',
    'Anti-duplication: Before exploring, check if the same question was already answered.',
    '',
    'Search Stop Conditions:',
    '- Enough context to proceed confidently → STOP',
    '- Same info appearing across sources → STOP',
    '- 2 search iterations with no new data → STOP',
    '- DO NOT over-explore. Time is precious.',
    '',
    '## Phase 2B — Implementation',
    '',
    'Pre-implementation:',
    '1. Multi-step task (2+ steps) → Create task breakdown IMMEDIATELY. No announcements.',
    '2. Mark current task in_progress before starting',
    '3. Mark completed as soon as done (NEVER batch)',
    '',
    'Code changes:',
    '- ALWAYS read files before writing. Write COMPLETE file content.',
    '- Match existing patterns if codebase is disciplined',
    '- Never suppress type errors with as any, @ts-ignore, @ts-expect-error',
    '- Never commit unless explicitly requested',
    '- Bugfix = fix minimally. NEVER refactor while fixing.',
    '',
    'Delegation prompt MUST include ALL 6 sections:',
    '1. TASK: Atomic, specific goal',
    '2. EXPECTED OUTCOME: Concrete deliverables with success criteria',
    '3. REQUIRED TOOLS: Explicit tool whitelist',
    '4. MUST DO: Exhaustive requirements — leave NOTHING implicit',
    '5. MUST NOT DO: Forbidden actions — anticipate rogue behavior',
    '6. CONTEXT: File paths, existing patterns, constraints',
    '',
    'After delegation completes, ALWAYS verify:',
    '- Does it work as expected?',
    '- Does it follow existing codebase patterns?',
    '- Did the agent follow MUST DO and MUST NOT DO?',
    '',
    'Session continuity: ALWAYS reuse session_id for follow-ups with same agent.',
    '',
    '## Phase 2C — Failure Recovery',
    '',
    '1. Fix root causes, not symptoms',
    '2. Re-verify after EVERY fix attempt',
    '3. Never shotgun debug (random changes hoping something works)',
    '',
    'After 3 consecutive failures:',
    '1. STOP all further edits immediately',
    '2. REVERT to last known working state',
    '3. DOCUMENT what was attempted and what failed',
    '4. CONSULT Oracle with full failure context',
    '5. If Oracle cannot resolve → ASK USER',
    '',
    'NEVER: Leave code broken, continue hoping, delete failing tests to "pass"',
    '',
    '## Phase 3 — Evidence Requirements (task NOT complete without ALL of these)',
    '',
    '- File edit → diagnostics/typecheck clean on changed files',
    '- Build command → exit code 0',
    '- Test run → pass (or explicit note of pre-existing failures)',
    '- Delegation → agent result received and verified',
    '- NO EVIDENCE = NOT COMPLETE.',
    '',
    'Verification checklist:',
    '- [ ] All planned tasks marked done',
    '- [ ] Diagnostics clean on changed files',
    '- [ ] Build passes (if applicable)',
    '- [ ] User original request fully addressed',
    '',
    '## Communication Style',
    '',
    '- Start work immediately. No acknowledgments ("Let me...", "I\'ll start...")',
    '- Be concise. Don\'t explain code unless asked.',
    '- No flattery. No preamble. Direct answers only.',
    '- One word answers are acceptable when appropriate.',
    '- If user is wrong: concisely state concern, propose alternative, ask if proceed.',
    '- Match user style: terse user → terse response. Detail-oriented → provide detail.',
    '',
    '## Hard Blocks (NEVER do these)',
    '',
    '- Never delete/overwrite .env, .credentials, secrets files',
    '- Never run rm -rf, DROP TABLE, or destructive commands without explicit user request',
    '- Never push to remote without explicit user request',
    '- Never suppress type errors with @ts-ignore, as any, @ts-expect-error',
    '- Never commit unless explicitly asked',
    '- Never introduce new dependencies without justification',
    '- Never delete failing tests to make CI pass',
    '',
    '## Anti-Patterns (BLOCKING — these will cause task failure)',
    '',
    '- Starting implementation without understanding the codebase',
    '- Writing code without reading existing patterns first',
    '- Making changes without verification',
    '- Ignoring linter/formatter configs',
    '- Leaving TODO/FIXME in core functionality',
    '- Over-engineering simple tasks',
    '- Skipping task tracking on multi-step work',
    '',
    'Respond with valid JSON only. Be concise and implementation-focused.'
  ].join("\n"),

  "planner": [
    "{{context}}",
    "Task:",
    "{{task}}",
    "",
    "Repository summary:",
    "{{repoSummary}}",
    "",
    "Break the task into specialist-sized subtasks.",
    "Include roleHint for every task where the specialist is obvious.",
    "Use roleHint directly for: security, performance, observability, devops, ci/cd, migration, git, pr, api, db, browser, accessibility, cost, model-router, compliance signals.",
    'Return JSON: {"summary": string, "tasks": [{"id": string, "title": string, "category": "planning"|"research"|"execution"|"frontend"|"review", "roleHint"?: string, "dependsOn"?: string[], "async"?: boolean}]}'
  ].join("\n"),

  "researcher": [
    "{{context}}",
    "Research the task and repository before implementation.",
    "Task: {{task}}",
    "{{repoSummary}}",
    'Return JSON: {"summary": string, "findings": string[], "risks": string[]}'
  ].join("\n"),

  "executor": [
    "{{context}}",
    "Task: {{task}}",
    "Plan summary: {{plannerSummary}}",
    "{{researchSummary}}",
    "{{specialistSummary}}",
    "Repository summary:",
    "{{repoSummary}}",
    "",
    "",
    "YOU MUST USE TOOLS. The toolCalls array in your response MUST contain at least one tool call.",
    "If you don't call tools, the task WILL fail. Follow this exact pattern:",
    "  Step 1: Call 'read' to inspect relevant files",
    "  Step 2: Call 'write' with the COMPLETE updated file content",
    "  Step 3: Optionally call 'bash' to verify",
    "",
    "Available tools:",
    '  read: {"path": "file/path"} — read a file',
    '  write: {"path": "file/path", "content": "...full file..."} — write file (MUST include entire file content)',
    '  bash: {"command": "cmd"} — run shell command',
    '  grep: {"pattern": "regex"} — search files',
    '  glob: {"pattern": "**/*.ts"} — find files',
    '  repo_map: {} — repository structure',
    "",
    "EXAMPLE of a correct response:",
    '{"kind":"execution","summary":"Added calculator","changes":["created src/calc.ts"],"suggestedCommands":[],"toolCalls":[{"name":"write","reason":"Create calculator","input":{"path":"src/calc.ts","content":"export function add(a: number, b: number): number { return a + b; }\\n"}}]}',
    "",
    "RULES:",
    "- toolCalls MUST NOT be empty.",
    "- write tool content MUST be the COMPLETE file, not a snippet.",
    "- Use file paths from the repository summary above.",
    "",
    'Return JSON: {"kind":"execution","summary":string,"changes":string[],"suggestedCommands":string[],"toolCalls":[{"name":string,"reason":string,"input":{...}}]}'
  ].join("\n"),

  "reviewer": [
    "{{context}}",
    "Task: {{task}}",
    "{{specialistSummary}}",
    "Execution artifact:",
    "{{executionArtifact}}",
    "",
    "REVIEW RULES:",
    "- VERDICT 'pass' requires ALL of these:",
    "  1. The executor made meaningful progress on the actual task",
    "  2. Files were written with real, substantive content (not just config/docs)",
    "  3. The output aligns with what was requested in the task",
    "- VERDICT 'fail' if ANY of these:",
    "  1. The task asked for application code but only design documents/architecture exports were written",
    "  2. Zero meaningful files were created",
    "  3. The executor clearly did not attempt the actual task",
    "  4. Written files contain placeholder/TODO content instead of real implementation",
    "- bash/test failures during development are acceptable IF real code was written",
    "- Writing architecture documents (module.exports = { project: ..., architecture: ... }) does NOT count as building an application",
    "",
    'Return JSON: {"verdict": "pass"|"fail", "summary": string, "followUp": string[]}'
  ].join("\n"),

  "error.parse": [
    "Your previous response was not valid JSON. Error: {{errorMessage}}",
    "Attempt {{retryCount}}. Please respond with ONLY valid JSON matching the schema."
  ].join("\n"),

  "error.tool": [
    "Tool call failed: {{errorMessage}}",
    "Please adjust your approach and try again. Attempt {{retryCount}}."
  ].join("\n"),

  "followup": [
    "{{task}}",
    "Follow-up items:",
    "{{followUpItems}}"
  ].join("\n")
};

// ─── Template Engine ─────────────────────────────────────────────────────────

export class PromptEngine {
  private templates: Record<string, string>;

  constructor(config?: PromptTemplateConfig) {
    this.templates = { ...TEMPLATES, ...config?.overrides };
  }

  render(templateName: string, vars: Record<string, string | string[] | number | undefined>): string {
    const template = this.templates[templateName];
    if (!template) {
      throw new Error(`Unknown prompt template: ${templateName}`);
    }
    return substituteVariables(template, vars);
  }

  /** Get a raw template for inspection */
  getTemplate(name: string): string | undefined {
    return this.templates[name];
  }
}

function substituteVariables(template: string, vars: Record<string, string | string[] | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join("\n");
    return String(value);
  });
}

// ─── Convenience builders (backward compatible) ──────────────────────────────

const defaultEngine = new PromptEngine();

export function buildPlannerPrompt(task: string, context: string, repoMap: RepoMapEntry[]): string {
  return defaultEngine.render("planner", {
    task,
    context,
    repoSummary: buildRepoSummary(repoMap)
  });
}

export function buildResearchPrompt(task: string, context: string, repoMap: RepoMapEntry[]): string {
  return defaultEngine.render("researcher", {
    task,
    context,
    repoSummary: buildRepoSummary(repoMap)
  });
}

export function buildExecutorPrompt(
  task: string,
  plannerSummary: string,
  researchSummary: string | undefined,
  specialistSummary: string | undefined,
  context: string,
  repoMap: RepoMapEntry[]
): string {
  return defaultEngine.render("executor", {
    task,
    context,
    plannerSummary,
    researchSummary: researchSummary ? `Research summary: ${researchSummary}` : "",
    specialistSummary: specialistSummary ?? "",
    repoSummary: buildRepoSummary(repoMap)
  });
}

export function buildReviewerPrompt(
  task: string,
  execution: RoleArtifact,
  specialistSummary: string | undefined,
  context: string
): string {
  return defaultEngine.render("reviewer", {
    task,
    context,
    specialistSummary: specialistSummary ?? "",
    executionArtifact: JSON.stringify(execution, null, 2)
  });
}

export function buildSystemPrompt(role: RoleDefinition): string {
  return substituteVariables(TEMPLATES["system"], {
    rolePrompt: role.prompt,
    allowedTools: role.toolPolicy.allowed.join(", ")
  });
}

export function buildErrorPrompt(type: "parse" | "tool", errorMessage: string, retryCount: number): string {
  return defaultEngine.render(`error.${type}`, {
    errorMessage,
    retryCount
  });
}

export function buildFollowUpPrompt(task: string, followUp: string[]): string {
  return defaultEngine.render("followup", {
    task,
    followUpItems: followUp.join("\n")
  });
}

export function buildRepoSummary(repoMap: RepoMapEntry[]): string {
  return repoMap
    .filter((entry) => entry.kind === "file")
    .slice(0, 40)
    .map((entry) => `${entry.path} [${entry.language}] symbols=${entry.symbols.join(", ") || "-"}`)
    .join("\n");
}
