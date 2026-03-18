/**
 * Undo / Rollback System (Codex-inspired).
 *
 * Tracks every file mutation as a turn. Each turn captures:
 * - What files were changed
 * - Their content before the change
 * - What tool call made the change
 *
 * Can rollback to any previous turn, restoring files to their exact state.
 * Works alongside git (creates stash-like snapshots independent of git history).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists, createId, nowIso } from "../core/utils.js";

export interface FileMutation {
  path: string;
  /** Content before the change, null if file was created */
  beforeContent: string | null;
  /** Content after the change, null if file was deleted */
  afterContent: string | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  /** Sequential turn number */
  turnNumber: number;
  /** What caused this turn */
  source: string;
  /** Tool call that made the change */
  toolName?: string;
  /** Files changed in this turn */
  mutations: FileMutation[];
  createdAt: string;
}

export interface UndoResult {
  turnId: string;
  turnNumber: number;
  filesRestored: string[];
  filesDeleted: string[];
}

export class UndoManager {
  private turns: Turn[] = [];
  private currentTurn: number = 0;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly storageDir: string
  ) {}

  /** Capture a file's state before mutation for undo tracking */
  async captureBeforeMutation(relativePath: string): Promise<string | null> {
    const absPath = path.resolve(this.cwd, relativePath);
    try {
      return await fs.readFile(absPath, "utf8");
    } catch {
      return null; // File doesn't exist yet
    }
  }

  /** Record a completed mutation (call after the write is done) */
  async recordMutation(
    source: string,
    mutations: FileMutation[],
    toolName?: string
  ): Promise<Turn> {
    const turn: Turn = {
      id: createId("turn"),
      sessionId: this.sessionId,
      turnNumber: ++this.currentTurn,
      source,
      toolName,
      mutations,
      createdAt: nowIso()
    };

    // Trim any future turns if we've undone and then made new changes
    this.turns = this.turns.filter((t) => t.turnNumber < turn.turnNumber);
    this.turns.push(turn);

    // Persist turn to disk
    await this.saveTurn(turn);

    return turn;
  }

  /** Undo the last turn — restore files to their state before it */
  async undo(): Promise<UndoResult | null> {
    if (this.turns.length === 0) return null;

    const turn = this.turns[this.turns.length - 1];
    const filesRestored: string[] = [];
    const filesDeleted: string[] = [];

    for (const mutation of turn.mutations) {
      const absPath = path.resolve(this.cwd, mutation.path);

      if (mutation.beforeContent === null) {
        // File was created — delete it
        try {
          await fs.unlink(absPath);
          filesDeleted.push(mutation.path);
        } catch {
          // File may already be gone
        }
      } else {
        // Restore previous content
        await ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, mutation.beforeContent, "utf8");
        filesRestored.push(mutation.path);
      }
    }

    this.turns.pop();
    this.currentTurn = this.turns.length > 0 ? this.turns[this.turns.length - 1].turnNumber : 0;

    return {
      turnId: turn.id,
      turnNumber: turn.turnNumber,
      filesRestored,
      filesDeleted
    };
  }

  /** Rollback to a specific turn number — undo all turns after it */
  async rollbackTo(turnNumber: number): Promise<UndoResult[]> {
    const results: UndoResult[] = [];

    while (this.currentTurn > turnNumber && this.turns.length > 0) {
      const result = await this.undo();
      if (result) results.push(result);
      else break;
    }

    return results;
  }

  /** Get list of all turns */
  getTurns(): Turn[] {
    return [...this.turns];
  }

  /** Get current turn number */
  getCurrentTurn(): number {
    return this.currentTurn;
  }

  /** Check if undo is possible */
  canUndo(): boolean {
    return this.turns.length > 0;
  }

  /** Load turns from disk for session recovery */
  async loadFromDisk(): Promise<void> {
    const dir = path.join(this.storageDir, "turns", this.sessionId);
    if (!(await fileExists(dir))) return;

    const files = await fs.readdir(dir);
    const turns: Turn[] = [];

    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      const content = await fs.readFile(path.join(dir, file), "utf8");
      turns.push(JSON.parse(content) as Turn);
    }

    this.turns = turns.sort((a, b) => a.turnNumber - b.turnNumber);
    this.currentTurn = turns.length > 0 ? turns[turns.length - 1].turnNumber : 0;
  }

  private async saveTurn(turn: Turn): Promise<void> {
    const dir = path.join(this.storageDir, "turns", this.sessionId);
    await ensureDir(dir);
    const filePath = path.join(dir, `${String(turn.turnNumber).padStart(4, "0")}_${turn.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(turn, null, 2), "utf8");
  }
}
