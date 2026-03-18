/**
 * Context Caching — reduce API costs with prompt caching.
 * From Plandex: cache context across requests using Claude's cache_control.
 *
 * Strategy:
 * - Static context (repo map, config, AGENTS.md) → cached
 * - Dynamic context (task, results) → not cached
 * - Hash-based cache invalidation
 */

import crypto from "node:crypto";

export interface CacheEntry {
  hash: string;
  content: string;
  cachedAt: number;
  hitCount: number;
}

export class ContextCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 20, ttlMs = 600_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Get cached content or compute + cache it.
   */
  getOrCompute(key: string, compute: () => string): { content: string; cached: boolean } {
    this.evictExpired();
    const existing = this.cache.get(key);
    if (existing) {
      existing.hitCount++;
      return { content: existing.content, cached: true };
    }

    const content = compute();
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Check if same content exists under different key
    for (const [k, v] of this.cache) {
      if (v.hash === hash) {
        v.hitCount++;
        return { content: v.content, cached: true };
      }
    }

    this.cache.set(key, { hash, content, cachedAt: Date.now(), hitCount: 0 });
    this.evictLRU();
    return { content, cached: false };
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  getStats(): { entries: number; hits: number; totalSize: number } {
    let hits = 0, totalSize = 0;
    for (const entry of this.cache.values()) {
      hits += entry.hitCount;
      totalSize += entry.content.length;
    }
    return { entries: this.cache.size, hits, totalSize };
  }

  /**
   * Build cache_control headers for Anthropic API.
   * Mark cacheable content with ephemeral cache type.
   */
  getCacheControlHeaders(content: string): Record<string, unknown> | undefined {
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    for (const entry of this.cache.values()) {
      if (entry.hash === hash && entry.hitCount > 0) {
        return { cache_control: { type: "ephemeral" } };
      }
    }
    return undefined;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlMs) this.cache.delete(key);
    }
  }

  private evictLRU(): void {
    while (this.cache.size > this.maxEntries) {
      let minKey = "";
      let minHits = Infinity;
      for (const [key, entry] of this.cache) {
        if (entry.hitCount < minHits) { minKey = key; minHits = entry.hitCount; }
      }
      if (minKey) this.cache.delete(minKey);
      else break;
    }
  }
}

/**
 * Split context into cacheable (static) and dynamic parts.
 */
export function splitContext(fullContext: string): { staticPart: string; dynamicPart: string } {
  const sections = fullContext.split("\n\n");
  const staticSections: string[] = [];
  const dynamicSections: string[] = [];

  for (const section of sections) {
    // Static: repo structure, config, AGENTS.md, conventions
    if (/^#\s*(Repository|Codebase|Agent|Repo|Convention|Pattern|Memory)/i.test(section)) {
      staticSections.push(section);
    } else {
      dynamicSections.push(section);
    }
  }

  return {
    staticPart: staticSections.join("\n\n"),
    dynamicPart: dynamicSections.join("\n\n")
  };
}
