/**
 * Skill Chaining Protocol + Cron Scheduler + E2E Test Generation + Auto Git Commits.
 *
 * Covers remaining gaps:
 * - Skill orchestration (Solo Sprint, Domain Deep-Dive, Multi-Agent Handoff, Chain)
 * - Cron/scheduler for recurring tasks
 * - Playwright E2E test generation (not just running)
 * - Plan versioning/branching
 * - Context caching for API cost reduction
 * - Git commit message auto-generation
 *
 * Sources: claude-skills, openclaw, everything-claude-code, plandex
 */

// ─── Skill Chaining Protocol ─────────────────────────────────────────────────

export type SkillChainMode = "solo-sprint" | "domain-deep-dive" | "multi-agent-handoff" | "skill-chain";

export interface SkillChainStep {
  skillName: string;
  roleId: string;
  input: string;
  dependsOn?: string[];
  /** Output of this step feeds into the next */
  outputKey: string;
}

export interface SkillChainPlan {
  mode: SkillChainMode;
  steps: SkillChainStep[];
  description: string;
}

export function buildSkillChain(task: string, availableSkills: string[]): SkillChainPlan {
  const lower = task.toLowerCase();

  // Solo Sprint: single skill, single pass
  if (/quick|simple|one.file|typo|rename/i.test(lower)) {
    return {
      mode: "solo-sprint",
      steps: [{ skillName: "executor", roleId: "executor", input: task, outputKey: "result" }],
      description: "Single-pass execution"
    };
  }

  // Domain Deep-Dive: research → plan → execute → verify
  if (/investigate|research|understand|analyze|audit/i.test(lower)) {
    return {
      mode: "domain-deep-dive",
      steps: [
        { skillName: "research", roleId: "researcher", input: task, outputKey: "findings" },
        { skillName: "analysis", roleId: "planner", input: "Based on findings: " + task, dependsOn: ["findings"], outputKey: "plan" },
        { skillName: "report", roleId: "docs-writer", input: "Document findings", dependsOn: ["plan"], outputKey: "report" },
      ],
      description: "Deep research → analysis → documentation"
    };
  }

  // Multi-Agent Handoff: plan → parallel execution → review
  if (/build|create|implement|add feature/i.test(lower) && availableSkills.length > 2) {
    return {
      mode: "multi-agent-handoff",
      steps: [
        { skillName: "planning", roleId: "planner", input: task, outputKey: "plan" },
        { skillName: "execution", roleId: "executor", input: task, dependsOn: ["plan"], outputKey: "code" },
        { skillName: "testing", roleId: "test-engineer", input: "Write tests", dependsOn: ["code"], outputKey: "tests" },
        { skillName: "review", roleId: "reviewer", input: "Review all", dependsOn: ["code", "tests"], outputKey: "review" },
      ],
      description: "Plan → Execute → Test → Review handoff"
    };
  }

  // Skill Chain: sequential skill application
  return {
    mode: "skill-chain",
    steps: [
      { skillName: "plan", roleId: "planner", input: task, outputKey: "plan" },
      { skillName: "execute", roleId: "executor", input: task, dependsOn: ["plan"], outputKey: "result" },
    ],
    description: "Sequential skill chain"
  };
}

// ─── Cron Scheduler ──────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  schedule: string;       // cron expression or "every 5m"
  task: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  maxRuns: number;        // 0 = unlimited
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private counter = 0;

  addJob(schedule: string, task: string, maxRuns = 0): CronJob {
    const id = `cron-${++this.counter}`;
    const job: CronJob = {
      id, schedule, task, enabled: true,
      lastRunAt: null, nextRunAt: null, runCount: 0, maxRuns
    };
    this.jobs.set(id, job);
    return job;
  }

  startJob(jobId: string, executeFn: (task: string) => Promise<void>): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.enabled) return false;

    const intervalMs = this.parseSchedule(job.schedule);
    if (intervalMs <= 0) return false;

    const timer = setInterval(async () => {
      if (!job.enabled) { clearInterval(timer); return; }
      if (job.maxRuns > 0 && job.runCount >= job.maxRuns) { clearInterval(timer); job.enabled = false; return; }

      job.lastRunAt = new Date().toISOString();
      job.runCount++;
      try { await executeFn(job.task); } catch { /* log but continue */ }
    }, intervalMs);

    this.timers.set(jobId, timer);
    return true;
  }

  stopJob(jobId: string): boolean {
    const timer = this.timers.get(jobId);
    if (timer) { clearInterval(timer); this.timers.delete(jobId); }
    const job = this.jobs.get(jobId);
    if (job) { job.enabled = false; return true; }
    return false;
  }

  stopAll(): void {
    for (const [id, timer] of this.timers) { clearInterval(timer); }
    this.timers.clear();
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  private parseSchedule(schedule: string): number {
    // Simple interval parsing: "every 5m", "every 1h", "every 30s"
    const match = schedule.match(/every\s+(\d+)\s*(s|m|h|min|sec|hour)/i);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === "s" || unit === "sec") return value * 1000;
      if (unit === "m" || unit === "min") return value * 60 * 1000;
      if (unit === "h" || unit === "hour") return value * 60 * 60 * 1000;
    }
    return 0;
  }
}

// ─── E2E Test Generation ─────────────────────────────────────────────────────

export function generatePlaywrightTest(params: {
  pageName: string;
  url: string;
  actions: Array<{ type: "click" | "fill" | "navigate" | "assert"; selector?: string; value?: string; expected?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test('${params.pageName}', async ({ page }) => {`);
  lines.push(`  await page.goto('${params.url}');`);

  for (const action of params.actions) {
    switch (action.type) {
      case "navigate":
        lines.push(`  await page.goto('${action.value}');`);
        break;
      case "click":
        lines.push(`  await page.click('${action.selector}');`);
        break;
      case "fill":
        lines.push(`  await page.fill('${action.selector}', '${action.value}');`);
        break;
      case "assert":
        if (action.selector && action.expected) {
          lines.push(`  await expect(page.locator('${action.selector}')).toContainText('${action.expected}');`);
        } else if (action.expected) {
          lines.push(`  await expect(page).toHaveTitle(/${action.expected}/);`);
        }
        break;
    }
  }

  lines.push(`});`);
  return lines.join("\n");
}

export function generateE2ETestSuite(pages: Array<{ name: string; path: string; assertions: string[] }>): string {
  const tests: string[] = [];
  tests.push(`import { test, expect } from '@playwright/test';`);
  tests.push(``);

  for (const page of pages) {
    tests.push(`test('${page.name} page renders', async ({ page: p }) => {`);
    tests.push(`  await p.goto('http://localhost:3000${page.path}');`);
    tests.push(`  await p.waitForLoadState('networkidle');`);
    for (const assertion of page.assertions) {
      tests.push(`  await expect(p.locator('body')).toContainText('${assertion}');`);
    }
    tests.push(`});`);
    tests.push(``);
  }

  return tests.join("\n");
}

// ─── Plan Version Control ────────────────────────────────────────────────────

export interface PlanVersion {
  id: string;
  parentId: string | null;
  branch: string;
  plan: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export class PlanVersionControl {
  private versions = new Map<string, PlanVersion>();
  private currentBranch = "main";
  private counter = 0;

  commit(plan: string, metadata?: Record<string, unknown>): PlanVersion {
    const id = `pv-${++this.counter}`;
    const parent = this.getLatest(this.currentBranch);
    const version: PlanVersion = {
      id, parentId: parent?.id ?? null, branch: this.currentBranch,
      plan, createdAt: new Date().toISOString(), metadata: metadata ?? {}
    };
    this.versions.set(id, version);
    return version;
  }

  branch(name: string): void {
    this.currentBranch = name;
  }

  getLatest(branchName?: string): PlanVersion | null {
    const branch = branchName ?? this.currentBranch;
    const branchVersions = Array.from(this.versions.values())
      .filter(v => v.branch === branch)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return branchVersions[0] ?? null;
  }

  getHistory(branchName?: string): PlanVersion[] {
    const branch = branchName ?? this.currentBranch;
    return Array.from(this.versions.values())
      .filter(v => v.branch === branch)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listBranches(): string[] {
    return [...new Set(Array.from(this.versions.values()).map(v => v.branch))];
  }

  checkout(branchName: string): PlanVersion | null {
    this.currentBranch = branchName;
    return this.getLatest(branchName);
  }
}

// ─── Context Caching ─────────────────────────────────────────────────────────

export interface CachedContext {
  key: string;
  content: string;
  tokenCount: number;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
}

export class ContextCache {
  private cache = new Map<string, CachedContext>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = 50, ttlMs = 300_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); return null; }
    entry.hitCount++;
    return entry.content;
  }

  set(key: string, content: string, tokenCount: number): void {
    if (this.cache.size >= this.maxEntries) {
      // Evict least-hit entry
      let minHits = Infinity;
      let minKey = "";
      for (const [k, v] of this.cache) {
        if (v.hitCount < minHits) { minHits = v.hitCount; minKey = k; }
      }
      if (minKey) this.cache.delete(minKey);
    }

    this.cache.set(key, {
      key, content, tokenCount,
      createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, hitCount: 0
    });
  }

  getSavings(): { totalHits: number; estimatedTokensSaved: number } {
    let totalHits = 0;
    let tokensSaved = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hitCount;
      tokensSaved += entry.hitCount * entry.tokenCount;
    }
    return { totalHits, estimatedTokensSaved: tokensSaved };
  }

  clear(): void { this.cache.clear(); }
}

// ─── Git Commit Message Generation ───────────────────────────────────────────

export function generateCommitMessage(changes: string[]): string {
  if (changes.length === 0) return "chore: update files";

  // Detect change type
  const allChanges = changes.join(" ").toLowerCase();

  let type = "chore";
  if (/\b(fix|bug|patch|hotfix)\b/.test(allChanges)) type = "fix";
  else if (/\b(add|create|new|implement|feature)\b/.test(allChanges)) type = "feat";
  else if (/\b(refactor|restructure|clean|simplify)\b/.test(allChanges)) type = "refactor";
  else if (/\b(test|spec|coverage)\b/.test(allChanges)) type = "test";
  else if (/\b(doc|readme|comment)\b/.test(allChanges)) type = "docs";
  else if (/\b(style|format|lint)\b/.test(allChanges)) type = "style";
  else if (/\b(build|ci|deploy|pipeline)\b/.test(allChanges)) type = "ci";
  else if (/\b(perf|optim|speed|fast)\b/.test(allChanges)) type = "perf";

  // Extract scope from file paths
  const paths = changes.filter(c => c.includes("/"));
  let scope = "";
  if (paths.length > 0) {
    const dirs = paths.map(p => p.split("/").slice(0, -1).join("/")).filter(Boolean);
    const common = dirs.length > 0 ? dirs[0].split("/").pop() ?? "" : "";
    if (common && common.length < 20) scope = `(${common})`;
  }

  // Build description
  const description = changes.length === 1
    ? changes[0].replace(/^(created|modified|updated|deleted)\s+/i, "").split("/").pop() ?? "update"
    : `${changes.length} files`;

  return `${type}${scope}: ${description}`;
}

export function generateDetailedCommitBody(changes: string[], task: string): string {
  return [
    generateCommitMessage(changes),
    "",
    `Task: ${task}`,
    "",
    "Changes:",
    ...changes.map(c => `- ${c}`),
  ].join("\n");
}
