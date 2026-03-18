/**
 * Code Simplifier — Post-process generated code.
 *
 * Inspired by oh-my-claudecode:
 * - After edits, check for common code smells
 * - Detect dead code, unused imports, empty blocks
 * - Suggest or auto-apply simplifications
 * - Run formatters if available
 */

export interface SimplifyResult {
  simplified: boolean;
  changes: SimplifyChange[];
  originalLines: number;
  simplifiedLines: number;
}

export interface SimplifyChange {
  type: "unused_import" | "empty_block" | "dead_code" | "console_log" | "todo_comment" | "duplicate_blank";
  line: number;
  description: string;
}

/**
 * Analyze code for simplification opportunities.
 */
export function analyzeForSimplification(code: string, language: string): SimplifyChange[] {
  const changes: SimplifyChange[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Empty blocks: {} with nothing inside
    if (trimmed === "{}" || trimmed === "{ }") {
      changes.push({ type: "empty_block", line: lineNum, description: "Empty block" });
    }

    // Console.log left in production code
    if (/\bconsole\.(log|debug|info)\b/.test(trimmed) && !trimmed.startsWith("//")) {
      changes.push({ type: "console_log", line: lineNum, description: "console.log in code" });
    }

    // TODO/FIXME/HACK comments
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(trimmed)) {
      changes.push({ type: "todo_comment", line: lineNum, description: trimmed.slice(0, 80) });
    }

    // Multiple consecutive blank lines (3+)
    if (trimmed === "" && i > 0 && i < lines.length - 1) {
      const prevBlank = lines[i - 1]?.trim() === "";
      const nextBlank = lines[i + 1]?.trim() === "";
      if (prevBlank && nextBlank) {
        changes.push({ type: "duplicate_blank", line: lineNum, description: "Triple blank line" });
      }
    }

    // TypeScript/JavaScript specific
    if (language === "typescript" || language === "javascript") {
      // Unused imports (basic heuristic: import X but X not used elsewhere)
      const importMatch = trimmed.match(/^import\s+(?:\{?\s*(\w+)\s*\}?|(\w+))\s+from/);
      if (importMatch) {
        const importedName = importMatch[1] ?? importMatch[2];
        if (importedName) {
          const restOfCode = lines.slice(i + 1).join("\n");
          const usageRegex = new RegExp(`\\b${importedName}\\b`);
          if (!usageRegex.test(restOfCode)) {
            changes.push({ type: "unused_import", line: lineNum, description: `Possibly unused: ${importedName}` });
          }
        }
      }
    }
  }

  return changes;
}

/**
 * Apply automatic simplifications to code.
 */
export function applySimplifications(code: string, changes: SimplifyChange[]): SimplifyResult {
  if (changes.length === 0) {
    return { simplified: false, changes: [], originalLines: code.split("\n").length, simplifiedLines: code.split("\n").length };
  }

  let lines = code.split("\n");
  const originalLines = lines.length;

  // Remove duplicate blank lines (safe auto-fix)
  const dupBlanks = new Set(changes.filter(c => c.type === "duplicate_blank").map(c => c.line - 1));
  if (dupBlanks.size > 0) {
    lines = lines.filter((_, i) => !dupBlanks.has(i));
  }

  const simplified = lines.join("\n");
  return {
    simplified: simplified !== code,
    changes,
    originalLines,
    simplifiedLines: lines.length
  };
}

/**
 * Detect the language from a file path.
 */
export function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    css: "css", html: "html", json: "json", md: "markdown", yaml: "yaml", yml: "yaml"
  };
  return map[ext] ?? "unknown";
}

/**
 * Build a simplification report for display.
 */
export function buildSimplificationReport(result: SimplifyResult): string {
  if (!result.simplified && result.changes.length === 0) return "";

  const lines = [`Code analysis: ${result.changes.length} issue(s) found`];
  for (const change of result.changes) {
    lines.push(`  L${change.line} [${change.type}] ${change.description}`);
  }
  if (result.simplified) {
    lines.push(`Simplified: ${result.originalLines} → ${result.simplifiedLines} lines`);
  }
  return lines.join("\n");
}
