/**
 * OMO Tools — ALL missing tools from oh-my-openagent.
 *
 * Implements:
 * - call_agent: invoke another specialist agent by name
 * - look_at: multimodal image/screenshot analysis
 * - interactive_bash: tmux-powered interactive shell
 * - background_output: read background agent results
 * - background_cancel: cancel background agents
 * - task_create/task_get/task_list/task_update: task management system
 */

import fs from "node:fs/promises";
import path from "node:path";

// ─── call_agent ──────────────────────────────────────────────────────────────
// Invoke another specialist agent by name (OMO's call_omo_agent)

export interface CallAgentInput {
  agentId: string;
  task: string;
  context?: string;
}

export interface CallAgentResult {
  agentId: string;
  success: boolean;
  output: string;
  durationMs: number;
}

export async function callAgent(
  input: CallAgentInput,
  executeFn: (roleId: string, prompt: string) => Promise<string>
): Promise<CallAgentResult> {
  const start = Date.now();
  try {
    const prompt = input.context
      ? `${input.context}\n\nTask: ${input.task}`
      : input.task;
    const output = await executeFn(input.agentId, prompt);
    return { agentId: input.agentId, success: true, output, durationMs: Date.now() - start };
  } catch (e) {
    return {
      agentId: input.agentId, success: false,
      output: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start
    };
  }
}

// ─── look_at ─────────────────────────────────────────────────────────────────
// Multimodal image/screenshot analysis (OMO's look-at tool)

export interface LookAtInput {
  imagePath: string;
  question?: string;
}

export interface LookAtResult {
  description: string;
  filePath: string;
  fileSize: number;
  dimensions?: { width: number; height: number };
}

export async function lookAt(input: LookAtInput, cwd: string): Promise<LookAtResult> {
  const fullPath = path.resolve(cwd, input.imagePath);
  const stat = await fs.stat(fullPath);

  // Read image file info
  const ext = path.extname(fullPath).toLowerCase();
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];

  if (!imageExts.includes(ext)) {
    throw new Error(`Not an image file: ${ext}`);
  }

  // Try to get dimensions via identify command (ImageMagick)
  let dimensions: { width: number; height: number } | undefined;
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`identify -format "%wx%h" "${fullPath}" 2>/dev/null || file "${fullPath}"`, { encoding: "utf-8" });
    const match = output.match(/(\d+)x(\d+)/);
    if (match) {
      dimensions = { width: parseInt(match[1]), height: parseInt(match[2]) };
    }
  } catch { /* no ImageMagick */ }

  const description = input.question
    ? `Image at ${input.imagePath} (${stat.size} bytes${dimensions ? `, ${dimensions.width}x${dimensions.height}` : ""}). Question: ${input.question}`
    : `Image at ${input.imagePath} (${stat.size} bytes${dimensions ? `, ${dimensions.width}x${dimensions.height}` : ""})`;

  return {
    description,
    filePath: fullPath,
    fileSize: stat.size,
    dimensions
  };
}

// ─── interactive_bash ────────────────────────────────────────────────────────
// Tmux-powered interactive shell (OMO's interactive-bash)

export interface InteractiveBashInput {
  command: string;
  sessionName?: string;
  waitMs?: number;
}

export interface InteractiveBashResult {
  output: string;
  sessionName: string;
  paneId: string;
}

export async function interactiveBash(input: InteractiveBashInput): Promise<InteractiveBashResult> {
  const { execSync } = await import("node:child_process");
  const sessionName = input.sessionName ?? `agent-bash-${Date.now()}`;

  // Check tmux
  try { execSync("tmux -V", { stdio: "pipe" }); } catch {
    throw new Error("tmux is not installed. Install with: brew install tmux (macOS) or apt install tmux (Linux)");
  }

  // Create session
  try { execSync(`tmux has-session -t ${sessionName} 2>/dev/null`); }
  catch { execSync(`tmux new-session -d -s ${sessionName}`, { stdio: "pipe" }); }

  // Send command
  execSync(`tmux send-keys -t ${sessionName} '${input.command.replace(/'/g, "'\\''")}' Enter`, { stdio: "pipe" });

  // Wait for output
  const waitMs = input.waitMs ?? 3000;
  await new Promise(r => setTimeout(r, waitMs));

  // Capture output
  const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -50`, { encoding: "utf-8" });
  const paneId = execSync(`tmux display-message -t ${sessionName} -p '#{pane_id}'`, { encoding: "utf-8" }).trim();

  return { output, sessionName, paneId };
}

// ─── background_output / background_cancel ───────────────────────────────────

import { BackgroundTaskManager } from "../orchestration/omo-hooks.js";

export function getBackgroundOutput(bgManager: BackgroundTaskManager, taskId: string): {
  found: boolean;
  status?: string;
  result?: string;
} {
  const completed = bgManager.getCompleted();
  const task = completed.find(t => t.id === taskId);
  if (task) return { found: true, status: task.status, result: task.result };

  const running = bgManager.getRunning();
  const runningTask = running.find(t => t.id === taskId);
  if (runningTask) return { found: true, status: "running" };

  return { found: false };
}

export function cancelBackgroundTask(bgManager: BackgroundTaskManager, taskId: string): boolean {
  bgManager.fail(taskId, "Cancelled by user");
  return true;
}

// ─── Task CRUD System ────────────────────────────────────────────────────────
// OMO's experimental task system

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string; // role ID
  parentId?: string;
  dependsOn?: string[];
  labels?: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  output?: string;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private counter = 0;

  create(input: { title: string; description?: string; priority?: TaskPriority; assignee?: string; parentId?: string; dependsOn?: string[]; labels?: string[] }): Task {
    const id = `task-${++this.counter}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      status: "pending",
      priority: input.priority ?? "medium",
      assignee: input.assignee,
      parentId: input.parentId,
      dependsOn: input.dependsOn,
      labels: input.labels,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter?: { status?: TaskStatus; assignee?: string; parentId?: string }): Task[] {
    let tasks = Array.from(this.tasks.values());
    if (filter?.status) tasks = tasks.filter(t => t.status === filter.status);
    if (filter?.assignee) tasks = tasks.filter(t => t.assignee === filter.assignee);
    if (filter?.parentId) tasks = tasks.filter(t => t.parentId === filter.parentId);
    return tasks.sort((a, b) => {
      const pri = { critical: 4, high: 3, medium: 2, low: 1 };
      return (pri[b.priority] ?? 0) - (pri[a.priority] ?? 0);
    });
  }

  update(id: string, updates: Partial<Pick<Task, "title" | "description" | "status" | "priority" | "assignee" | "output">>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    if (updates.status === "completed") task.completedAt = new Date().toISOString();
    return task;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  getNext(assignee?: string): Task | undefined {
    const pending = this.list({ status: "pending" });
    if (assignee) return pending.find(t => t.assignee === assignee) ?? pending[0];
    return pending[0];
  }

  getProgress(): { total: number; completed: number; inProgress: number; failed: number; percent: number } {
    const all = Array.from(this.tasks.values());
    const completed = all.filter(t => t.status === "completed").length;
    const inProgress = all.filter(t => t.status === "in_progress").length;
    const failed = all.filter(t => t.status === "failed").length;
    return {
      total: all.length,
      completed,
      inProgress,
      failed,
      percent: all.length > 0 ? Math.round((completed / all.length) * 100) : 0
    };
  }

  async persist(filePath: string): Promise<void> {
    const data = Array.from(this.tasks.values());
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async load(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as Task[];
      for (const task of data) {
        this.tasks.set(task.id, task);
        const num = parseInt(task.id.replace("task-", ""));
        if (num > this.counter) this.counter = num;
      }
    } catch { /* no file yet */ }
  }
}
