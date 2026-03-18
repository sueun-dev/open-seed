/**
 * Two-Phase Memory Pipeline (inspired by OpenAI Codex).
 *
 * Phase 1: Extract memories from individual session transcripts
 *   - Runs after each session ends
 *   - Extracts key learnings, patterns, errors, preferences
 *   - Stores per-session memory files
 *
 * Phase 2: Consolidate memories across sessions
 *   - Runs periodically or on demand
 *   - Merges, deduplicates, and ranks memories
 *   - Produces a consolidated memory file for injection into system prompts
 *
 * Storage: .agent/memory/
 *   sessions/  — per-session extracted memories (phase 1 output)
 *   consolidated.json — merged global memory (phase 2 output)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, fileExists } from "../core/utils.js";

export interface MemoryEntry {
  id: string;
  content: string;
  category: "pattern" | "error" | "preference" | "architecture" | "tooling" | "workflow";
  confidence: number; // 0-1
  source: string; // session ID or "consolidated"
  createdAt: string;
  lastSeenAt: string;
  occurrences: number;
}

export interface SessionMemory {
  sessionId: string;
  extractedAt: string;
  entries: MemoryEntry[];
}

export interface ConsolidatedMemory {
  version: 2;
  consolidatedAt: string;
  entries: MemoryEntry[];
  sessionCount: number;
}

// ─── Phase 1: Session Memory Extraction ──────────────────────────────────────

/**
 * Extract memories from a session's event log.
 * This is a local-only operation that doesn't require an LLM call.
 */
export async function extractSessionMemories(
  cwd: string,
  localDirName: string,
  sessionId: string,
  events: Array<{ type: string; payload: Record<string, unknown> }>
): Promise<SessionMemory> {
  const entries: MemoryEntry[] = [];
  const now = new Date().toISOString();

  // Extract patterns from tool usage
  const toolCounts = new Map<string, number>();
  const errorMessages: string[] = [];
  const filePatterns = new Map<string, number>();
  const commands: string[] = [];

  for (const event of events) {
    // Track tool usage patterns
    if (event.type === "tool.called" && event.payload.tool) {
      const tool = String(event.payload.tool);
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }

    // Track errors
    if (event.type === "tool.completed" && event.payload.ok === false && event.payload.error) {
      const error = String(event.payload.error).slice(0, 200);
      if (!errorMessages.includes(error)) {
        errorMessages.push(error);
      }
    }

    // Track file access patterns
    if (event.type === "tool.called" && (event.payload.tool === "read" || event.payload.tool === "write")) {
      const filePath = String(event.payload.path ?? "");
      if (filePath) {
        filePatterns.set(filePath, (filePatterns.get(filePath) ?? 0) + 1);
      }
    }

    // Track commands
    if (event.type === "tool.called" && event.payload.tool === "bash") {
      const cmd = String(event.payload.command ?? "").slice(0, 100);
      if (cmd && !commands.includes(cmd)) {
        commands.push(cmd);
      }
    }
  }

  // Generate memory entries from patterns
  const sortedTools = Array.from(toolCounts.entries())
    .sort(([, a], [, b]) => b - a);

  if (sortedTools.length > 0) {
    entries.push({
      id: `tool_usage_${sessionId}`,
      content: `Most used tools: ${sortedTools.slice(0, 5).map(([t, c]) => `${t}(${c})`).join(", ")}`,
      category: "tooling",
      confidence: 0.9,
      source: sessionId,
      createdAt: now,
      lastSeenAt: now,
      occurrences: 1
    });
  }

  for (const error of errorMessages.slice(0, 5)) {
    entries.push({
      id: `error_${sessionId}_${entries.length}`,
      content: error,
      category: "error",
      confidence: 0.8,
      source: sessionId,
      createdAt: now,
      lastSeenAt: now,
      occurrences: 1
    });
  }

  const hotFiles = Array.from(filePatterns.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (hotFiles.length > 0) {
    entries.push({
      id: `hot_files_${sessionId}`,
      content: `Frequently accessed files: ${hotFiles.map(([f, c]) => `${f}(${c})`).join(", ")}`,
      category: "architecture",
      confidence: 0.7,
      source: sessionId,
      createdAt: now,
      lastSeenAt: now,
      occurrences: 1
    });
  }

  // Build/test command patterns
  const buildCmds = commands.filter((c) => /\b(build|compile|tsc|webpack|vite)\b/i.test(c));
  const testCmds = commands.filter((c) => /\b(test|vitest|jest|pytest)\b/i.test(c));

  if (buildCmds.length > 0) {
    entries.push({
      id: `build_cmds_${sessionId}`,
      content: `Build commands: ${buildCmds.join("; ")}`,
      category: "workflow",
      confidence: 0.9,
      source: sessionId,
      createdAt: now,
      lastSeenAt: now,
      occurrences: 1
    });
  }

  if (testCmds.length > 0) {
    entries.push({
      id: `test_cmds_${sessionId}`,
      content: `Test commands: ${testCmds.join("; ")}`,
      category: "workflow",
      confidence: 0.9,
      source: sessionId,
      createdAt: now,
      lastSeenAt: now,
      occurrences: 1
    });
  }

  const sessionMemory: SessionMemory = {
    sessionId,
    extractedAt: now,
    entries
  };

  // Persist
  const memoryDir = path.join(cwd, localDirName, "memory", "sessions");
  await ensureDir(memoryDir);
  await fs.writeFile(
    path.join(memoryDir, `${sessionId}.json`),
    JSON.stringify(sessionMemory, null, 2),
    "utf8"
  );

  return sessionMemory;
}

// ─── Phase 2: Memory Consolidation ───────────────────────────────────────────

/**
 * Consolidate memories from all session extracts into a single ranked memory.
 */
export async function consolidateMemories(
  cwd: string,
  localDirName: string
): Promise<ConsolidatedMemory> {
  const sessionsDir = path.join(cwd, localDirName, "memory", "sessions");
  const consolidatedPath = path.join(cwd, localDirName, "memory", "consolidated.json");

  // Load all session memories
  const allEntries: MemoryEntry[] = [];
  let sessionCount = 0;

  try {
    const files = await fs.readdir(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          await fs.readFile(path.join(sessionsDir, file), "utf8")
        ) as SessionMemory;
        allEntries.push(...data.entries);
        sessionCount++;
      } catch {
        continue;
      }
    }
  } catch {
    // No sessions directory
  }

  // Merge entries by similarity
  const merged = mergeEntries(allEntries);

  // Sort by confidence * occurrences (most reliable + most seen = highest rank)
  merged.sort((a, b) => (b.confidence * b.occurrences) - (a.confidence * a.occurrences));

  // Keep top entries (context window budget)
  const MAX_ENTRIES = 50;
  const finalEntries = merged.slice(0, MAX_ENTRIES);

  const consolidated: ConsolidatedMemory = {
    version: 2,
    consolidatedAt: new Date().toISOString(),
    entries: finalEntries,
    sessionCount
  };

  await ensureDir(path.dirname(consolidatedPath));
  await fs.writeFile(consolidatedPath, JSON.stringify(consolidated, null, 2), "utf8");

  return consolidated;
}

/**
 * Load consolidated memory for injection into system prompts.
 * Returns empty string if no consolidated memory exists.
 */
export async function loadConsolidatedMemoryContext(
  cwd: string,
  localDirName: string,
  maxTokens = 2000
): Promise<string> {
  const consolidatedPath = path.join(cwd, localDirName, "memory", "consolidated.json");

  if (!await fileExists(consolidatedPath)) return "";

  try {
    const data = JSON.parse(
      await fs.readFile(consolidatedPath, "utf8")
    ) as ConsolidatedMemory;

    if (data.entries.length === 0) return "";

    const lines: string[] = ["# Agent Memory (consolidated from previous sessions)\n"];
    let charCount = lines[0].length;

    for (const entry of data.entries) {
      const line = `- [${entry.category}] ${entry.content} (seen ${entry.occurrences}x)`;
      if (charCount + line.length > maxTokens * 4) break; // Rough char-to-token estimate
      lines.push(line);
      charCount += line.length;
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function mergeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const byContent = new Map<string, MemoryEntry>();
  const now = new Date().toISOString();

  for (const entry of entries) {
    // Normalize content for comparison
    const key = normalizeContent(entry.content);
    const existing = byContent.get(key);

    if (existing) {
      existing.occurrences += entry.occurrences;
      existing.confidence = Math.max(existing.confidence, entry.confidence);
      existing.lastSeenAt = now;
    } else {
      byContent.set(key, { ...entry, lastSeenAt: now });
    }
  }

  return Array.from(byContent.values());
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(ses_[a-f0-9]+\)/g, "") // Remove session IDs
    .trim();
}
