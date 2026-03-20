/**
 * Live Error Monitor — Cline-style proactive error detection.
 *
 * Watches for linter/compiler errors AS files are edited:
 * - After every file write, run tsc/eslint on changed files
 * - Parse errors immediately
 * - Feed back to agent for proactive fixing
 * - Prevents error accumulation
 *
 * Source: Cline research — "Live error detection as it edits files"
 */

export interface LiveError {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source: "typescript" | "eslint" | "build";
  code?: string;
}

export interface LiveErrorReport {
  errors: LiveError[];
  warnings: LiveError[];
  totalErrors: number;
  totalWarnings: number;
  cleanFiles: string[];
}

/**
 * Run live error check on specific files (not whole project).
 * Called after every file write for immediate feedback.
 */
export async function checkFilesForErrors(
  cwd: string,
  changedFiles: string[]
): Promise<LiveErrorReport> {
  const errors: LiveError[] = [];
  const warnings: LiveError[] = [];
  const cleanFiles: string[] = [];

  const tsFiles = changedFiles.filter(f => /\.(ts|tsx)$/.test(f));
  const jsFiles = changedFiles.filter(f => /\.(js|jsx)$/.test(f));
  const allCheckable = [...tsFiles, ...jsFiles];

  if (allCheckable.length === 0) {
    return { errors: [], warnings: [], totalErrors: 0, totalWarnings: 0, cleanFiles: changedFiles };
  }

  const { execSync } = await import("node:child_process");

  // TypeScript check
  if (tsFiles.length > 0) {
    try {
      execSync("npx tsc --noEmit 2>&1", { cwd, encoding: "utf-8", timeout: 30000 });
      cleanFiles.push(...tsFiles);
    } catch (e: unknown) {
      const output = (e as { stdout?: string; stderr?: string }).stdout ?? (e as { stderr?: string }).stderr ?? "";
      const parsed = parseTscErrors(output, changedFiles);
      errors.push(...parsed.filter(e => e.severity === "error"));
      warnings.push(...parsed.filter(e => e.severity === "warning"));
      for (const f of tsFiles) {
        if (!parsed.some(p => p.file === f)) cleanFiles.push(f);
      }
    }
  }

  // ESLint check (if available)
  try {
    const eslintFiles = allCheckable.join(" ");
    execSync(`npx eslint ${eslintFiles} --format json 2>/dev/null`, { cwd, encoding: "utf-8", timeout: 15000 });
    // If no error, files are clean (already added to cleanFiles above)
  } catch (e: unknown) {
    const output = (e as { stdout?: string }).stdout ?? "";
    try {
      const results = JSON.parse(output) as Array<{
        filePath: string;
        messages: Array<{ line: number; column: number; severity: number; message: string; ruleId: string | null }>;
      }>;
      for (const result of results) {
        const rel = result.filePath.replace(cwd + "/", "");
        for (const msg of result.messages) {
          const entry: LiveError = {
            file: rel,
            line: msg.line,
            column: msg.column,
            severity: msg.severity === 2 ? "error" : "warning",
            message: msg.message,
            source: "eslint",
            code: msg.ruleId ?? undefined,
          };
          if (entry.severity === "error") errors.push(entry);
          else warnings.push(entry);
        }
      }
    } catch { /* eslint output not parseable — skip */ }
  }

  return {
    errors,
    warnings,
    totalErrors: errors.length,
    totalWarnings: warnings.length,
    cleanFiles
  };
}

function parseTscErrors(output: string, relevantFiles: string[]): LiveError[] {
  const results: LiveError[] = [];
  const linePattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;

  let match;
  while ((match = linePattern.exec(output)) !== null) {
    const file = match[1];
    // Only include errors from our changed files (not transitive)
    const isRelevant = relevantFiles.length === 0 || relevantFiles.some(f => file.includes(f));
    if (isRelevant) {
      results.push({
        file,
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4] as "error" | "warning",
        message: match[6],
        source: "typescript",
        code: match[5],
      });
    }
  }

  return results;
}

/**
 * Format errors for injection into LLM prompt.
 */
export function formatErrorsForPrompt(report: LiveErrorReport): string {
  if (report.totalErrors === 0 && report.totalWarnings === 0) return "";

  const lines = ["## ⚠️ Live Error Detection — Issues Found After Your Edit"];

  if (report.errors.length > 0) {
    lines.push(`\n### Errors (${report.errors.length}) — MUST FIX:`);
    for (const e of report.errors.slice(0, 10)) {
      lines.push(`- \`${e.file}:${e.line}:${e.column}\` [${e.source}${e.code ? ` ${e.code}` : ""}] ${e.message}`);
    }
    if (report.errors.length > 10) lines.push(`  ... and ${report.errors.length - 10} more`);
  }

  if (report.warnings.length > 0) {
    lines.push(`\n### Warnings (${report.warnings.length}):`);
    for (const w of report.warnings.slice(0, 5)) {
      lines.push(`- \`${w.file}:${w.line}:${w.column}\` [${w.source}] ${w.message}`);
    }
  }

  lines.push("\nFix these errors before continuing. Read the affected files first.");
  return lines.join("\n");
}
