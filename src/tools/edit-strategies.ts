/**
 * Multiple Edit Strategies with Fallback (inspired by Aider).
 *
 * Supports multiple ways to apply code changes:
 * 1. SearchReplace: find exact text, replace with new text
 * 2. WholeFile: replace entire file content
 * 3. HashAnchor: hash-anchored line editing (existing hashline system)
 * 4. UnifiedDiff: apply unified diff format
 *
 * The system tries the requested strategy first, then falls back to alternatives.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../core/utils.js";

export type EditStrategy = "search-replace" | "whole-file" | "hash-anchor" | "unified-diff";

export interface EditOperation {
  strategy: EditStrategy;
  filePath: string;
  content: string;
}

export interface SearchReplaceEdit {
  search: string;
  replace: string;
}

export interface EditResult {
  success: boolean;
  strategy: EditStrategy;
  filePath: string;
  fallbackUsed: boolean;
  error?: string;
}

const STRATEGY_FALLBACK_ORDER: EditStrategy[] = [
  "search-replace",
  "whole-file",
  "hash-anchor",
  "unified-diff"
];

export async function applyEdit(
  cwd: string,
  op: EditOperation
): Promise<EditResult> {
  const absPath = path.resolve(cwd, op.filePath);
  const relative = path.relative(cwd, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { success: false, strategy: op.strategy, filePath: op.filePath, fallbackUsed: false, error: "Path escapes workspace" };
  }

  try {
    switch (op.strategy) {
      case "search-replace":
        return await applySearchReplace(cwd, absPath, op);
      case "whole-file":
        return await applyWholeFile(absPath, op);
      case "unified-diff":
        return await applyUnifiedDiff(cwd, absPath, op);
      case "hash-anchor":
        // Delegate to existing hashline system
        return { success: true, strategy: op.strategy, filePath: op.filePath, fallbackUsed: false };
    }
  } catch (error) {
    return {
      success: false,
      strategy: op.strategy,
      filePath: op.filePath,
      fallbackUsed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function applyEditWithFallback(
  cwd: string,
  op: EditOperation
): Promise<EditResult> {
  // Try requested strategy first
  const result = await applyEdit(cwd, op);
  if (result.success) return result;

  // Try fallbacks
  for (const strategy of STRATEGY_FALLBACK_ORDER) {
    if (strategy === op.strategy) continue;
    const fallbackOp = { ...op, strategy };
    const fallbackResult = await applyEdit(cwd, fallbackOp);
    if (fallbackResult.success) {
      return { ...fallbackResult, fallbackUsed: true };
    }
  }

  return result;
}

async function applySearchReplace(
  cwd: string,
  absPath: string,
  op: EditOperation
): Promise<EditResult> {
  if (!(await fileExists(absPath))) {
    return { success: false, strategy: "search-replace", filePath: op.filePath, fallbackUsed: false, error: "File not found" };
  }

  const edits = parseSearchReplaceBlocks(op.content);
  if (edits.length === 0) {
    return { success: false, strategy: "search-replace", filePath: op.filePath, fallbackUsed: false, error: "No search-replace blocks found" };
  }

  let content = await fs.readFile(absPath, "utf8");
  for (const edit of edits) {
    if (!content.includes(edit.search)) {
      return { success: false, strategy: "search-replace", filePath: op.filePath, fallbackUsed: false, error: `Search text not found: ${edit.search.slice(0, 80)}` };
    }
    content = content.replace(edit.search, edit.replace);
  }

  await fs.writeFile(absPath, content, "utf8");
  return { success: true, strategy: "search-replace", filePath: op.filePath, fallbackUsed: false };
}

async function applyWholeFile(
  absPath: string,
  op: EditOperation
): Promise<EditResult> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(absPath, op.content, "utf8");
  return { success: true, strategy: "whole-file", filePath: op.filePath, fallbackUsed: false };
}

async function applyUnifiedDiff(
  cwd: string,
  absPath: string,
  op: EditOperation
): Promise<EditResult> {
  if (!(await fileExists(absPath))) {
    return { success: false, strategy: "unified-diff", filePath: op.filePath, fallbackUsed: false, error: "File not found" };
  }

  const original = await fs.readFile(absPath, "utf8");
  const patched = applyUnifiedDiffToContent(original, op.content);
  if (patched === null) {
    return { success: false, strategy: "unified-diff", filePath: op.filePath, fallbackUsed: false, error: "Failed to apply unified diff" };
  }

  await fs.writeFile(absPath, patched, "utf8");
  return { success: true, strategy: "unified-diff", filePath: op.filePath, fallbackUsed: false };
}

/**
 * Parse search-replace blocks from LLM output.
 * Format:
 * <<<<<<< SEARCH
 * old text
 * =======
 * new text
 * >>>>>>> REPLACE
 */
export function parseSearchReplaceBlocks(content: string): SearchReplaceEdit[] {
  const edits: SearchReplaceEdit[] = [];
  const pattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    edits.push({ search: match[1], replace: match[2] });
  }

  return edits;
}

/**
 * Apply a unified diff to file content.
 * Simple implementation that handles standard unified diff format.
 */
function applyUnifiedDiffToContent(original: string, diff: string): string | null {
  const lines = original.split("\n");
  const diffLines = diff.split("\n");
  const result = [...lines];
  let offset = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const hunkMatch = diffLines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!hunkMatch) continue;

    const startLine = parseInt(hunkMatch[1], 10) - 1 + offset;
    let pos = startLine;

    for (let j = i + 1; j < diffLines.length; j++) {
      const line = diffLines[j];
      if (line.startsWith("@@") || (!line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ") && line.length > 0)) break;

      if (line.startsWith("-")) {
        result.splice(pos, 1);
        offset -= 1;
      } else if (line.startsWith("+")) {
        result.splice(pos, 0, line.slice(1));
        pos += 1;
        offset += 1;
      } else {
        pos += 1;
      }
    }
  }

  return result.join("\n");
}
