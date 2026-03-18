/**
 * Stateful Checkpoint System (inspired by LangGraph).
 *
 * Captures full orchestration state at node boundaries so that:
 * - Sessions can be recovered from any checkpoint after crash
 * - Human-in-the-loop can pause/resume at interrupt points
 * - Branching: fork from a checkpoint to try alternative approaches
 *
 * Storage: JSON files under .agent/checkpoints/<sessionId>/
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createId, ensureDir, fileExists } from "../core/utils.js";

export interface CheckpointData {
  id: string;
  sessionId: string;
  node: string;
  step: number;
  createdAt: string;
  state: Record<string, unknown>;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointSaver {
  save(checkpoint: CheckpointData): Promise<void>;
  load(sessionId: string, checkpointId: string): Promise<CheckpointData | null>;
  latest(sessionId: string): Promise<CheckpointData | null>;
  list(sessionId: string): Promise<CheckpointData[]>;
  fork(sessionId: string, checkpointId: string, newSessionId: string): Promise<CheckpointData | null>;
}

export class FileCheckpointSaver implements CheckpointSaver {
  constructor(
    private readonly baseDir: string,
    private readonly localDirName: string = ".agent"
  ) {}

  private dir(sessionId: string): string {
    return path.join(this.baseDir, this.localDirName, "checkpoints", sessionId);
  }

  async save(checkpoint: CheckpointData): Promise<void> {
    const dir = this.dir(checkpoint.sessionId);
    await ensureDir(dir);
    const filePath = path.join(dir, `${checkpoint.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8");

    // Also write a "latest" pointer
    const latestPath = path.join(dir, "_latest.json");
    await fs.writeFile(latestPath, JSON.stringify({ checkpointId: checkpoint.id, step: checkpoint.step }), "utf8");
  }

  async load(sessionId: string, checkpointId: string): Promise<CheckpointData | null> {
    const filePath = path.join(this.dir(sessionId), `${checkpointId}.json`);
    if (!(await fileExists(filePath))) return null;
    return JSON.parse(await fs.readFile(filePath, "utf8")) as CheckpointData;
  }

  async latest(sessionId: string): Promise<CheckpointData | null> {
    const latestPath = path.join(this.dir(sessionId), "_latest.json");
    if (!(await fileExists(latestPath))) return null;
    const pointer = JSON.parse(await fs.readFile(latestPath, "utf8")) as { checkpointId: string };
    return this.load(sessionId, pointer.checkpointId);
  }

  async list(sessionId: string): Promise<CheckpointData[]> {
    const dir = this.dir(sessionId);
    if (!(await fileExists(dir))) return [];
    const files = await fs.readdir(dir);
    const checkpoints: CheckpointData[] = [];
    for (const file of files) {
      if (file === "_latest.json" || !file.endsWith(".json")) continue;
      const data = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as CheckpointData;
      checkpoints.push(data);
    }
    return checkpoints.sort((a, b) => a.step - b.step);
  }

  async fork(sessionId: string, checkpointId: string, newSessionId: string): Promise<CheckpointData | null> {
    const source = await this.load(sessionId, checkpointId);
    if (!source) return null;
    const forked: CheckpointData = {
      ...source,
      id: createId("chk"),
      sessionId: newSessionId,
      parentId: source.id,
      step: 0,
      createdAt: new Date().toISOString(),
      metadata: { ...source.metadata, forkedFrom: `${sessionId}/${checkpointId}` }
    };
    await this.save(forked);
    return forked;
  }
}

export function createCheckpoint(
  sessionId: string,
  node: string,
  step: number,
  state: Record<string, unknown>,
  parentId?: string
): CheckpointData {
  return {
    id: createId("chk"),
    sessionId,
    node,
    step,
    createdAt: new Date().toISOString(),
    state,
    parentId
  };
}
