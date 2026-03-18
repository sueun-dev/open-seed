/**
 * File Locking — prevent concurrent edits to the same file.
 * From bolt.diy: explicit lock mechanism for multi-agent scenarios.
 * Runs automatically. No setup needed.
 */

export class FileLockManager {
  private locks = new Map<string, { holder: string; acquiredAt: number }>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  acquire(path: string, holder: string): { acquired: boolean; heldBy?: string } {
    this.evictStale();
    const existing = this.locks.get(path);
    if (existing && existing.holder !== holder) {
      return { acquired: false, heldBy: existing.holder };
    }
    this.locks.set(path, { holder, acquiredAt: Date.now() });
    return { acquired: true };
  }

  release(path: string, holder: string): boolean {
    const lock = this.locks.get(path);
    if (lock?.holder === holder) {
      this.locks.delete(path);
      return true;
    }
    return false;
  }

  releaseAll(holder: string): number {
    let count = 0;
    for (const [path, lock] of this.locks) {
      if (lock.holder === holder) { this.locks.delete(path); count++; }
    }
    return count;
  }

  isLocked(path: string): boolean {
    this.evictStale();
    return this.locks.has(path);
  }

  getHolder(path: string): string | undefined {
    return this.locks.get(path)?.holder;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [path, lock] of this.locks) {
      if (now - lock.acquiredAt > this.timeoutMs) this.locks.delete(path);
    }
  }
}
