import fs from "node:fs/promises";
import path from "node:path";

import { getGlobalIndexPath, getProjectAgentDir, getSessionsDir, getTasksDir } from "../core/paths.js";
import type { JsonLineEvent, SessionConfig, SessionRecord, TaskRecord } from "../core/types.js";
import { createId, ensureDir, fileExists, nowIso } from "../core/utils.js";

export class SessionStore {
  constructor(
    private readonly cwd: string,
    private readonly config: SessionConfig
  ) {}

  async ensure(): Promise<void> {
    await ensureDir(getProjectAgentDir(this.cwd, this.config.localDirName));
    await ensureDir(getSessionsDir(this.cwd, this.config.localDirName));
    await ensureDir(getTasksDir(this.cwd, this.config.localDirName));
    await ensureDir(path.dirname(getGlobalIndexPath(this.config.globalNamespace)));
  }

  async createSession(task: string, resumedFrom?: string): Promise<SessionRecord> {
    await this.ensure();
    const session: SessionRecord = {
      id: createId("ses"),
      cwd: this.cwd,
      task,
      status: "running",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      resumedFrom,
      tasks: [],
      pid: process.pid
    };
    await this.saveSnapshot(session);
    await this.appendEvent(session.id, {
      type: resumedFrom ? "session.resumed" : "session.started",
      at: nowIso(),
      payload: { task, resumedFrom }
    });
    return session;
  }

  async saveSnapshot(session: SessionRecord): Promise<void> {
    await this.ensure();
    session.updatedAt = nowIso();
    await this.writeJsonAtomic(this.getSnapshotPath(session.id), session);
    const index = await this.readGlobalIndex();
    index[session.id] = {
      cwd: session.cwd,
      task: session.task,
      status: session.status,
      updatedAt: session.updatedAt
    };
    await this.writeJsonAtomic(getGlobalIndexPath(this.config.globalNamespace), index);
  }

  async loadSnapshot(sessionId: string): Promise<SessionRecord | null> {
    const snapshotPath = this.getSnapshotPath(sessionId);
    if (!(await fileExists(snapshotPath))) {
      return null;
    }
    const raw = await fs.readFile(snapshotPath, "utf8");
    try { return JSON.parse(raw) as SessionRecord; } catch { return null; }
  }

  async listSessions(cwd?: string): Promise<Array<{ id: string; cwd: string; task: string; status: string; updatedAt: string }>> {
    const index = await this.readGlobalIndex();
    return Object.entries(index)
      .map(([id, value]) => ({ id, ...value }))
      .filter((session) => !cwd || session.cwd === cwd);
  }

  async appendEvent(sessionId: string, event: JsonLineEvent): Promise<void> {
    await this.ensure();
    await fs.appendFile(this.getEventLogPath(sessionId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async readEvents(sessionId: string): Promise<JsonLineEvent[]> {
    const filePath = this.getEventLogPath(sessionId);
    if (!(await fileExists(filePath))) {
      return [];
    }
    const raw = await fs.readFile(filePath, "utf8");
    const events: JsonLineEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as JsonLineEvent); } catch { /* skip corrupt line */ }
    }
    return events;
  }

  async createTask(sessionId: string, role: string, category: TaskRecord["category"], provider: TaskRecord["provider"], prompt: string, transport: TaskRecord["transport"]): Promise<TaskRecord> {
    const task: TaskRecord = {
      id: createId("task"),
      sessionId,
      role,
      category,
      provider,
      prompt,
      status: "pending",
      transport,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await this.writeJsonAtomic(this.getTaskPath(task.id), task);
    return task;
  }

  async saveTask(task: TaskRecord): Promise<void> {
    task.updatedAt = nowIso();
    await this.writeJsonAtomic(this.getTaskPath(task.id), task);
  }

  async loadTask(taskId: string): Promise<TaskRecord | null> {
    const filePath = this.getTaskPath(taskId);
    if (!(await fileExists(filePath))) {
      return null;
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as TaskRecord;
  }

  async writeArtifact(taskId: string, data: unknown): Promise<string> {
    const filePath = path.join(getTasksDir(this.cwd, this.config.localDirName), `${taskId}.artifact.json`);
    await this.writeJsonAtomic(filePath, data);
    return filePath;
  }

  async readArtifact(taskId: string): Promise<unknown | null> {
    const filePath = path.join(getTasksDir(this.cwd, this.config.localDirName), `${taskId}.artifact.json`);
    if (!(await fileExists(filePath))) {
      return null;
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  }

  async writePrompt(taskId: string, prompt: string): Promise<string> {
    const filePath = path.join(getTasksDir(this.cwd, this.config.localDirName), `${taskId}.prompt.txt`);
    await fs.writeFile(filePath, prompt, "utf8");
    return filePath;
  }

  private getSnapshotPath(sessionId: string): string {
    return path.join(getSessionsDir(this.cwd, this.config.localDirName), `${sessionId}.json`);
  }

  private getEventLogPath(sessionId: string): string {
    return path.join(getSessionsDir(this.cwd, this.config.localDirName), `${sessionId}.jsonl`);
  }

  private getTaskPath(taskId: string): string {
    return path.join(getTasksDir(this.cwd, this.config.localDirName), `${taskId}.json`);
  }

  private async readGlobalIndex(): Promise<Record<string, { cwd: string; task: string; status: string; updatedAt: string }>> {
    const indexPath = getGlobalIndexPath(this.config.globalNamespace);
    if (!(await fileExists(indexPath))) {
      return {};
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await fs.readFile(indexPath, "utf8");
      if (raw.trim().length === 0) {
        return {};
      }
      try {
        return JSON.parse(raw) as Record<string, { cwd: string; task: string; status: string; updatedAt: string }>;
      } catch (error) {
        if (attempt === 2 || !(error instanceof SyntaxError)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return {};
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${createId("tmp")}`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  }
}
