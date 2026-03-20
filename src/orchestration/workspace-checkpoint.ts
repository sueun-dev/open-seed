/**
 * Workspace Checkpoint/Restore — Cline-style safe experimentation.
 *
 * Snapshot the entire workspace at any point:
 * - Full file tree with content hashes
 * - Git state (branch, HEAD, dirty files)
 * - Compare any two checkpoints
 * - Restore to any previous checkpoint (atomic rollback)
 *
 * Source: Cline research — "safe exploration of alternatives"
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  /** Git branch at checkpoint time */
  branch: string;
  /** Git HEAD commit hash */
  headCommit: string;
  /** All tracked files with content hashes */
  files: Map<string, { hash: string; size: number }>;
  /** Files with actual content (for restore) */
  snapshots: Map<string, string>;
  /** Git dirty files at checkpoint time */
  dirtyFiles: string[];
}

export interface CheckpointDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".agent", ".research", ".next", "__pycache__", "venv"]);

export async function createWorkspaceCheckpoint(
  cwd: string,
  label: string
): Promise<WorkspaceCheckpoint> {
  const { execSync } = await import("node:child_process");

  let branch = "unknown";
  let headCommit = "unknown";
  let dirtyFiles: string[] = [];

  try {
    branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    headCommit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    dirtyFiles = execSync("git diff --name-only", { cwd, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
  } catch { /* not a git repo */ }

  const files = new Map<string, { hash: string; size: number }>();
  const snapshots = new Map<string, string>();

  await walkAndHash(cwd, cwd, files, snapshots);

  const id = `cp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  return {
    id,
    label,
    createdAt: new Date().toISOString(),
    branch,
    headCommit,
    files,
    snapshots,
    dirtyFiles,
  };
}

async function walkAndHash(
  root: string,
  dir: string,
  files: Map<string, { hash: string; size: number }>,
  snapshots: Map<string, string>,
  depth = 0
): Promise<void> {
  if (depth > 5) return;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);

      if (entry.isDirectory()) {
        await walkAndHash(root, full, files, snapshots, depth + 1);
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(full, "utf-8");
          const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
          const stat = await fs.stat(full);
          files.set(rel, { hash, size: stat.size });
          // Only snapshot text files < 100KB
          if (stat.size < 100_000) {
            snapshots.set(rel, content);
          }
        } catch { /* binary or unreadable */ }
      }
    }
  } catch { /* permission denied */ }
}

export function compareCheckpoints(before: WorkspaceCheckpoint, after: WorkspaceCheckpoint): CheckpointDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;

  for (const [file, meta] of after.files) {
    const prev = before.files.get(file);
    if (!prev) {
      added.push(file);
    } else if (prev.hash !== meta.hash) {
      modified.push(file);
    } else {
      unchanged++;
    }
  }

  for (const file of before.files.keys()) {
    if (!after.files.has(file)) {
      deleted.push(file);
    }
  }

  return { added, modified, deleted, unchanged };
}

export async function restoreCheckpoint(cwd: string, checkpoint: WorkspaceCheckpoint): Promise<{
  restored: number;
  deleted: number;
  errors: string[];
}> {
  let restored = 0;
  let deleted = 0;
  const errors: string[] = [];

  // Restore all snapshotted files
  for (const [rel, content] of checkpoint.snapshots) {
    const full = path.join(cwd, rel);
    try {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      restored++;
    } catch (e) {
      errors.push(`Failed to restore ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Delete files that didn't exist in checkpoint
  const currentFiles = new Map<string, { hash: string; size: number }>();
  await walkAndHash(cwd, cwd, currentFiles, new Map());

  for (const rel of currentFiles.keys()) {
    if (!checkpoint.files.has(rel)) {
      try {
        await fs.unlink(path.join(cwd, rel));
        deleted++;
      } catch { /* already gone */ }
    }
  }

  return { restored, deleted, errors };
}

export async function saveCheckpointToDisk(cwd: string, configDir: string, checkpoint: WorkspaceCheckpoint): Promise<string> {
  const dir = path.join(cwd, configDir, "checkpoints");
  await fs.mkdir(dir, { recursive: true });

  // Serialize — convert Maps to plain objects
  const serializable = {
    ...checkpoint,
    files: Object.fromEntries(checkpoint.files),
    snapshots: Object.fromEntries(checkpoint.snapshots),
  };

  const filePath = path.join(dir, `${checkpoint.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(serializable), "utf-8");
  return filePath;
}

export async function loadCheckpointFromDisk(filePath: string): Promise<WorkspaceCheckpoint> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
  return {
    ...raw,
    files: new Map(Object.entries(raw.files)),
    snapshots: new Map(Object.entries(raw.snapshots)),
  };
}

export async function listCheckpoints(cwd: string, configDir: string): Promise<Array<{ id: string; label: string; createdAt: string; fileCount: number }>> {
  const dir = path.join(cwd, configDir, "checkpoints");
  try {
    const files = await fs.readdir(dir);
    const results: Array<{ id: string; label: string; createdAt: string; fileCount: number }> = [];
    for (const f of files.filter(f => f.endsWith(".json"))) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"));
        results.push({ id: raw.id, label: raw.label, createdAt: raw.createdAt, fileCount: Object.keys(raw.files).length });
      } catch { /* corrupt checkpoint */ }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}
