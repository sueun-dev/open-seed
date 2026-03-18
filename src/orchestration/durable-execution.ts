/**
 * Durable Execution — survive crashes and resume from last checkpoint.
 * From LangGraph: automatic persistence + resumption.
 *
 * If process dies, next run auto-detects incomplete session and resumes.
 * No data loss. No repeated work.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, nowIso } from "../core/utils.js";

export interface DurableCheckpoint {
  sessionId: string;
  phase: string;
  round: number;
  timestamp: string;
  /** Serialized engine state */
  state: Record<string, unknown>;
  /** Files modified so far */
  modifiedFiles: string[];
  /** Whether this checkpoint is resumable */
  resumable: boolean;
}

export async function saveDurableCheckpoint(
  cwd: string, localDirName: string, checkpoint: DurableCheckpoint
): Promise<void> {
  const dir = path.join(cwd, localDirName, "durable");
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "latest.json"), JSON.stringify(checkpoint, null, 2), "utf8");
  // Keep history
  await fs.writeFile(
    path.join(dir, `${checkpoint.sessionId}_r${checkpoint.round}.json`),
    JSON.stringify(checkpoint, null, 2), "utf8"
  );
}

export async function loadLatestCheckpoint(cwd: string, localDirName: string): Promise<DurableCheckpoint | null> {
  const fp = path.join(cwd, localDirName, "durable", "latest.json");
  if (!(await fileExists(fp))) return null;
  try {
    const data = JSON.parse(await fs.readFile(fp, "utf8")) as DurableCheckpoint;
    return data.resumable ? data : null;
  } catch { return null; }
}

export async function markCheckpointComplete(cwd: string, localDirName: string): Promise<void> {
  const fp = path.join(cwd, localDirName, "durable", "latest.json");
  if (!(await fileExists(fp))) return;
  try {
    const data = JSON.parse(await fs.readFile(fp, "utf8")) as DurableCheckpoint;
    data.resumable = false;
    data.phase = "completed";
    await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf8");
  } catch { /* ignore */ }
}

export function shouldAutoResume(checkpoint: DurableCheckpoint): boolean {
  if (!checkpoint.resumable) return false;
  // Only resume if checkpoint is less than 1 hour old
  const age = Date.now() - new Date(checkpoint.timestamp).getTime();
  return age < 3600_000;
}

export function buildResumeContext(checkpoint: DurableCheckpoint): string {
  return [
    "## Resuming from crash checkpoint",
    `Session: ${checkpoint.sessionId}`,
    `Phase: ${checkpoint.phase}`,
    `Round: ${checkpoint.round}`,
    `Modified files: ${checkpoint.modifiedFiles.join(", ") || "none"}`,
    "",
    "Continue from where you left off. Read modified files to verify their current state."
  ].join("\n");
}
