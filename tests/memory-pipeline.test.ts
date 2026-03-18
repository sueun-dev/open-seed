import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractSessionMemories,
  consolidateMemories,
  loadConsolidatedMemoryContext
} from "../src/memory/memory-pipeline.js";

describe("Memory Pipeline", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-memory-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("Phase 1: extractSessionMemories", () => {
    it("extracts tool usage patterns", async () => {
      const events = [
        { type: "tool.called", payload: { tool: "read" } },
        { type: "tool.called", payload: { tool: "read" } },
        { type: "tool.called", payload: { tool: "write" } },
        { type: "tool.called", payload: { tool: "bash" } },
        { type: "tool.completed", payload: { tool: "read", ok: true } },
      ];

      const result = await extractSessionMemories(tmpDir, ".agent", "ses_123", events);
      expect(result.sessionId).toBe("ses_123");
      expect(result.entries.length).toBeGreaterThan(0);

      const toolEntry = result.entries.find((e) => e.category === "tooling");
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.content).toContain("read");
    });

    it("extracts error patterns", async () => {
      const events = [
        { type: "tool.completed", payload: { tool: "bash", ok: false, error: "ENOENT: file not found" } },
        { type: "tool.completed", payload: { tool: "write", ok: false, error: "Permission denied" } },
      ];

      const result = await extractSessionMemories(tmpDir, ".agent", "ses_456", events);
      const errors = result.entries.filter((e) => e.category === "error");
      expect(errors.length).toBe(2);
    });

    it("persists session memory to disk", async () => {
      const events = [
        { type: "tool.called", payload: { tool: "read" } },
      ];

      await extractSessionMemories(tmpDir, ".agent", "ses_persist", events);

      const memPath = path.join(tmpDir, ".agent", "memory", "sessions", "ses_persist.json");
      const exists = await fs.access(memPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe("Phase 2: consolidateMemories", () => {
    it("merges memories from multiple sessions", async () => {
      // Create two session memories
      const sessionsDir = path.join(tmpDir, ".agent", "memory", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });

      await fs.writeFile(path.join(sessionsDir, "s1.json"), JSON.stringify({
        sessionId: "s1",
        extractedAt: "2026-01-01",
        entries: [{
          id: "e1", content: "Most used tools: read(5), write(3)",
          category: "tooling", confidence: 0.9, source: "s1",
          createdAt: "2026-01-01", lastSeenAt: "2026-01-01", occurrences: 1
        }]
      }));

      await fs.writeFile(path.join(sessionsDir, "s2.json"), JSON.stringify({
        sessionId: "s2",
        extractedAt: "2026-01-02",
        entries: [{
          id: "e2", content: "Most used tools: read(5), write(3)",
          category: "tooling", confidence: 0.9, source: "s2",
          createdAt: "2026-01-02", lastSeenAt: "2026-01-02", occurrences: 1
        }]
      }));

      const result = await consolidateMemories(tmpDir, ".agent");
      expect(result.sessionCount).toBe(2);
      // Identical entries should be merged
      const toolEntries = result.entries.filter((e) => e.category === "tooling");
      expect(toolEntries).toHaveLength(1);
      expect(toolEntries[0].occurrences).toBe(2);
    });
  });

  describe("loadConsolidatedMemoryContext", () => {
    it("returns empty string when no consolidated memory", async () => {
      const result = await loadConsolidatedMemoryContext(tmpDir, ".agent");
      expect(result).toBe("");
    });

    it("returns formatted context from consolidated memory", async () => {
      const memDir = path.join(tmpDir, ".agent", "memory");
      await fs.mkdir(memDir, { recursive: true });

      await fs.writeFile(path.join(memDir, "consolidated.json"), JSON.stringify({
        version: 2,
        consolidatedAt: "2026-01-01",
        entries: [
          { id: "e1", content: "Build command: npm run build", category: "workflow", confidence: 0.9, source: "consolidated", createdAt: "2026-01-01", lastSeenAt: "2026-01-01", occurrences: 5 },
          { id: "e2", content: "Test command: npm test", category: "workflow", confidence: 0.9, source: "consolidated", createdAt: "2026-01-01", lastSeenAt: "2026-01-01", occurrences: 3 },
        ],
        sessionCount: 10
      }));

      const result = await loadConsolidatedMemoryContext(tmpDir, ".agent");
      expect(result).toContain("Agent Memory");
      expect(result).toContain("npm run build");
      expect(result).toContain("npm test");
    });
  });
});
