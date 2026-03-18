/**
 * Plandex-inspired Diff Sandbox.
 *
 * All agent writes go to a staging area instead of directly to disk.
 * Changes can be reviewed, diffed, and either applied or reverted.
 * This prevents destructive writes and enables safe experimentation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { StagedChange } from "../core/types.js";
import { ensureDir, fileExists, nowIso } from "../core/utils.js";

export class DiffSandbox {
  private staged = new Map<string, StagedChange>();
  private applied = false;

  constructor(
    private readonly cwd: string,
    private readonly stagingDir: string
  ) {}

  /** Stage a file write without touching the real filesystem */
  async stageWrite(relativePath: string, content: string): Promise<StagedChange> {
    const absolutePath = path.resolve(this.cwd, relativePath);
    const relative = path.relative(this.cwd, absolutePath);
    if (relative.startsWith("..")) {
      throw new Error(`Path escapes workspace: ${relativePath}`);
    }

    let original: string | null = null;
    try {
      original = await fs.readFile(absolutePath, "utf8");
    } catch {
      // New file
    }

    const diff = original === null
      ? `+++ new file: ${relative}\n${content.split("\n").map((l) => `+ ${l}`).join("\n")}`
      : createUnifiedDiff(relative, original, content);

    const change: StagedChange = {
      path: relative,
      originalContent: original,
      stagedContent: content,
      diff,
      createdAt: nowIso()
    };

    this.staged.set(relative, change);

    // Write to staging directory
    const stagingPath = path.join(this.stagingDir, relative);
    await ensureDir(path.dirname(stagingPath));
    await fs.writeFile(stagingPath, content, "utf8");

    return change;
  }

  /** Get all staged changes */
  getStagedChanges(): StagedChange[] {
    return Array.from(this.staged.values());
  }

  /** Get a specific staged file's content */
  getStagedContent(relativePath: string): string | undefined {
    return this.staged.get(relativePath)?.stagedContent;
  }

  /** Read a file: staged version if it exists, otherwise real filesystem */
  async readFile(relativePath: string): Promise<string> {
    const staged = this.staged.get(relativePath);
    if (staged) return staged.stagedContent;
    return fs.readFile(path.resolve(this.cwd, relativePath), "utf8");
  }

  /** Get combined diff of all staged changes */
  getDiff(): string {
    return this.getStagedChanges().map((c) => c.diff).join("\n\n");
  }

  /** Check if any changes are staged */
  hasChanges(): boolean {
    return this.staged.size > 0;
  }

  /** Apply all staged changes to the real filesystem */
  async apply(): Promise<{ applied: number; paths: string[] }> {
    if (this.applied) {
      throw new Error("Sandbox changes already applied");
    }

    const paths: string[] = [];
    for (const [relative, change] of this.staged) {
      const target = path.resolve(this.cwd, relative);
      await ensureDir(path.dirname(target));
      await fs.writeFile(target, change.stagedContent, "utf8");
      paths.push(relative);
    }

    this.applied = true;
    return { applied: paths.length, paths };
  }

  /** Revert: clear staging without applying */
  async revert(): Promise<{ reverted: number }> {
    const count = this.staged.size;
    this.staged.clear();

    // Clean staging directory
    if (await fileExists(this.stagingDir)) {
      await fs.rm(this.stagingDir, { recursive: true, force: true });
    }

    this.applied = false;
    return { reverted: count };
  }

  /** Check if changes have been applied */
  isApplied(): boolean {
    return this.applied;
  }
}

function createUnifiedDiff(filePath: string, original: string, modified: string): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");

  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`
  ];

  // Simple line-by-line diff (not optimal but functional)
  const maxLen = Math.max(origLines.length, modLines.length);
  let chunkStart = -1;
  let chunkOrig: string[] = [];
  let chunkMod: string[] = [];

  const flushChunk = () => {
    if (chunkStart < 0) return;
    lines.push(`@@ -${chunkStart + 1},${chunkOrig.length} +${chunkStart + 1},${chunkMod.length} @@`);
    for (const l of chunkOrig) lines.push(`- ${l}`);
    for (const l of chunkMod) lines.push(`+ ${l}`);
    chunkStart = -1;
    chunkOrig = [];
    chunkMod = [];
  };

  for (let i = 0; i < maxLen; i++) {
    const orig = i < origLines.length ? origLines[i] : undefined;
    const mod = i < modLines.length ? modLines[i] : undefined;

    if (orig === mod) {
      flushChunk();
      continue;
    }

    if (chunkStart < 0) chunkStart = i;
    if (orig !== undefined) chunkOrig.push(orig);
    if (mod !== undefined) chunkMod.push(mod);
  }
  flushChunk();

  return lines.join("\n");
}
